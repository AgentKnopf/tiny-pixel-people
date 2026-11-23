import { describe, expect, it } from 'vitest';
import { at, minuteOfDay } from '../../../src/shared/time.ts';
import type { ChatRequest } from '../../../src/server/llm/types.ts';
import type { DoorNote, VillagerProfile } from '../../../src/shared/types.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import { blockAt } from '../../../src/server/cognition/planning.ts';
import { createTestVillage, testConfig } from './helpers.ts';

function scriptedPlan(req: ChatRequest): string {
  const p = req.meta?.profile as VillagerProfile;
  const work = p.id === 'mia' ? 'Bakery' : p.id === 'ben' ? 'farm' : p.id === 'cleo' ? 'cafe' : 'park';
  return (
    'Here is my plan:\n```json\n' +
    JSON.stringify({
      summary: `${p.name} has a busy day`,
      blocks: [
        { start: '06:00', end: '07:00', location: 'home', activity: 'breakfast', emoji: '🍳' },
        { start: '07:00', end: '12:00', location: work, activity: 'work hard' },
        { start: '12:00', end: '13:00', location: 'cafe', activity: 'lunch' },
        { start: '13:00', end: '18:00', location: work, activity: 'more work' },
        { start: '18:00', end: '22:00', location: 'home', activity: 'dinner and reading' },
      ],
    }) +
    '\n```'
  );
}

function provider(): MockChatProvider {
  const p = new MockChatProvider();
  p.setScript('plan.day', scriptedPlan);
  return p;
}

