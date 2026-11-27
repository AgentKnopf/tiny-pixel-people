/** Soft wake: the one-time start-up warm-up (zero-length ticks before the clock first moves). */
import { afterEach, describe, expect, it } from 'vitest';
import { createMind } from '../../src/server/cognition/mind.ts';
import type { CreateMind } from '../../src/server/cognition/types.ts';
import { MockChatProvider } from '../../src/server/llm/providers/mock.ts';
import { createSimEngine, type Engine } from '../../src/server/sim/engine.ts';
import { StubMind } from '../../src/server/sim/stub-mind.ts';
import type { WorldView } from '../../src/server/cognition/types.ts';
import { createSimTestWorld } from '../helpers/sim.ts';

const VILLAGERS = 10;
/** WAKE_UP_THINK_BATCH (2) minds per zero-length tick. */
const WARM_UP_TICKS = VILLAGERS / 2;

let updates: string[] = [];
let busyFirstUpdateMs = 0;
const seen = new Set<string>();

class Counting extends StubMind {
  override update(view: WorldView) {
    updates.push(this.id);
    if (busyFirstUpdateMs > 0 && !seen.has(this.id)) {
      const until = performance.now() + busyFirstUpdateMs;
      while (performance.now() < until);
    }
    seen.add(this.id);
    return super.update(view);
  }
}
const counting: CreateMind = (profile, deps) => new Counting(profile, deps);

interface Tick {
  at: number;
  minds: string[];
  needs: string;
}

function world(startAt: string, wakeUpMode: 'soft' | 'hold' = 'soft') {
  const { engine } = createSimTestWorld({
    startAt,
    createMind: counting,
    config: { sim: { villagers: VILLAGERS, wakeUpMode, tickMs: 20 } },
  });
  return { engine, ticks: record(engine) };
}

function record(engine: Engine): Tick[] {
  const ticks: Tick[] = [];
  engine.onMessage((m) => {
    if (m.type !== 'tick') return;
    const needs = JSON.stringify(engine.snapshot().villagers.map((v) => v.needs));
    ticks.push({ at: engine.now(), minds: updates, needs });
    updates = [];
  });
  return ticks;
}

/** Ticks whose game time equals the one before (or the start time, for the first). */
const zeroLength = (ticks: Tick[], start: number) =>
  ticks.filter((t, i) => t.at === (i === 0 ? start : ticks[i - 1]!.at)).length;

let running: Engine | undefined;
afterEach(() => {
  running?.stop();
  running = undefined;
  updates = [];
  busyFirstUpdateMs = 0;
  seen.clear();
});

