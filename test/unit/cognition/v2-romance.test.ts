import { describe, expect, it } from 'vitest';
import { at } from '../../../src/shared/time.ts';
import type { Conversation, Romance, VillageEvent, VillagerProfile } from '../../../src/shared/types.ts';
import { createConversationRunner } from '../../../src/server/cognition/conversation.ts';
import { LAG_OVERLOADED, loadTracker } from '../../../src/server/cognition/llm.ts';
import type { Mind } from '../../../src/server/cognition/mind.ts';
import { RomanceAgent, romanceId } from '../../../src/server/cognition/romance.ts';
import { createTestVillage, PROFILES, testConfig, V2_LOCATIONS, type TestVillage } from './helpers.ts';

function person(id: string, name: string, occupation: string): VillagerProfile {
  return {
    id,
    name,
    age: 40,
    occupation,
    bio: `${name} lives on the post row.`,
    traits: ['shy'],
    homeId: `house_${id}`,
    sprite: `characters/${id}.png`,
    wakeTime: '06:00',
    sleepTime: '23:00',
  };
}
const LAUDE = person('laude', 'Laude', 'Postmaster');
const FRANZI = person('franzi', 'Franzi', 'Illustrator (draws postcards)');

const romance = (a: string, b: string, extra: Partial<Romance> = {}): Romance => ({
  id: romanceId(a, b),
  pair: [a, b].sort() as [string, string],
  stage: 'crush',
  since: 0,
  crushFrom: [a],
  dates: [],
  updatedAt: 0,
  ...extra,
});

function setAffinity(v: TestVillage, from: string, to: string, affinity: number): void {
  v.worlds.get(from)!.relationships[to] = { affinity };
}

function mutual(v: TestVillage, a: string, b: string, affinity: number): void {
  setAffinity(v, a, b, affinity);
  setAffinity(v, b, a, affinity);
}

function talked(m: Mind, name: string, n: number, t: number): void {
  for (let i = 0; i < n; i++)
    m.addMemory({
      kind: 'conversation',
      at: t - i * 60,
      text: `Talked with ${name}: we chatted about the weather.`,
      meta: { conversationId: `c-${m.id}-${name}-${i}` },
    });
}

function forceRandom(m: Mind, value: number): void {
  (m.deps as { random: () => number }).random = () => value;
}

function runner(v: TestVillage) {
  return createConversationRunner({
    config: testConfig(),
    queue: v.queue,
    now: () => v.time.now,
    emit: () => {},
  });
}

const conv = (a: string, b: string, t: number, locationId = 'plaza'): Conversation => ({
  id: `conv-${a}-${b}-${t}`,
  participants: [a, b],
  locationId,
  startedAt: t,
  messages: [],
  status: 'active',
});

