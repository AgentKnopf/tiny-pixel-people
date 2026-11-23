import { describe, expect, it } from 'vitest';
import { at } from '../../../src/shared/time.ts';
import type { Conversation, Romance, VillageEvent, VillagerProfile } from '../../../src/shared/types.ts';
import { createConversationRunner } from '../../../src/server/cognition/conversation.ts';
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
  it('is the next 17:00 at least two hours away', () => {
    expect(RomanceAgent.fallbackStart(at(1, '10:00'))).toBe(at(1, '17:00'));
    expect(RomanceAgent.fallbackStart(at(1, '15:30'))).toBe(at(2, '17:00'));
  });
});
