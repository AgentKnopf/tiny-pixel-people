/** TASK-18 I4: the nudge influence (spec §4.4, AC8): an importance-3 observation, tagged, never rated or prompted as such. */
import { describe, expect, it } from 'vitest';
import type { MindWorld, VillagerMind } from '../../src/server/cognition/types.ts';
import { ObserverViews } from '../../src/server/net/observer-views.ts';
import type { Engine } from '../../src/server/sim/engine.ts';
import { isAwakeAt } from '../../src/server/sim/plan.ts';
import type { InfluenceEntry, InfluenceResult } from '../../src/shared/influence.ts';
import { at, dayOf, MINUTES_PER_DAY, parseClock } from '../../src/shared/time.ts';
import type { DayPlan, VillagerId } from '../../src/shared/types.ts';
import { createSimTestWorld } from '../helpers/sim.ts';
import { createTestWorld } from '../helpers/world.ts';

const TOKEN = 'influence-test-token-0123456789abcdef';
const ON = { influence: { enabled: true, token: TOKEN, perGameDay: 0 } };

const nudge = (engine: Engine, agent: VillagerId, thought: string): InfluenceResult =>
  engine.applyInfluence({ endpoint: 'nudge', body: { agent, thought } });

function accepted(r: InfluenceResult) {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r)}`);
  return r;
}

const entry = (engine: Engine, id: string) =>
  engine.influenceLog({ limit: 200 }).entries.find((e) => e.id === id) as Extract<
    InfluenceEntry,
    { endpoint: 'nudge' }
  >;

/** A resident awake at 10:00 and asleep at 02:00. */
function dayPerson(engine: Engine): VillagerId {
  const p = engine.profiles.find(
    (x) => !x.transient && isAwakeAt(x, at(0, '10:00')) && !isAwakeAt(x, at(0, '02:00')),
  );
  if (!p) throw new Error('no day person');
  return p.id;
}

/** The engine's own world for a villager's mind (what Mind calls setPlan through). */
const mindWorld = (engine: Engine, id: VillagerId) =>
  (engine as unknown as { mindWorld(id: VillagerId): MindWorld }).mindWorld(id);

describe('nudge: accepted', () => {
  it('adds one observation with importance 3 tagged meta.influenceId, and logs it honestly', () => {
    const { engine } = createSimTestWorld({ config: ON, startAt: '10:00' });
    const id = dayPerson(engine);
    const before = engine.memories(id).length;
    const r = accepted(nudge(engine, id, 'I keep thinking about the pink house next door.'));
    expect(r.refs).toEqual({});
    const mems = engine.memories(id);
    expect(mems).toHaveLength(before + 1);
    const m = mems.at(-1)!;
    expect(m).toMatchObject({
      kind: 'observation',
      importance: 3,
      text: 'I keep thinking about the pink house next door.',
      createdAt: engine.now(),
    });
    expect(m.meta.influenceId).toBe(r.id);
    const e = entry(engine, r.id);
    expect(e).toMatchObject({ endpoint: 'nudge', targets: [id], outcomes: {} });
    expect(e.visitor).toBeUndefined();
    const town = engine.townLog.list().filter((t) => t.type === 'influence');
    expect(town).toHaveLength(1);
    expect(town[0]!.agents).toEqual([id]);
    expect(town[0]!.text).toMatch(/\[influence\]$/);
  });

  it('marks a visitor target in the log', () => {
    const { engine } = createSimTestWorld({ config: ON, startAt: '10:00' });
    const id = dayPerson(engine);
    const rt = (engine as unknown as { runtimes: Map<VillagerId, { profile: { transient?: boolean } }> })
      .runtimes;
    rt.get(id)!.profile.transient = true;
    const r = accepted(nudge(engine, id, 'The lake looks lovely today.'));
    expect(entry(engine, r.id).visitor).toBe(true);
  });

  it('shows influence_id in the observer memories view', () => {
    const { engine } = createSimTestWorld({ config: ON, startAt: '10:00' });
    const id = dayPerson(engine);
    const r = accepted(nudge(engine, id, 'Maybe I should bake bread.'));
    const views = new ObserverViews(engine, { provider: 'mock', model: 'mock' });
    const page = views.memories(id, new URLSearchParams())!;
    const items = page.items as { text: string; influence_id?: string }[];
    expect(items.find((m) => m.text === 'Maybe I should bake bread.')?.influence_id).toBe(r.id);
    expect(items.filter((m) => m.influence_id !== undefined)).toHaveLength(1);
  });
});

describe('nudge: refused', () => {
  it('422 for an unknown villager, counting nothing', () => {
    const { engine } = createSimTestWorld({
      config: { influence: { enabled: true, token: TOKEN } },
      startAt: '10:00',
    });
    expect(nudge(engine, 'nobody', 'hi')).toMatchObject({
      ok: false,
      status: 422,
      error: 'invalid',
      field: 'agent',
    });
    expect(engine.influence.budget().usedToday).toBe(0);
    expect(engine.influenceLog({}).entries).toEqual([]);
  });

  it('409 asleep with wakesAt = the next wake time, counting nothing', () => {
    const { engine } = createSimTestWorld({
      config: { influence: { enabled: true, token: TOKEN } },
      startAt: '02:00',
    });
    const id = dayPerson(engine);
    const wake = parseClock(engine.profiles.find((p) => p.id === id)!.wakeTime);
    const before = engine.memories(id).length;
    expect(nudge(engine, id, 'hi')).toEqual({ ok: false, status: 409, error: 'asleep', wakesAt: wake });
    expect(engine.memories(id)).toHaveLength(before);
    expect(engine.influence.budget().usedToday).toBe(0);
  });

  it('409 asleep while still in bed inside the wake window (soft wake), waking any minute now', () => {
    const { engine } = createSimTestWorld({ config: ON, startAt: '10:00' });
    const id = dayPerson(engine);
    const rt = (engine as unknown as { runtimes: Map<VillagerId, { state: { status: string } }> }).runtimes;
    rt.get(id)!.state.status = 'sleeping';
    expect(nudge(engine, id, 'hi')).toEqual({
      ok: false,
      status: 409,
      error: 'asleep',
      wakesAt: engine.now() + 1,
    });
  });

  it('409 asleep after bedtime gives tomorrow morning', () => {
    const { engine } = createSimTestWorld({ config: ON, startAt: '23:30' });
    const p = engine.profiles.find((x) => !x.transient && !isAwakeAt(x, at(0, '23:30')))!;
    const r = nudge(engine, p.id, 'hi');
    expect(r).toMatchObject({ ok: false, status: 409, error: 'asleep' });
    expect((r as { wakesAt: number }).wakesAt).toBe(MINUTES_PER_DAY + parseClock(p.wakeTime));
  });

  it('a memory the mind did not store fails apply: nothing counted or logged', () => {
    const { engine } = createSimTestWorld({ config: ON, startAt: '10:00' });
    const target = dayPerson(engine);
    const rt = (engine as unknown as { runtimes: Map<VillagerId, { mind: VillagerMind }> }).runtimes;
    rt.get(target)!.mind.observe = () => {};
    expect(() => nudge(engine, target, 'lost thought')).toThrow(/not stored/);
    expect(engine.influenceLog({}).entries).toEqual([]);
    expect(engine.influence.budget().usedToday).toBe(0);
  });
});

describe('nudge: planAfter ("a plan was made after the nudge")', () => {
  const planOf = (engine: Engine, id: VillagerId) =>
    engine.snapshot().villagers.find((v) => v.id === id)!.plan;

  it('records the first new plan (day or revision) after the nudge, not a same-plan update', () => {
    const { engine } = createSimTestWorld({ config: ON, startAt: '10:00' });
    const id = dayPerson(engine);
    const r = accepted(nudge(engine, id, 'Maybe I should bake bread.'));
    const plan = planOf(engine, id) as DayPlan | null;
    const base: DayPlan = plan ?? {
      day: dayOf(engine.now()),
      summary: 'x',
      blocks: [],
      revision: 0,
      source: 'fallback',
      createdAt: engine.now(),
    };
    // A weather swap or a task added to the same plan keeps day and revision: not a new plan.
    if (plan) mindWorld(engine, id).setPlan({ ...plan, blocks: [...plan.blocks] });
    expect(entry(engine, r.id).outcomes.planAfter).toBeUndefined();
    mindWorld(engine, id).setPlan({ ...base, revision: base.revision + 1, source: 'llm' });
    expect(entry(engine, r.id).outcomes.planAfter).toEqual({
      tick: engine.now(),
      revision: base.revision + 1,
      source: 'llm',
    });
    // Only the first one counts.
    mindWorld(engine, id).setPlan({ ...base, revision: base.revision + 2, source: 'fallback' });
    expect(entry(engine, r.id).outcomes.planAfter?.revision).toBe(base.revision + 1);
  });

  it("ignores other villagers' plans", () => {
    const { engine } = createSimTestWorld({ config: ON, startAt: '10:00' });
    const id = dayPerson(engine);
    const other = engine.profiles.find((p) => p.id !== id)!.id;
    const r = accepted(nudge(engine, id, 'hmm'));
    mindWorld(engine, other).setPlan({
      day: 5,
      summary: 'x',
      blocks: [],
      revision: 9,
      source: 'llm',
      createdAt: engine.now(),
    });
    expect(entry(engine, r.id).outcomes.planAfter).toBeUndefined();
  });

  it('keeps waiting for the plan across a save and restore', () => {
    const a = createSimTestWorld({ config: ON, startAt: '10:00' });
    const id = dayPerson(a.engine);
    const r = accepted(nudge(a.engine, id, 'hmm'));
    const b = createSimTestWorld({ config: ON, startAt: '10:00', restore: a.engine.toSaveData() });
    expect(entry(b.engine, r.id).outcomes.planAfter).toBeUndefined();
    mindWorld(b.engine, id).setPlan({
      day: dayOf(b.engine.now()) + 1,
      summary: 'x',
      blocks: [],
      revision: 0,
      source: 'fallback',
      createdAt: b.engine.now(),
    });
    expect(entry(b.engine, r.id).outcomes.planAfter).toMatchObject({ revision: 0, source: 'fallback' });
  });
  it('ignores a new plan made before the nudge (createdAt earlier), also after a restore', () => {
    const a = createSimTestWorld({ config: ON, startAt: '10:00' });
    const id = dayPerson(a.engine);
    const r = accepted(nudge(a.engine, id, 'hmm'));
    const old = (createdAt: number, revision = 0): DayPlan => ({
      day: dayOf(a.engine.now()) + 1,
      summary: 'x',
      blocks: [],
      revision,
      source: 'llm',
      createdAt,
    });
    mindWorld(a.engine, id).setPlan(old(a.engine.now() - 10));
    expect(entry(a.engine, r.id).outcomes.planAfter).toBeUndefined();
    const b = createSimTestWorld({ config: ON, startAt: '10:00', restore: a.engine.toSaveData() });
    mindWorld(b.engine, id).setPlan(old(b.engine.now() - 10, 1));
    expect(entry(b.engine, r.id).outcomes.planAfter).toBeUndefined();
    // Made in the same minute as the nudge: counts (it is a different plan from the one at nudge time).
    mindWorld(b.engine, id).setPlan(old(entry(b.engine, r.id).tick, 2));
    expect(entry(b.engine, r.id).outcomes.planAfter).toMatchObject({ revision: 2 });
  });
});

describe('nudge with the real minds (mock provider)', () => {
  it('stores repeated and same-subject nudges, never rates them, never prompts the id or "nudge", and sets planAfter', async () => {
    const w = await createTestWorld({ config: ON, startAt: '10:00', villagers: 4 });
    const prompts: string[] = [];
    const chat = w.provider.chat.bind(w.provider);
    w.provider.chat = (req) => {
      prompts.push(`${req.task} ${JSON.stringify(req.messages)}`);
      return chat(req);
    };
    const id = dayPerson(w.engine as Engine);
    const engine = w.engine as Engine;
    const r1 = accepted(nudge(engine, id, 'I keep thinking about the pink house next door.'));
    // Same subject ("i keep") and then the very same text within the observation cooldown.
    const r2 = accepted(nudge(engine, id, 'I keep wondering whether Bo likes pie.'));
    const r3 = accepted(nudge(engine, id, 'I keep thinking about the pink house next door.'));
    const tagged = engine.memories(id).filter((m) => m.meta.influenceId);
    expect(tagged.map((m) => m.meta.influenceId)).toEqual([r1.id, r2.id, r3.id]);
    expect(tagged.every((m) => m.kind === 'observation' && m.importance === 3)).toBe(true);

    const planned = await w.until(() => entry(engine, r1.id).outcomes.planAfter !== undefined, 30 * 60);
    expect(planned).toBe(true);
    const after = entry(engine, r1.id).outcomes.planAfter!;
    expect(after.tick).toBeGreaterThanOrEqual(at(0, '10:00'));
    expect(['llm', 'fallback']).toContain(after.source);
    expect(entry(engine, r3.id).outcomes.planAfter).toEqual(after);

    // The thought itself does reach the next plan through retrieval, as a plain memory line.
    expect(prompts.some((p) => p.startsWith('plan.') && p.includes('pink house'))).toBe(true);
    for (const p of prompts) {
      expect(p).not.toMatch(/inf_\d/);
      expect(p.toLowerCase()).not.toContain('nudge');
      expect(p).not.toContain('influence');
    }
    expect(prompts.filter((p) => p.startsWith('importance.rate') && p.includes('pink house'))).toEqual([]);
  }, 60_000);
  it('does not credit a plan for tomorrow that was prepared before the nudge (published at bedtime or dawn)', async () => {
    const w = await createTestWorld({ config: ON, startAt: '15:00', villagers: 4 });
    const engine = w.engine as Engine;
    const id = dayPerson(engine);
    const mind = (
      engine as unknown as { runtimes: Map<VillagerId, { mind: { prepared: Map<number, DayPlan> } }> }
    ).runtimes.get(id)!.mind;
    const tomorrow = dayOf(w.now()) + 1;
    expect(await w.until(() => mind.prepared.has(tomorrow), 10 * 60)).toBe(true);
    const preparedAt = mind.prepared.get(tomorrow)!.createdAt;
    await w.advance(10);
    const nudgedAt = w.now();
    expect(isAwakeAt(w.profile(id), nudgedAt)).toBe(true);
    const r = accepted(nudge(engine, id, 'I keep thinking about the pink house next door.'));

    // Every plan the engine gets from now on.
    const plans: { tick: number; plan: DayPlan }[] = [];
    (
      engine as unknown as {
        bus: {
          on(e: 'plan.changed', f: (p: { villagerId: VillagerId; plan: DayPlan | null }) => void): void;
        };
      }
    ).bus.on('plan.changed', ({ villagerId, plan }) => {
      if (villagerId === id && plan) plans.push({ tick: w.now(), plan });
    });
    // Run past the publish of the prepared plan (bedtime, or dawn at the latest) and into tomorrow.
    await w.advanceTo(at(tomorrow, '12:00'), { chunk: 1 });
    expect(plans.some((p) => p.plan.day === tomorrow && p.plan.createdAt === preparedAt)).toBe(true);
    expect(preparedAt).toBeLessThan(nudgedAt);
    // The next plan actually made after the nudge (tomorrow evening's plan for the day after) counts.
    expect(await w.until(() => entry(engine, r.id).outcomes.planAfter !== undefined, MINUTES_PER_DAY)).toBe(
      true,
    );
    const after = entry(engine, r.id).outcomes.planAfter!;
    const credited = plans.find((p) => p.tick === after.tick && p.plan.revision === after.revision)!;
    expect(after.tick).toBeGreaterThanOrEqual(nudgedAt);
    expect(credited.plan.createdAt).toBeGreaterThanOrEqual(nudgedAt);
  }, 60_000);
});

describe('Mind.observe and influence observations (WP3)', () => {
  async function mindWorldReal() {
    const w = await createTestWorld({ config: ON, startAt: '10:00', villagers: 2 });
    const engine = w.engine as Engine;
    const id = dayPerson(engine);
    const texts = () => engine.memories(id).map((m) => m.text);
    return { engine, id, texts };
  }

  it('(a) stores an influence observation within the cooldown, even with the same text as an earlier one', async () => {
    const { engine, id, texts } = await mindWorldReal();
    const now = engine.now();
    engine.observe(id, { at: now, kind: 'observation', text: 'The bakery is busy.' });
    engine.observe(id, {
      at: now + 1,
      kind: 'observation',
      text: 'The bakery is busy.',
      importance: 3,
      meta: { influenceId: 'inf_1' },
    });
    expect(texts().filter((t) => t === 'The bakery is busy.')).toHaveLength(2);
  });

  it('(b) still drops a plain observation of the same subject right after an influence observation', async () => {
    const { engine, id, texts } = await mindWorldReal();
    const now = engine.now();
    engine.observe(id, {
      at: now,
      kind: 'observation',
      text: 'The bakery is busy.',
      importance: 3,
      meta: { influenceId: 'inf_1' },
    });
    engine.observe(id, { at: now + 1, kind: 'observation', text: 'The bakery is closed.' });
    expect(texts()).toContain('The bakery is busy.');
    expect(texts()).not.toContain('The bakery is closed.');
  });

  it('(c) the plain path is unchanged: same subject within the cooldown dropped, after it stored', async () => {
    const { engine, id, texts } = await mindWorldReal();
    const now = engine.now();
    engine.observe(id, { at: now, kind: 'observation', text: 'The bakery is busy.' });
    engine.observe(id, { at: now + 1, kind: 'observation', text: 'The bakery is closed.' });
    expect(texts()).not.toContain('The bakery is closed.');
    engine.observe(id, { at: now + 31, kind: 'observation', text: 'The bakery is closed.' });
    expect(texts()).toContain('The bakery is closed.');
    engine.observe(id, { at: now + 90, kind: 'observation', text: 'The bakery is closed.' });
    expect(texts().filter((t) => t === 'The bakery is closed.')).toHaveLength(1);
  });
});