describe('nightly crushes (v2 §7)', () => {
  it('forms a crush at 02:00 for affinity 6+ and two talks in three days', async () => {
    const v = createTestVillage({ start: at(1, '01:50'), locations: V2_LOCATIONS });
    mutual(v, 'mia', 'ben', 7);
    const mia = v.minds.get('mia')!;
    talked(mia, 'Ben', 2, at(0, '15:00'));
    forceRandom(mia, 0);
    for (const id of ['ben', 'cleo', 'dan']) forceRandom(v.minds.get(id)!, 0.99);
    await v.advanceTo(at(1, '02:05'));
    const r = mia.town.romances.get(romanceId('mia', 'ben'))!;
    expect(r).toMatchObject({ stage: 'crush', crushFrom: ['mia'], pair: ['ben', 'mia'] });
    const mem = mia.memory.all().find((m) => m.text === 'I think I have a crush on Ben.')!;
    expect(mem.importance).toBe(7);
    expect(mia.romances()).toHaveLength(1);
  });

  it('needs the talks, the affinity and the 30% roll', async () => {
    const v = createTestVillage({ start: at(1, '01:50'), locations: V2_LOCATIONS });
    mutual(v, 'mia', 'ben', 7);
    mutual(v, 'cleo', 'dan', 5);
    const [mia, ben, cleo] = (['mia', 'ben', 'cleo'] as const).map((id) => v.minds.get(id)!) as [
      Mind,
      Mind,
      Mind,
    ];
    talked(mia, 'Ben', 1, at(0, '15:00'));
    talked(ben, 'Mia', 3, at(1, '00:30'));
    talked(cleo, 'Dan', 3, at(0, '15:00'));
    forceRandom(mia, 0);
    forceRandom(ben, 0.5);
    forceRandom(cleo, 0);
    forceRandom(v.minds.get('dan')!, 0);
    await v.advanceTo(at(1, '02:05'));
    expect(mia.town.romances.of('mia')).toHaveLength(0);
    expect(mia.town.romances.of('cleo')).toHaveLength(0);
  });
  it('never forms a crush on someone who is dating or partnered with another villager', async () => {
    for (const stage of ['dating', 'couple'] as const) {
      const v = createTestVillage({ start: at(1, '01:50'), locations: V2_LOCATIONS });
      mutual(v, 'mia', 'ben', 7);
      const mia = v.minds.get('mia')!;
      talked(mia, 'Ben', 2, at(0, '15:00'));
      mia.town.romances.put(romance('ben', 'cleo', { stage, crushFrom: ['ben', 'cleo'] }));
      for (const id of ['mia', 'ben', 'cleo', 'dan']) forceRandom(v.minds.get(id)!, 0);
      await v.advanceTo(at(1, '02:05'));
      expect(mia.town.romances.of('mia'), stage).toHaveLength(0);
    }
  });
});

