import { describe, expect, it } from 'vitest';
import { at } from '../../../src/shared/time.ts';
import type { ChatRequest } from '../../../src/server/llm/types.ts';
import type { VillageEvent, VillagerProfile } from '../../../src/shared/types.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import { PriorityLlmQueue } from '../../../src/server/llm/queue.ts';
import { PREPARE_MAX_ATTEMPTS, PRIORITY } from '../../../src/server/cognition/mind.ts';
import { fallbackBlocks, makePlan } from '../../../src/server/cognition/planning.ts';
import { LOCATIONS, PROFILES, createTestVillage, testConfig } from './helpers.ts';

const MIA = [PROFILES[0]!];

function plan(
  req: ChatRequest,
  blocks = [
    ['06:00', '12:00', 'plaza', 'work'],
    ['12:00', '22:00', 'cafe', 'relax'],
  ],
) {
  const p = req.meta?.profile as VillagerProfile;
  return JSON.stringify({ summary: `${p.name} works`, blocks });
}

/** plan.day for `day` waits until released; other days answer at once. */
function holdDay(day: number) {
  const waiting: Array<() => void> = [];
  const p = new MockChatProvider();
  let inflight = 0;
  let maxInflight = 0;
  p.setScript('plan.day', (req) => {
    if (req.meta?.day !== day) return plan(req);
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    return new Promise<string>((resolve) =>
      waiting.push(() => {
        inflight--;
        resolve(plan(req));
      }),
    );
  });
  return {
    provider: p,
    releaseAll: () => waiting.splice(0).forEach((f) => f()),
    get maxInflight() {
      return maxInflight;
    },
  };
}