describe('soft wake start-up warm-up', () => {
  it('moves no game time: clock, needs, step events and autosave stay put', async () => {
    const { engine, ticks } = world('06:00');
    const start = engine.now();
    const needs0 = JSON.stringify(engine.snapshot().villagers.map((v) => v.needs));
    let stepEvents = 0;
    engine.bus.on('step', () => stepEvents++);
    const autosave = (engine as unknown as { autosaver: { tick: (t: number) => void } }).autosaver;
    const tick = autosave.tick.bind(autosave);
    let autosaveTicks = 0;
    autosave.tick = (t) => {
      autosaveTicks++;
      tick(t);
    };
    await engine.advance(3);
    const warm = ticks.slice(0, WARM_UP_TICKS);
    expect(warm.map((t) => t.at)).toEqual(Array(WARM_UP_TICKS).fill(start));
    expect(warm.every((t) => t.needs === needs0)).toBe(true);
    expect(ticks.slice(WARM_UP_TICKS).map((t) => t.at)).toEqual([start + 1, start + 2, start + 3]);
    expect(engine.now()).toBe(start + 3);
    expect(stepEvents).toBe(3);
    expect(autosaveTicks).toBe(3);
  });

  it('runs each mind once during the warm-up, then everyone once per step', async () => {
    const { engine, ticks } = world('06:00');
    await engine.advance(2);
    const warm = ticks.slice(0, WARM_UP_TICKS).flatMap((t) => t.minds);
    expect(warm).toHaveLength(VILLAGERS);
    expect(new Set(warm).size).toBe(VILLAGERS);
    expect(ticks.slice(WARM_UP_TICKS).map((t) => t.minds.length)).toEqual([VILLAGERS, VILLAGERS]);
  });

  it('happens once per engine: never again at a later dawn, even with plans pending', async () => {
    class Unsettled extends Counting {
      isPlanSettled(): boolean {
        return false;
      }
    }
    const { engine } = createSimTestWorld({
      startAt: '05:00',
      createMind: (p, d) => new Unsettled(p, d),
      config: { sim: { villagers: VILLAGERS, wakeUpMode: 'soft' } },
    });
    const ticks = record(engine);
    const start = engine.now();
    await engine.advance(2 * 24 * 60 + 120, { step: 5 });
    expect(zeroLength(ticks, start)).toBe(WARM_UP_TICKS);
    expect(ticks.slice(0, WARM_UP_TICKS).every((t) => t.at === start)).toBe(true);
  }, 20_000);

  it('a restored engine warms up once at load', async () => {
    const { engine: first } = world('06:00');
    await first.advance(90);
    const save = first.toSaveData();
    first.stop();
    const engine = createSimEngine({
      config: first.config,
      providers: { chat: new MockChatProvider(), embeddings: null },
      createMind: counting,
      restore: save,
    });
    const ticks = record(engine);
    const start = engine.now();
    await engine.advance(24 * 60, { step: 5 });
    expect(zeroLength(ticks, start)).toBe(WARM_UP_TICKS);
    expect(ticks.slice(0, WARM_UP_TICKS).every((t) => t.at === start)).toBe(true);
  }, 20_000);

  it('hold mode has no start-up warm-up', async () => {
    const { engine, ticks } = world('10:00', 'hold');
    const start = engine.now();
    await engine.advance(3);
    expect(ticks.map((t) => t.at)).toEqual([start + 1, start + 2, start + 3]);
    expect(ticks[0]!.minds).toHaveLength(VILLAGERS);
  });

  it('real minds: one day-plan request per resident across the warm-up and the first steps', async () => {
    const chat = new MockChatProvider('mock');
    const asked = new Map<string, number>();
    chat.setLatency((req) => {
      if (req.task === 'plan.day') {
        const id = String(req.meta?.villagerId ?? '');
        asked.set(id, (asked.get(id) ?? 0) + 1);
      }
      return 0;
    });
    const { engine } = createSimTestWorld({
      startAt: '06:00',
      createMind,
      providers: { chat, embeddings: null },
      config: { sim: { villagers: VILLAGERS, wakeUpMode: 'soft' } },
    });
    await engine.advance(5, { drainLlm: true });
    expect(asked.size).toBe(VILLAGERS);
    expect([...asked.values()].every((n) => n === 1)).toBe(true);
    expect(engine.planStatus()).toEqual({ ready: VILLAGERS, total: VILLAGERS });
  });

  it('real time: the paused time is not caught up, and later minutes map to real time from its end', async () => {
    busyFirstUpdateMs = 50;
    const { engine, ticks } = world('06:00');
    running = engine;
    const start = engine.now();
    engine.start();
    const deadline = Date.now() + 5000;
    while (!ticks.some((t) => t.at > start) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    const warmEndMs = Date.now();
    const first = ticks.find((t) => t.at > start)!;
    expect(zeroLength(ticks, start)).toBe(WARM_UP_TICKS);
    // One 20 ms tick is 0.032 game minutes at a 15-minute day; the ~500 ms warm-up would be 0.8.
    expect(first.at - start).toBeLessThan(0.2);
    await new Promise((r) => setTimeout(r, 1500));
    expect(engine.townLog.msOf(start + 0.1)).toBeGreaterThanOrEqual(warmEndMs - 40);
  });
});