describe('the crush guarantee (v2 §7, AC15)', () => {
  const hasCrush = (m: Mind, name = 'Ben') =>
    m.memory.all().some((x) => x.text === `I think I have a crush on ${name}.`);

  function village(night: number, snapshots?: Parameters<typeof createTestVillage>[0]['snapshots']) {
    const v = createTestVillage({
      start: at(night, '01:50'),
      locations: V2_LOCATIONS,
      ...(snapshots ? { snapshots } : {}),
    });
    mutual(v, 'mia', 'ben', 7);
    for (const id of ['ben', 'cleo', 'dan']) forceRandom(v.minds.get(id)!, 0.99);
    return v;
  }

  /** Runs the 02:00 draw of `night`; the clock jumps there from the previous one. */
  async function draw(v: TestVillage, night: number): Promise<boolean> {
    if (v.time.now < at(night, '01:50')) v.time.now = at(night, '01:50');
    await v.advanceTo(at(night, '02:05'));
    return hasCrush(v.minds.get('mia')!);
  }

  it('nights 1 and 2 use the 0.3 draw: below it is a crush, at or above it is not', async () => {
    for (const [value, crush] of [
      [0.29, true],
      [0.3, false],
      [0.99, false],
    ] as const) {
      const v = village(1);
      const mia = v.minds.get('mia')!;
      talked(mia, 'Ben', 2, at(0, '15:00'));
      forceRandom(mia, value);
      expect(await draw(v, 1), `night 1 at ${value}`).toBe(crush);
      if (crush) continue;
      expect(await draw(v, 2), `night 2 at ${value}`).toBe(false);
    }
  });

  it('is certain on the 3rd eligible night in a row, whatever the draw', async () => {
    const v = village(1);
    const mia = v.minds.get('mia')!;
    talked(mia, 'Ben', 2, at(0, '15:00'));
    forceRandom(mia, 0.99);
    expect(await draw(v, 1)).toBe(false);
    expect(await draw(v, 2)).toBe(false);
    expect(await draw(v, 3)).toBe(true);
    expect(mia.town.romances.get(romanceId('mia', 'ben'))).toMatchObject({
      stage: 'crush',
      crushFrom: ['mia'],
    });
  });

  it('goes to the best-affinity candidate on the guaranteed night', async () => {
    const v = village(1);
    mutual(v, 'mia', 'cleo', 8);
    const mia = v.minds.get('mia')!;
    talked(mia, 'Ben', 2, at(0, '15:00'));
    talked(mia, 'Cleo', 2, at(0, '18:00'));
    forceRandom(mia, 0.99);
    for (let night = 1; night <= 3; night++) await draw(v, night);
    expect(hasCrush(mia, 'Cleo')).toBe(true);
    expect(hasCrush(mia, 'Ben')).toBe(false);
  });

  it('never fires while the conditions do not hold (one talk), even with a winning draw', async () => {
    const v = village(1);
    const mia = v.minds.get('mia')!;
    talked(mia, 'Ben', 1, at(0, '15:00'));
    forceRandom(mia, 0);
    for (let night = 1; night <= 4; night++) expect(await draw(v, night), `night ${night}`).toBe(false);
  });

  it('an ineligible night resets the count, so the 3rd night is a plain draw again', async () => {
    const v = village(1);
    const mia = v.minds.get('mia')!;
    talked(mia, 'Ben', 2, at(0, '15:00'));
    forceRandom(mia, 0.99);
    expect(await draw(v, 1)).toBe(false);
    mutual(v, 'mia', 'ben', 5);
    expect(await draw(v, 2)).toBe(false);
    mutual(v, 'mia', 'ben', 7);
    // Talks are counted over 3 days: keep two in the window for the later nights.
    talked(mia, 'Ben', 2, at(2, '15:00'));
    expect(await draw(v, 3)).toBe(false);
    expect(await draw(v, 4)).toBe(false);
    expect(await draw(v, 5)).toBe(true);
  });

  it('a night without a draw breaks the run too', async () => {
    const v = village(1);
    const mia = v.minds.get('mia')!;
    talked(mia, 'Ben', 2, at(0, '15:00'));
    forceRandom(mia, 0.99);
    expect(await draw(v, 1)).toBe(false);
    // Night 2 is skipped (the clock jumps from night 1 to night 3).
    expect(await draw(v, 3)).toBe(false);
    expect(mia.serialize().romance).toEqual({ crushStreak: 1, crushStreakNight: 3 });
  });

  it('the count is saved with the mind state and survives a restore', async () => {
    const v = village(1);
    const mia = v.minds.get('mia')!;
    talked(mia, 'Ben', 2, at(0, '15:00'));
    forceRandom(mia, 0.99);
    expect(await draw(v, 1)).toBe(false);
    expect(await draw(v, 2)).toBe(false);
    const saved = JSON.parse(
      JSON.stringify(Object.fromEntries([...v.minds].map(([id, m]) => [id, m.serialize()]))),
    );
    expect(saved.mia.romance).toEqual({ crushStreak: 2, crushStreakNight: 2 });

    const restored = village(3, saved);
    forceRandom(restored.minds.get('mia')!, 0.99);
    expect(await draw(restored, 3)).toBe(true);

    // Without the count (a save from before the guarantee) night 3 is a plain draw.
    const old = structuredClone(saved);
    delete old.mia.romance;
    const fresh = village(3, old);
    forceRandom(fresh.minds.get('mia')!, 0.99);
    expect(await draw(fresh, 3)).toBe(false);
  });
});
describe('dates (v2 §7)', () => {
  it('asks after a chat with a crush; the partner accepts and a 90-minute date is scheduled', async () => {
    const v = createTestVillage({ start: at(1, '10:00'), locations: V2_LOCATIONS });
    mutual(v, 'mia', 'ben', 7);
    await v.advanceTo(at(1, '10:01'));
    const mia = v.minds.get('mia')!;
    mia.town.romances.put(romance('mia', 'ben'));
    const c = conv('mia', 'ben', v.time.now);
    await runner(v).run(c, [mia, v.minds.get('ben')!]);
    await v.queue.drain();
    const ask = v.queue.requests.find((r) => r.task === 'date.ask')!;
    expect(ask.meta).toMatchObject({ villagerId: 'mia', partnerId: 'ben' });
    expect(v.queue.requests.find((r) => r.task === 'date.decide')!.meta).toMatchObject({
      villagerId: 'ben',
      askerId: 'mia',
    });
    const e = v.events.find((x) => x.kind === 'date')!;
    expect(e).toMatchObject({ hostId: 'mia', invitees: ['ben'], accepted: ['ben'], status: 'scheduled' });
    expect(e.start).toBe(at(1, '17:00'));
    expect(e.end - e.start).toBe(90);
    const r = mia.town.romances.get(romanceId('mia', 'ben'))!;
    expect(r.stage).toBe('dating');
    expect(r.dates).toEqual([
      expect.objectContaining({
        eventId: e.id,
        locationId: e.locationId,
        askedBy: 'mia',
        status: 'planned',
        source: 'llm',
      }),
    ]);

    // Only once a day, and not with a date already coming up.
    await runner(v).run(conv('mia', 'ben', v.time.now + 1), [mia, v.minds.get('ben')!]);
    await v.queue.drain();
    expect(v.queue.count('date.ask')).toBe(1);
  });

  it('a partner below affinity 4 declines (fallback rule in the mock) and no date is made', async () => {
    const v = createTestVillage({ start: at(1, '10:00'), locations: V2_LOCATIONS });
    setAffinity(v, 'mia', 'ben', 7);
    setAffinity(v, 'ben', 'mia', 2);
    await v.advanceTo(at(1, '10:01'));
    const mia = v.minds.get('mia')!;
    mia.town.romances.put(romance('mia', 'ben'));
    await runner(v).run(conv('mia', 'ben', v.time.now), [mia, v.minds.get('ben')!]);
    await v.queue.drain();
    expect(v.events.some((e) => e.kind === 'date')).toBe(false);
    expect(mia.town.romances.get(romanceId('mia', 'ben'))!.dates[0]!.status).toBe('declined');
    expect(mia.memory.all().some((m) => m.text.includes('they said no'))).toBe(true);
  });

  it('a date both attend raises affinity by 2 for both; a missed one costs the waiter 1', async () => {
    const v = createTestVillage({ start: at(1, '16:00'), locations: V2_LOCATIONS });
    mutual(v, 'mia', 'ben', 6);
    await v.advanceTo(at(1, '16:01'));
    const mia = v.minds.get('mia')!;
    const date = (id: string, start: number, attendees: string[]): VillageEvent => ({
      id,
      title: 'Date at the Park',
      description: '',
      hostId: 'mia',
      locationId: 'park',
      start,
      end: start + 90,
      invitees: ['ben'],
      accepted: ['ben'],
      declined: [],
      attendees,
      status: 'done',
      source: 'llm',
      kind: 'date',
    });
    mia.town.romances.put(
      romance('mia', 'ben', {
        stage: 'dating',
        dates: ['d1', 'd2'].map((eventId) => ({
          eventId,
          locationId: 'park',
          at: at(1, '10:00'),
          askedBy: 'mia',
          status: 'planned' as const,
          source: 'llm' as const,
        })),
      }),
    );
    v.events.push(date('d1', at(1, '10:00'), ['mia', 'ben']));
    await v.advanceTo(at(1, '16:03'));
    expect(v.worlds.get('mia')!.relationships.ben!.affinity).toBe(8);
    expect(v.worlds.get('ben')!.relationships.mia!.affinity).toBe(8);
    expect(mia.memory.all().find((m) => m.text.startsWith('I had a lovely date with Ben'))!.importance).toBe(
      7,
    );
    // Attended dates are not also written as generic "I attended" event memories.
    expect(mia.memory.all().some((m) => m.text.startsWith('I attended Date'))).toBe(false);

    v.events.push(date('d2', at(1, '12:00'), ['mia']));
    await v.advanceTo(at(1, '16:05'));
    expect(v.worlds.get('mia')!.relationships.ben!.affinity).toBe(7);
    expect(v.worlds.get('ben')!.relationships.mia!.affinity).toBe(8);
    const r = mia.town.romances.get(romanceId('mia', 'ben'))!;
    expect(r.dates.map((d) => d.status)).toEqual(['done', 'missed']);
  });

  it('villagers within 8 tiles see a date in progress', async () => {
    const v = createTestVillage({ start: at(1, '17:00'), locations: V2_LOCATIONS });
    v.events.push({
      id: 'd1',
      title: 'Date at the Park',
      description: '',
      hostId: 'mia',
      locationId: 'park',
      start: at(1, '17:00'),
      end: at(1, '18:30'),
      invitees: ['ben'],
      accepted: ['ben'],
      declined: [],
      attendees: ['mia', 'ben'],
      status: 'happening',
      source: 'llm',
      kind: 'date',
    });
    const park = V2_LOCATIONS.find((l) => l.id === 'park')!;
    for (const id of ['mia', 'ben']) {
      const s = v.states.get(id)!;
      s.locationId = 'park';
      s.pos = { ...park.entry };
    }
    v.states.get('cleo')!.pos = { x: park.area.x - 5, y: park.area.y };
    v.states.get('dan')!.pos = { x: park.area.x - 20, y: park.area.y };
    v.minds.get('mia')!.update(v.view('mia'));
    v.minds.get('ben')!.update(v.view('ben'));
    v.minds.get('cleo')!.update(v.view('cleo'));
    v.minds.get('dan')!.update(v.view('dan'));
    const seen = (id: string) =>
      v.minds
        .get(id)!
        .memory.all()
        .find((m) => m.text === 'I saw Mia and Ben on a date at the Park.');
    expect(seen('cleo')?.importance).toBe(6);
    expect(seen('dan')).toBeUndefined();
  });
});