describe('Mind planning', () => {
  it('uses a fallback plan at once, then the LLM plan, and turns blocks into intents', async () => {
    const v = createTestVillage({ start: at(0, '05:59'), provider: provider() });
    const mia = v.minds.get('mia')!;
    await v.advanceTo(at(0, '06:01'));
    const plan = v.worlds.get('mia')!.plan!;
    expect(plan.day).toBe(0);
    expect(plan.source).toBe('llm');
    expect(plan.blocks[0]!.start).toBe(360);
    expect(plan.blocks.at(-1)!.end).toBe(1320);
    await v.advanceTo(at(0, '08:00'));
    expect(v.states.get('mia')!.locationId).toBe('bakery');
    expect(mia.update(v.view('mia'))).toEqual({
      type: 'act',
      activity: 'work hard',
      emoji: expect.any(String),
    });
    expect(v.queue.count('plan.day')).toBe(4);
  });

  it('keeps a sane fallback plan when the model returns garbage', async () => {
    const p = new MockChatProvider();
    p.setScript('plan.day', () => 'I am not sure what you mean.');
    const v = createTestVillage({ start: at(0, '05:59'), provider: p });
    await v.advanceTo(at(0, '06:05'));
    const plan = v.worlds.get('ben')!.plan!;
    expect(plan.source).toBe('fallback');
    expect(plan.blocks.some((b) => b.locationId === 'farm')).toBe(true);
    // Two attempts (each with a repair) at dawn, then background retries every half hour until noon.
    const asked = () =>
      v.queue.requests.filter((r) => r.task === 'plan.day' && r.meta?.villagerId === 'ben').length;
    await v.advanceTo(at(0, '07:10'));
    expect(asked()).toBe(8);
    await v.advanceTo(at(0, '12:30'));
    const byNoon = asked();
    expect(byNoon).toBeLessThanOrEqual(16);
    await v.advanceTo(at(0, '15:00'));
    expect(asked()).toBe(byNoon);
    expect(v.worlds.get('ben')!.plan!.source).toBe('fallback');
  });

  it('goes home and sleeps at night, summarises the day and prepares tomorrow', async () => {
    const v = createTestVillage({ start: at(0, '21:00'), provider: provider() });
    await v.advanceTo(at(0, '21:30'));
    v.minds
      .get('cleo')!
      .observe({ at: v.time.now, kind: 'heard', text: 'Ben found a golden carrot', importance: 7 });
    await v.advanceTo(at(0, '22:30'));
    expect(v.states.get('cleo')!.status).toBe('sleeping');
    expect(v.states.get('cleo')!.locationId).toBe('house_cleo');
    const summary = v.minds
      .get('cleo')!
      .memory.all()
      .find((m) => m.kind === 'summary')!;
    expect(summary.text).toMatch(/^Summary of day 1:/);
    await v.advanceTo(at(1, '06:10'));
    const plan = v.worlds.get('cleo')!.plan!;
    expect(plan.day).toBe(1);
    expect(plan.source).toBe('llm');
    // Only Cleo had anything to remember that day.
    expect(
      v.queue.requests.filter((r) => r.task === 'day.summarize').map((r) => r.meta?.villagerId),
    ).toContain('cleo');
    expect(
      v.minds
        .get('ben')!
        .memory.all()
        .some((m) => m.kind === 'summary'),
    ).toBe(false);
  });

  it('inserts a food block when hunger is low', async () => {
    const v = createTestVillage({ start: at(0, '05:59'), provider: provider() });
    await v.advanceTo(at(0, '09:00'));
    v.states.get('ben')!.needs.hunger = 10;
    const intent = v.minds.get('ben')!.update(v.view('ben'));
    // The nearest food from Ben's position (his home door in this harness) is his own kitchen.
    expect(intent).toMatchObject({ type: 'goto', locationId: 'house_ben', activity: 'eat a snack at home' });
    expect(blockAt(v.worlds.get('ben')!.plan, minuteOfDay(v.time.now))!.activity).toBe('eat a snack at home');
  });

  it('renews the food block when hunger is still critical as it ends, not after a cooldown', async () => {
    const v = createTestVillage({ start: at(0, '05:59'), provider: provider() });
    await v.advanceTo(at(0, '09:00'));
    const ben = v.minds.get('ben')!;
    const hunger = (n: number) => (v.states.get('ben')!.needs.hunger = n);
    hunger(10);
    ben.update(v.view('ben'));
    const first = blockAt(v.worlds.get('ben')!.plan, 540)!;
    expect(first).toMatchObject({ start: 540, end: 585, activity: 'eat a snack at home' });
    // The block ends at 09:45 with Ben barely fed: he goes back to work...
    await v.advanceTo(at(0, '09:30'));
    hunger(30);
    await v.advanceTo(at(0, '09:46'));
    expect(ben.update(v.view('ben'))).toMatchObject({ activity: 'work hard' });
    // ...and once critical again he eats at once instead of waiting out the old 2-hour cooldown.
    await v.advanceTo(at(0, '09:50'));
    hunger(15);
    expect(ben.update(v.view('ben'))).toMatchObject({ activity: 'eat a snack at home' });
    expect(blockAt(v.worlds.get('ben')!.plan, minuteOfDay(v.time.now))).toMatchObject({ start: 590, end: 635 });
  });

  it('renews at the exact end of a food block when hunger never left the critical range', async () => {
    const v = createTestVillage({ start: at(0, '05:59'), provider: provider() });
    await v.advanceTo(at(0, '09:00'));
    const ben = v.minds.get('ben')!;
    v.states.get('ben')!.needs.hunger = 10;
    ben.update(v.view('ben'));
    await v.advanceTo(at(0, '09:44'));
    v.states.get('ben')!.needs.hunger = 10;
    ben.update(v.view('ben'));
    // Still inside the first block: no second block yet.
    expect(blockAt(v.worlds.get('ben')!.plan, 584)).toMatchObject({ start: 540, end: 585 });
    await v.advanceTo(at(0, '09:45'));
    v.states.get('ben')!.needs.hunger = 10;
    expect(ben.update(v.view('ben'))).toMatchObject({ activity: 'eat a snack at home' });
    expect(blockAt(v.worlds.get('ben')!.plan, 585)).toMatchObject({ start: 585, end: 630 });
  });

  it('moves outdoor activities indoors in the rain without rewriting the plan', async () => {
    const v = createTestVillage({ start: at(0, '05:59'), provider: provider() });
    await v.advanceTo(at(0, '09:00'));
    v.weather = { state: 'rain', since: v.time.now, until: null };
    const intent = v.minds.get('ben')!.update(v.view('ben'));
    expect(intent).toMatchObject({ type: 'goto', emoji: '☔' });
    expect(blockAt(v.worlds.get('ben')!.plan, 540)!.locationId).toBe('farm');
  });

  it('adopts plan changes made by the engine', async () => {
    const v = createTestVillage({ start: at(0, '05:59'), provider: provider() });
    await v.advanceTo(at(0, '09:00'));
    const w = v.worlds.get('dan')!;
    const copy = structuredClone(w.plan!);
    copy.blocks = copy.blocks.map((b) => (b.locationId === 'park' ? { ...b, locationId: 'cafe' } : b));
    w.plan = copy;
    const intent = v.minds.get('dan')!.update(v.view('dan'));
    expect(intent).toMatchObject({ type: 'goto', locationId: 'cafe' });
  });
});