const asks = (v: ReturnType<typeof createTestVillage>, id: string, day?: number) =>
  v.queue.requests.filter(
    (r) => r.task === 'plan.day' && r.meta?.villagerId === id && (day === undefined || r.meta?.day === day),
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Like advanceTo, without draining the queue: some plan answers here are held back on purpose. */
async function stepTo(v: ReturnType<typeof createTestVillage>, t: number, step = 1) {
  while (v.time.now < t) {
    v.time.now = Math.min(t, v.time.now + step);
    for (const [id, mind] of v.minds) mind.update(v.view(id));
    await sleep(0);
  }
}

describe("tomorrow's plan", () => {
  it('is asked from 4 game hours before bedtime, waiting in the queue until the villager wakes', async () => {
    const p = new MockChatProvider();
    p.setScript('plan.day', (req) => plan(req));
    const v = createTestVillage({ start: at(0, '05:59'), provider: p, profiles: MIA });
    await v.advanceTo(at(0, '17:59'), 5);
    expect(asks(v, 'mia', 1)).toHaveLength(0);
    await v.advanceTo(at(0, '18:01'));
    const [req] = asks(v, 'mia', 1);
    expect(req).toBeDefined();
    expect(v.queue.priorities.get(req!)).toBe(PRIORITY.planTomorrow);
    // Not the plan.day TTL: a slow evening queue must not drop it before the morning.
    expect(v.queue.options.get(req!)?.expiresAt).toBe(at(1, '06:00'));
    expect(v.queue.options.get(req!)?.dedupeKey).toBe('plan:mia:day1');
  });

  it('is asked again when it fails, bounded, and only then counts as settled', async () => {
    const p = new MockChatProvider();
    p.setScript('plan.day', (req) => {
      if (req.meta?.day === 1) throw new Error('model down');
      return plan(req);
    });
    const v = createTestVillage({ start: at(0, '05:59'), provider: p, profiles: MIA });
    const mia = v.minds.get('mia')!;
    await v.advanceTo(at(0, '18:00'));
    await v.queue.drain();
    expect(asks(v, 'mia', 1)).toHaveLength(1);
    expect(mia.isPlanSettled(1)).toBe(false);
    await v.advanceTo(at(0, '18:25'));
    expect(asks(v, 'mia', 1)).toHaveLength(1);
    await v.advanceTo(at(1, '05:00'), 5);
    expect(asks(v, 'mia', 1)).toHaveLength(PREPARE_MAX_ATTEMPTS);
    expect(mia.isPlanSettled(1)).toBe(true);
    // At wake the fallback is used and today's plan is asked again as usual.
    await v.advanceTo(at(1, '06:01'));
    expect(v.worlds.get('mia')!.plan).toMatchObject({ day: 1 });
    expect(asks(v, 'mia', 1).length).toBeGreaterThan(PREPARE_MAX_ATTEMPTS);
  });

  it('never has two asks for the same day queued for one villager', async () => {
    const h = holdDay(1);
    const v = createTestVillage({ start: at(0, '05:59'), provider: h.provider, profiles: MIA });
    await stepTo(v, at(1, '05:30'), 5);
    expect(asks(v, 'mia', 1)).toHaveLength(1);
    h.releaseAll();
    await sleep(5);
    await stepTo(v, at(1, '06:30'));
    expect(asks(v, 'mia', 1)).toHaveLength(1);
    expect(v.worlds.get('mia')!.plan).toMatchObject({ day: 1, source: 'llm' });
  });

  it('is asked for at most llm.concurrency + 1 villagers at once', async () => {
    const base = testConfig();
    const config = { ...base, llm: { ...base.llm, concurrency: 1 } };
    const h = holdDay(1);
    const v = createTestVillage({ start: at(0, '05:59'), provider: h.provider, config });
    await stepTo(v, at(0, '19:00'), 5);
    const asked = () =>
      new Set(v.queue.requests.filter((r) => r.meta?.day === 1).map((r) => r.meta?.villagerId));
    expect(asked().size).toBe(2);
    h.releaseAll();
    await sleep(5);
    await stepTo(v, at(0, '19:10'));
    h.releaseAll();
    await sleep(5);
    await stepTo(v, at(0, '19:20'));
    expect(asked().size).toBe(4);
    expect(h.maxInflight).toBe(2);
    for (const id of ['mia', 'ben', 'cleo', 'dan']) expect(v.minds.get(id)!.isPlanSettled(1), id).toBe(true);
  });
});

describe('plans on load', () => {
  it('asks every resident for the coming day in the first step of a world started at night', async () => {
    const h = holdDay(0);
    const v = createTestVillage({ start: at(0, '03:00'), provider: h.provider });
    await stepTo(v, at(0, '03:01'));
    await sleep(10);
    expect(
      new Set(v.queue.requests.filter((r) => r.meta?.day === 0).map((r) => r.meta?.villagerId)).size,
    ).toBe(4);
    h.releaseAll();
  });

  const restored = (time: string, day: number) => {
    const p = new MockChatProvider();
    p.setScript('plan.day', (req) => plan(req));
    const v = createTestVillage({ start: at(day, time), provider: p, profiles: MIA });
    // A save holds today's plan in the villager state; prepared plans are not saved.
    v.worlds.get('mia')!.plan = makePlan(
      3,
      'saved',
      fallbackBlocks(MIA[0]!, LOCATIONS),
      'llm',
      at(3, '06:00'),
    );
    return v;
  };

  it('restored mid-evening: asks for tomorrow, not for today again', async () => {
    const v = restored('20:00', 3);
    await v.advanceTo(at(3, '20:01'));
    expect(asks(v, 'mia').map((r) => r.meta?.day)).toEqual([4]);
    expect(v.queue.priorities.get(asks(v, 'mia')[0]!)).toBe(PRIORITY.planTomorrow);
  });

  it('restored at night: asks for the coming day (before and after midnight)', async () => {
    const late = restored('23:00', 3);
    await late.advanceTo(at(3, '23:01'));
    expect(asks(late, 'mia').map((r) => r.meta?.day)).toEqual([4]);
    const night = restored('01:00', 4);
    await night.advanceTo(at(4, '01:01'));
    expect(asks(night, 'mia').map((r) => r.meta?.day)).toEqual([4]);
    expect(night.queue.priorities.get(asks(night, 'mia')[0]!)).toBe(PRIORITY.planToday);
  });
});

describe('default morning routine and the late swap', () => {
  it('starts the fallback day with waking, washing and breakfast at home', () => {
    const [first] = fallbackBlocks(MIA[0]!, LOCATIONS);
    expect(first).toMatchObject({ start: 6 * 60, locationId: MIA[0]!.homeId });
    expect(first!.activity).toMatch(/wake/i);
    expect(first!.activity).toMatch(/wash/i);
    expect(first!.activity).toMatch(/breakfast/i);
  });

  async function lateMorning(answer: string[][], events: VillageEvent[] = []) {
    const h = holdDay(0);
    let blocks: string[][] | null = null;
    h.provider.setScript(
      'plan.day',
      (req) =>
        new Promise<string>((resolve) => {
          const tick = () => (blocks ? resolve(plan(req, blocks)) : setTimeout(tick, 1));
          tick();
        }),
    );
    const v = createTestVillage({ start: at(0, '05:59'), provider: h.provider, profiles: MIA });
    v.events.push(...events);
    await stepTo(v, at(0, '06:40'));
    const before = structuredClone(v.worlds.get('mia')!.plan!);
    expect(before).toMatchObject({ day: 0, source: 'fallback' });
    expect(before.blocks[0]).toMatchObject({ start: 360, end: 420, locationId: MIA[0]!.homeId });
    blocks = answer;
    for (let i = 0; i < 5; i++) await sleep(5);
    await stepTo(v, at(0, '06:41'));
    return { v, before, after: v.worlds.get('mia')!.plan! };
  }

  it('swaps to a plan that lands at 06:40 mid-routine: the morning so far stays, the rest is new', async () => {
    const { after } = await lateMorning([
      ['06:00', '12:00', 'plaza', 'work'],
      ['12:00', '22:00', 'cafe', 'relax'],
    ]);
    expect(after.source).toBe('llm');
    expect(after.blocks.slice(0, 2).map((b) => [b.start, b.end, b.locationId])).toEqual([
      [360, 400, MIA[0]!.homeId],
      [400, 720, 'plaza'],
    ]);
  });

  it('keeps the fallback when the answer is entirely in the past, and counts the day as settled', async () => {
    const { v, before, after } = await lateMorning([['06:00', '06:30', 'plaza', 'early work']]);
    expect(after.source).toBe('fallback');
    expect(after.blocks.filter((b) => b.end > 400)).toEqual(before.blocks.filter((b) => b.end > 400));
    expect(v.minds.get('mia')!.isPlanSettled(0)).toBe(true);
  });

  it('keeps an event block from the fallback plan through the swap', async () => {
    const event: VillageEvent = {
      id: 'ev1',
      title: 'Bake-off',
      description: '',
      hostId: 'ben',
      locationId: 'plaza',
      start: at(0, '15:00'),
      end: at(0, '16:00'),
      invitees: ['mia'],
      accepted: ['mia'],
      declined: [],
      attendees: [],
      status: 'scheduled',
    };
    const { before, after } = await lateMorning(
      [
        ['06:00', '12:00', 'plaza', 'work'],
        ['12:00', '22:00', 'cafe', 'relax'],
      ],
      [event],
    );
    expect(before.blocks.some((b) => b.eventId === 'ev1')).toBe(true);
    expect(after.source).toBe('llm');
    expect(after.blocks.filter((b) => b.eventId === 'ev1').map((b) => [b.start, b.end])).toEqual([
      [900, 960],
    ]);
  });
});

describe("tomorrow's plan after midnight", () => {
  it('still waiting at midnight, it moves up to morning priority, behind older morning asks', async () => {
    const p = new MockChatProvider();
    const order: string[] = [];
    let releaseBlocker = () => {};
    p.setScript('plan.day', (req) => {
      if (req.meta?.villagerId === 'mia' && req.meta?.day === 1) order.push('plan');
      return plan(req);
    });
    p.setScript('health', (req) => {
      const tag = String(req.meta?.tag);
      if (tag === 'blocker') return new Promise<string>((r) => (releaseBlocker = () => r('{}')));
      order.push(tag);
      return '{}';
    });
    const v = createTestVillage({
      start: at(0, '05:59'),
      provider: p,
      profiles: MIA,
      queue: (chat, now) =>
        new PriorityLlmQueue({ chat, concurrency: 1, now, clockMs: () => 0, taskTtlMinutes: false }),
    });
    const filler = (tag: string, priority: number) =>
      void v.queue.enqueue({ task: 'health', messages: [], meta: { tag } }, { priority }).catch(() => {});
    await v.advanceTo(at(0, '17:00'));
    filler('blocker', 200);
    await stepTo(v, at(0, '23:00'), 5);
    expect(asks(v, 'mia', 1)).toHaveLength(1);
    filler('evening', PRIORITY.planToday - 10);
    await stepTo(v, at(1, '00:10'));
    filler('morning', PRIORITY.planToday);
    expect(v.queue.priorities.get(asks(v, 'mia', 1)[0]!)).toBe(PRIORITY.planTomorrow);
    expect(v.queue.preAborted.map((b) => b.opts)).toEqual([
      { dedupeKey: 'plan:mia:day1', priority: PRIORITY.planToday },
    ]);
    releaseBlocker();
    await v.queue.drain();
    expect(order).toEqual(['plan', 'morning', 'evening']);
    // The bump is no second ask: one model call, one plan.
    expect(p.calls.filter((c) => c.task === 'plan.day' && c.meta?.day === 1)).toHaveLength(1);
    await stepTo(v, at(1, '06:30'));
    expect(v.worlds.get('mia')!.plan).toMatchObject({ day: 1, source: 'llm', revision: 0 });
    expect(asks(v, 'mia', 1)).toHaveLength(1);
  });

  it('already running at midnight, the ask is not sent again', async () => {
    const h = holdDay(1);
    const v = createTestVillage({
      start: at(0, '05:59'),
      provider: h.provider,
      profiles: MIA,
      queue: (chat, now) => new PriorityLlmQueue({ chat, concurrency: 2, now, taskTtlMinutes: false }),
    });
    await stepTo(v, at(1, '00:10'), 5);
    expect(h.maxInflight).toBe(1);
    expect(v.queue.preAborted).toHaveLength(1);
    h.releaseAll();
    await v.queue.drain();
    expect(h.provider.calls.filter((c) => c.task === 'plan.day' && c.meta?.day === 1)).toHaveLength(1);
    await stepTo(v, at(1, '06:30'));
    expect(v.worlds.get('mia')!.plan).toMatchObject({ day: 1, source: 'llm' });
    expect(asks(v, 'mia', 1)).toHaveLength(1);
  });
});