describe('declining without a model call', () => {
  it('turns down a date that overlaps one already planned, or when already dating someone else', async () => {
    const v = createTestVillage({ start: at(1, '10:00'), locations: V2_LOCATIONS });
    mutual(v, 'ben', 'mia', 9);
    mutual(v, 'ben', 'cleo', 9);
    await v.advanceTo(at(1, '10:01'));
    const ben = v.minds.get('ben')!;
    const park = V2_LOCATIONS.find((l) => l.id === 'park')!;
    v.events.push({
      id: 'd-cleo',
      title: 'Date at the Park',
      description: '',
      hostId: 'cleo',
      locationId: 'park',
      start: at(1, '17:00'),
      end: at(1, '18:30'),
      invitees: ['ben'],
      accepted: ['ben'],
      declined: [],
      attendees: [],
      status: 'scheduled',
      source: 'llm',
      kind: 'date',
    });
    await v.advanceTo(at(1, '10:02'));
    const clash = await ben.romance.decide('mia', 'Park?', park, at(1, '17:30'));
    expect(clash).toMatchObject({ accept: false, source: 'fallback' });
    expect(v.queue.count('date.decide')).toBe(0);

    ben.town.romances.put(romance('ben', 'cleo', { stage: 'dating' }));
    const taken = await ben.romance.decide('mia', 'Park tomorrow?', park, at(2, '17:00'));
    expect(taken.accept).toBe(false);
    expect(v.queue.count('date.decide')).toBe(0);
    expect((await ben.romance.decide('cleo', 'Again?', park, at(2, '17:00'))).accept).toBe(true);
  });
  it('turns down a date while having a crush on someone else, but not for being someone’s crush', async () => {
    const v = createTestVillage({ start: at(1, '10:00'), locations: V2_LOCATIONS });
    mutual(v, 'ben', 'mia', 9);
    mutual(v, 'ben', 'cleo', 9);
    await v.advanceTo(at(1, '10:01'));
    const ben = v.minds.get('ben')!;
    const park = V2_LOCATIONS.find((l) => l.id === 'park')!;
    ben.town.romances.put(romance('cleo', 'ben'));
    const admired = await ben.romance.decide('mia', 'Park?', park, at(1, '17:00'));
    expect(admired.source).not.toBe('fallback');
    expect(v.queue.count('date.decide')).toBe(1);

    ben.town.romances.put(romance('ben', 'cleo', { crushFrom: ['cleo', 'ben'] }));
    const smitten = await ben.romance.decide('mia', 'Park tomorrow?', park, at(2, '17:00'));
    expect(smitten).toMatchObject({ accept: false, source: 'fallback' });
    expect(v.queue.count('date.decide')).toBe(1);
  });
});