describe('Mind memory', () => {
  it('dedupes repeated observations and rates importance in batches', async () => {
    const p = provider();
    p.setScript('importance.rate', (req) => {
      const n = (req.meta?.memories as unknown[]).length;
      return JSON.stringify({ ratings: Array.from({ length: n }, () => 9) });
    });
    const v = createTestVillage({
      start: at(0, '05:59'),
      provider: p,
      config: testConfig({ reflectionThreshold: 1000 }),
    });
    const mia = v.minds.get('mia')!;
    const t = at(0, '06:00');
    mia.observe({ at: t, kind: 'observation', text: 'Ben is walking to the farm' });
    mia.observe({ at: t + 1, kind: 'observation', text: 'Ben is walking to the farm' });
    mia.observe({ at: t + 5, kind: 'observation', text: 'Ben is shouting about a fire' });
    expect(mia.memory.all().filter((m) => m.text.startsWith('Ben')).length).toBe(1);
    for (let i = 0; i < 8; i++)
      mia.observe({ at: t, kind: 'conversation', text: `Cleo told a story number ${i}` });
    await v.advanceTo(at(0, '06:02'));
    expect(v.queue.count('importance.rate')).toBe(1);
    expect(
      mia.memory
        .all()
        .filter((m) => m.kind === 'conversation')
        .every((m) => m.importance === 9),
    ).toBe(true);
  });

  it('reflects when importance piles up and cites sources', async () => {
    const p = provider();
    p.setScript('reflect', () => '{"insights":[{"text":"Ben and I are close friends","because":[1,2]}]}');
    const v = createTestVillage({
      start: at(0, '06:59'),
      provider: p,
      config: testConfig({ reflectionThreshold: 15, importanceMode: 'heuristic' }),
    });
    const mia = v.minds.get('mia')!;
    mia.observe({ at: at(0, '07:00'), kind: 'heard', text: 'Ben brought me flowers', importance: 8 });
    mia.observe({ at: at(0, '07:00'), kind: 'heard', text: 'Ben fixed my oven', importance: 8 });
    await v.advanceTo(at(0, '07:02'));
    const r = mia.memory.all().find((m) => m.kind === 'reflection')!;
    expect(r.text).toBe('Ben and I are close friends');
    expect(r.meta.sourceIds!.length).toBe(2);
  });

  it('round-trips through serialize()', async () => {
    const v = createTestVillage({ start: at(0, '05:59'), provider: provider() });
    await v.advanceTo(at(0, '07:00'));
    v.minds
      .get('ben')!
      .observe({ at: v.time.now, kind: 'heard', text: 'Secret: the well is magic', importance: 7 });
    const snap = v.minds.get('ben')!.serialize();
    const v2 = createTestVillage({ start: v.time.now, provider: provider(), snapshots: { ben: snap } });
    const ben2 = v2.minds.get('ben')!;
    expect(ben2.serialize().memories).toEqual(snap.memories);
    const m = ben2.addMemory({ at: v.time.now, kind: 'observation', text: 'new' });
    expect(m.id).toBe(`ben-m${snap.memories.length + 1}`);
  });
});

describe('Mind door notes', () => {
  it('reads a note on the next arrival home and replies with a reference to it', async () => {
    const p = provider();
    p.setScript('note.reply', () => 'Sure thing, see you soon!');
    const v = createTestVillage({ start: at(0, '05:59'), provider: p });
    await v.advanceTo(at(0, '10:00'));
    expect(v.states.get('mia')!.locationId).toBe('bakery');
    const note: DoorNote = {
      id: 'note1',
      houseId: 'house_mia',
      ownerId: 'mia',
      authorId: 'player',
      text: 'Could you bake a blueberry pie for the festival?',
      postedAt: v.time.now,
      status: 'unread',
    };
    v.notes.push(note);
    await v.advanceTo(at(0, '17:59'));
    expect(v.notes[0]!.status).toBe('unread');
    await v.advanceTo(at(0, '18:05'));
    const n = v.notes[0]!;
    expect(n.status).toBe('replied');
    expect(n.readAt).toBe(at(0, '18:00'));
    expect(n.reply).toMatch(/blueberry pie/);
    const mem = v.minds
      .get('mia')!
      .memory.all()
      .find((m) => m.kind === 'note')!;
    expect(mem.importance).toBeGreaterThanOrEqual(7);
    expect(mem.meta.originId).toBe('note1');
  });
});