describe('couples (v2 §7)', () => {
  it('two done dates and mutual affinity 7+ make a couple at night, with a toast and memories', async () => {
    const v = createTestVillage({ start: at(2, '01:58'), locations: V2_LOCATIONS });
    mutual(v, 'mia', 'ben', 8);
    const mia = v.minds.get('mia')!;
    const done = (eventId: string) => ({
      eventId,
      locationId: 'park',
      at: at(1, '17:00'),
      askedBy: 'mia',
      status: 'done' as const,
      source: 'llm' as const,
    });
    mia.town.romances.put(romance('ben', 'mia', { stage: 'dating', dates: [done('d1'), done('d2')] }));
    await v.advanceTo(at(2, '02:05'));
    const r = mia.town.romances.get(romanceId('mia', 'ben'))!;
    expect(r.stage).toBe('couple');
    const toasts = v.messages.filter((m) => m.type === 'toast');
    expect(toasts).toEqual([expect.objectContaining({ text: '💕 Ben and Mia are now a couple!' })]);
    expect(v.messages.some((m) => m.type === 'world.event' && m.event.kind === 'couple')).toBe(true);
    for (const [id, other] of [
      ['mia', 'Ben'],
      ['ben', 'Mia'],
    ] as const)
      expect(
        v.minds
          .get(id)!
          .memory.all()
          .find((m) => m.text === `${other} and I are a couple now!`)!.importance,
      ).toBe(8);
    expect(mia.romance.planLine(v.view('mia'))).toContain('Ben are a couple');

    // After a chat, only one of the two partners asks.
    v.time.now = at(2, '10:00');
    await v.advanceTo(at(2, '10:01'));
    await runner(v).run(conv('mia', 'ben', v.time.now), [mia, v.minds.get('ben')!]);
    await v.queue.drain();
    expect(v.queue.count('date.ask')).toBe(1);
    expect(v.events.filter((e) => e.kind === 'date')).toHaveLength(1);
  });

  it('does not make a couple with one done date or one-sided affinity', async () => {
    const v = createTestVillage({ start: at(2, '01:58'), locations: V2_LOCATIONS });
    setAffinity(v, 'mia', 'ben', 9);
    setAffinity(v, 'ben', 'mia', 5);
    const mia = v.minds.get('mia')!;
    const d = (eventId: string) => ({
      eventId,
      locationId: 'park',
      at: at(1, '17:00'),
      askedBy: 'mia',
      status: 'done' as const,
      source: 'llm' as const,
    });
    mia.town.romances.put(romance('ben', 'mia', { stage: 'dating', dates: [d('d1'), d('d2')] }));
    await v.advanceTo(at(2, '02:05'));
    expect(mia.town.romances.get(romanceId('mia', 'ben'))!.stage).toBe('dating');
  });

  it('a visitor never becomes part of a couple', async () => {
    const vera: VillagerProfile = {
      ...person('vera', 'Vera', 'Tourist'),
      homeId: 'hotel',
      transient: true,
      visitor: true,
    };
    const v = createTestVillage({
      start: at(2, '01:58'),
      profiles: [vera, ...PROFILES],
      locations: V2_LOCATIONS,
    });
    mutual(v, 'mia', 'vera', 9);
    const mia = v.minds.get('mia')!;
    const d = (eventId: string) => ({
      eventId,
      locationId: 'park',
      at: at(1, '17:00'),
      askedBy: 'mia',
      status: 'done' as const,
      source: 'llm' as const,
    });
    mia.town.romances.put(romance('mia', 'vera', { stage: 'dating', dates: [d('d1'), d('d2')] }));
    await v.advanceTo(at(2, '02:05'));
    expect(mia.town.romances.get(romanceId('mia', 'vera'))!.stage).toBe('dating');
    expect(v.messages.some((m) => m.type === 'toast')).toBe(false);
  });

  it('a romance ends after three days of negative affinity', async () => {
    const v = createTestVillage({ start: at(1, '01:58'), locations: V2_LOCATIONS });
    mutual(v, 'mia', 'ben', -2);
    const mia = v.minds.get('mia')!;
    mia.town.romances.put(romance('ben', 'mia', { stage: 'dating' }));
    for (const day of [1, 2, 3]) {
      v.time.now = at(day, '01:58');
      await v.advanceTo(at(day, '02:02'));
      expect(mia.town.romances.get(romanceId('mia', 'ben'))!.stage).toBe('dating');
    }
    v.time.now = at(4, '01:58');
    await v.advanceTo(at(4, '02:02'));
    expect(mia.town.romances.get(romanceId('mia', 'ben'))!.stage).toBe('ended');
  });
});

describe('the shy pair (v2 §7.1)', () => {
  const shy = romance('laude', 'franzi', { crushFrom: ['laude', 'franzi'], shy: true });

  function shyVillage(day: number) {
    const v = createTestVillage({
      start: at(day, '10:00'),
      profiles: [LAUDE, FRANZI, ...PROFILES],
      locations: V2_LOCATIONS,
      extraView: () => ({ romances: [shy] }),
    });
    mutual(v, 'laude', 'franzi', 9);
    for (const id of ['laude', 'franzi']) v.states.get(id)!.locationId = 'post_office';
    return v;
  }

  it('caps shy chats at shyMaxTurns with an awkward prompt line, and are always up for a chat at the post office', async () => {
    const v = shyVillage(1);
    await v.advanceTo(at(1, '10:01'));
    const [laude, franzi] = [v.minds.get('laude')!, v.minds.get('franzi')!];
    forceRandom(laude, 0.999);
    v.states.get('laude')!.locationId = 'post_office';
    const view = v.view('laude');
    expect(laude.wantsToTalkTo(view, 'franzi')).toBe(true);
    expect(laude.wantsToTalkTo(view, 'mia')).toBe(false);
    const c = conv('laude', 'franzi', v.time.now, 'post_office');
    await runner(v).run(c, [laude, franzi]);
    await v.queue.drain();
    expect(c.messages.length).toBeLessThanOrEqual(testConfig().romance!.shyMaxTurns + 1);
    const turns = v.queue.requests.filter((r) => r.task === 'convo.turn');
    expect(turns.length).toBeLessThanOrEqual(testConfig().romance!.shyMaxTurns);
    expect(JSON.stringify(turns[0]!.messages)).toContain('very shy around');
    // Day 1 is before shyMinDays: no date yet.
    expect(v.queue.count('date.ask')).toBe(0);
    // The pair cooldown still applies.
    expect(laude.wantsToTalkTo(view, 'franzi')).toBe(false);
  });

  it('asks only from day shyMinDays with affinity 8+ both ways and six talks', async () => {
    const cfg = testConfig().romance!;
    const v = shyVillage(cfg.shyMinDays);
    await v.advanceTo(at(cfg.shyMinDays, '10:01'));
    const [laude, franzi] = [v.minds.get('laude')!, v.minds.get('franzi')!];
    expect(laude.romance.shyMayDate('franzi', v.time.now)).toBe(false);
    talked(laude, 'Franzi', 6, v.time.now - 60);
    expect(laude.romance.shyMayDate('franzi', v.time.now)).toBe(true);
    setAffinity(v, 'franzi', 'laude', 7);
    await v.advanceTo(at(cfg.shyMinDays, '10:02'));
    expect(laude.romance.shyMayDate('franzi', v.time.now)).toBe(false);
    setAffinity(v, 'franzi', 'laude', 8);
    await v.advanceTo(at(cfg.shyMinDays, '10:03'));
    await runner(v).run(conv('laude', 'franzi', v.time.now, 'post_office'), [laude, franzi]);
    await v.queue.drain();
    const ask = v.queue.requests.find((r) => r.task === 'date.ask')!;
    expect(ask.meta).toMatchObject({ villagerId: 'laude', shy: true });
    expect(v.events.some((e) => e.kind === 'date' && e.hostId === 'laude')).toBe(true);
  });

  it('observers at the post office gossip about the shy pair once a day', async () => {
    const v = shyVillage(1);
    const post = V2_LOCATIONS.find((l) => l.id === 'post_office')!;
    for (const id of ['laude', 'franzi']) v.states.get(id)!.conversationId = 'c-shy';
    v.states.get('mia')!.pos = { ...post.entry };
    for (let i = 0; i < 3; i++) {
      v.time.now += 1;
      for (const id of ['laude', 'franzi', 'mia']) v.minds.get(id)!.update(v.view(id));
    }
    const gossip = v.minds
      .get('mia')!
      .memory.all()
      .filter((m) => m.text === 'Franzi was at the post office again, chatting shyly with Laude.');
    expect(gossip).toHaveLength(1);
    expect(gossip[0]!.importance).toBe(5);
  });
});