describe('Mind events', () => {
  it('ensures a daily event: the best host proposes, invitees decide and plan to attend', async () => {
    const v = createTestVillage({ start: at(0, '05:59'), provider: provider() });
    await v.advanceTo(at(0, '10:05'));
    expect(v.events).toHaveLength(1);
    const e = v.events[0]!;
    expect(e.hostId).toBe('mia');
    expect(e.title).toBe('Bake-off');
    expect(e.invitees.sort()).toEqual(['ben', 'cleo', 'dan']);
    expect(minuteOfDay(e.start)).toBe(15 * 60);
    expect(e.accepted.sort()).toEqual(['ben', 'cleo', 'dan']);
    for (const id of ['mia', 'ben', 'cleo', 'dan']) {
      expect(
        v.worlds.get(id)!.plan!.blocks.some((b) => b.eventId === e.id && b.start === 900),
        id,
      ).toBe(true);
    }
    expect(
      v.minds
        .get('ben')!
        .memory.all()
        .some((m) => m.kind === 'event' && m.meta.eventId === e.id),
    ).toBe(true);
    await v.advanceTo(at(0, '15:10'));
    expect(v.states.get('dan')!.locationId).toBe(e.locationId);
    // engine marks it done; attendees remember it
    v.events[0] = { ...v.events[0]!, status: 'done', attendees: ['ben', 'cleo', 'dan'] };
    await v.advanceTo(at(0, '17:01'));
    expect(
      v.minds
        .get('cleo')!
        .memory.all()
        .some((m) => m.text.startsWith('I attended Bake-off')),
    ).toBe(true);
    await v.advanceTo(at(0, '12:00') + 1440);
    expect(v.events.filter((x) => x.start < at(1, '00:00'))).toHaveLength(1);
  });

  it('declines when the model says no, and requestEventProposal() triggers a proposal', async () => {
    const p = provider();
    p.setScript('event.decide', (req) =>
      req.meta?.villagerId === 'ben' ? '{"accept": "no", "reason": "too busy"}' : '{"accept": true}',
    );
    p.setScript(
      'event.propose',
      () =>
        '{"title":"Painting class","location":"the park","start":"4pm","durationMinutes":90,"invitees":["Ben","Cleo","Nobody"]}',
    );
    const v = createTestVillage({
      start: at(0, '07:59'),
      provider: p,
      config: { ...testConfig(), events: { ensureDaily: false, maxProposalsPerDay: 2 } },
    });
    v.minds.get('dan')!.requestEventProposal();
    await v.advanceTo(at(0, '08:01'));
    const e = v.events[0]!;
    expect(e).toMatchObject({
      hostId: 'dan',
      title: 'Painting class',
      locationId: 'park',
      start: at(0, '16:00'),
      end: at(0, '17:30'),
    });
    expect(e.declined).toEqual(['ben']);
    expect(e.accepted.sort()).toEqual(['cleo', 'mia']);
  });
});

describe('Mind and the player', () => {
  it('replies, accepts a task, schedules it and reports completion', async () => {
    const p = provider();
    p.setScript('player.reply', () => '{"reply": "Happy to help!"}');
    p.setScript(
      'task.decide',
      () => '{"accept": true, "activity": "bring bread to the plaza", "location": "plaza", "time": "10:00"}',
    );
    const v = createTestVillage({ start: at(0, '05:59'), provider: p });
    await v.advanceTo(at(0, '09:00'));
    const res = await v.minds
      .get('mia')!
      .replyToPlayer(v.view('mia'), { text: 'Could you bring bread to the plaza?', mode: 'ask' });
    expect(res.reply).toContain('Happy to help!');
    expect(res.task).toMatchObject({
      accepted: true,
      locationId: 'plaza',
      start: at(0, '10:00'),
      activity: 'bring bread to the plaza',
    });
    const block = v.worlds.get('mia')!.plan!.blocks.find((b) => b.taskId === res.task!.taskId)!;
    expect(block).toMatchObject({ start: 600, end: 660, locationId: 'plaza' });
    await v.advanceTo(at(0, '10:30'));
    expect(v.states.get('mia')!.locationId).toBe('plaza');
    await v.advanceTo(at(0, '11:01'));
    expect(v.worlds.get('mia')!.tasks.map((t) => t.taskId)).toEqual([res.task!.taskId]);
    const mem = v.minds.get('mia')!.memory.all();
    expect(mem.some((m) => m.kind === 'conversation' && m.text.includes('bring bread'))).toBe(true);
    expect(mem.some((m) => m.text.startsWith('I did what'))).toBe(true);
  });

  it('does not store a second gift memory and survives a failing model', async () => {
    const p = provider();
    p.setScript('player.reply', () => {
      throw new Error('boom');
    });
    const v = createTestVillage({ start: at(0, '05:59'), provider: p });
    await v.advanceTo(at(0, '09:00'));
    const before = v.minds.get('ben')!.memory.all().length;
    const res = await v.minds
      .get('ben')!
      .replyToPlayer(v.view('ben'), { text: 'flower', mode: 'gift', itemId: 'flower', liked: true });
    expect(res.reply).toMatch(/flower/);
    const added = v.minds.get('ben')!.memory.all().slice(before);
    expect(added.map((m) => m.text)).toEqual([`I told the newcomer: "${res.reply}"`]);
  });
});