describe('fallback date time', () => {
  it('is two hours from now before 15:00, else the next 17:00', () => {
    expect(RomanceAgent.fallbackStart(at(1, '10:00'))).toBe(at(1, '12:00'));
    expect(RomanceAgent.fallbackStart(at(1, '15:30'))).toBe(at(1, '17:00'));
    expect(RomanceAgent.fallbackStart(at(1, '18:00'))).toBe(at(2, '17:00'));
  });
});

describe('visitors and romance', () => {
  it("ends a romance with a visitor who left, so the resident's next crush can form", async () => {
    const vera: VillagerProfile = {
      ...person('vera', 'Vera', 'Tourist'),
      homeId: 'hotel',
      transient: true,
      visitor: true,
    };
    const v = createTestVillage({
      start: at(1, '10:00'),
      profiles: [vera, ...PROFILES],
      locations: V2_LOCATIONS,
    });
    await v.advanceTo(at(1, '10:01'));
    const mia = v.minds.get('mia')!;
    mia.town.romances.put(romance('mia', 'vera'));
    // Vera boards the train: her mind is no longer stepped.
    v.minds.delete('vera');
    v.time.now = at(1, '10:30');
    mia.update(v.view('mia'));
    expect(mia.town.romances.get(romanceId('mia', 'vera'))!.stage).toBe('crush');
    v.time.now = at(1, '11:30');
    mia.update(v.view('mia'));
    expect(mia.town.romances.get(romanceId('mia', 'vera'))!.stage).toBe('ended');

    mutual(v, 'mia', 'ben', 7);
    talked(mia, 'Ben', 2, at(1, '11:00'));
    forceRandom(mia, 0);
    for (const id of ['ben', 'cleo', 'dan']) forceRandom(v.minds.get(id)!, 0.99);
    v.time.now = at(2, '01:58');
    await v.advanceTo(at(2, '02:03'));
    expect(mia.town.romances.get(romanceId('mia', 'ben'))?.stage).toBe('crush');
  });
});

describe('romance under a slow model (AC16, cognition side)', () => {
  it('skips date.ask and answers date.decide offline when overloaded; greetings and letter replies still ask', async () => {
    const v = createTestVillage({ start: at(1, '10:00'), locations: V2_LOCATIONS });
    mutual(v, 'mia', 'ben', 7);
    await v.advanceTo(at(1, '10:01'));
    const [mia, ben] = [v.minds.get('mia')!, v.minds.get('ben')!];
    mia.town.romances.put(romance('mia', 'ben'));
    loadTracker(v.queue).seed(LAG_OVERLOADED * 20, v.time.now);
    expect(mia.load()).toBe('overloaded');

    await runner(v).run(conv('mia', 'ben', v.time.now), [mia, ben]);
    await v.queue.drain();
    expect(v.queue.count('date.ask')).toBe(0);

    const park = V2_LOCATIONS.find((l) => l.id === 'park')!;
    const answer = await ben.romance.decide('mia', 'Park with me?', park, at(1, '17:00'));
    expect(answer).toMatchObject({ accept: true, source: 'fallback' });
    expect(v.queue.count('date.decide')).toBe(0);

    const greet = await mia.greetVisitor(v.view('mia'), {
      id: 'v1',
      houseId: 'house_mia',
      ownerIds: ['mia'],
      at: v.time.now,
      kind: 'visit',
      witnesses: [],
    });
    expect(greet.source).toBe('llm');
    expect(v.queue.count('visit.greet')).toBe(1);

    mia.onLetterRead(v.view('mia'), {
      id: 'L1',
      from: 'player',
      to: 'mia',
      text: 'Thank you for the rye bread',
      postedAt: v.time.now,
      deliveredAt: v.time.now,
      readAt: v.time.now,
      status: 'read',
    });
    await v.queue.drain();
    expect(v.queue.count('letter.reply')).toBe(1);
  });
});
