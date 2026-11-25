/** AC18: the §16 performance budgets (sim step, A*, tick and hello sizes, a full mock day). */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type HelloMessage } from '../../../src/shared/protocol.ts';
import type { VillagerProfile, WorldMap } from '../../../src/shared/types.ts';
import { at } from '../../../src/shared/time.ts';
import { findPath } from '../../../src/server/sim/pathfinding.ts';
import { Rng } from '../../../src/server/sim/rng.ts';
import { MAX_VILLAGERS, toPublicProfile } from '../../../src/server/sim/engine.ts';
import { featurePath, readyV2, repoPath, waitingForV2, type Feature } from '../../helpers/features.ts';
import { V2 } from '../../helpers/v2.ts';
import { createTestWorld, type TestWorld } from '../../helpers/world.ts';

const F: Feature[] = [...new Set<Feature>([...V2.animals, ...V2.rides, 'train'])];

const BUDGET = {
  stepP95Ms: 4,
  stepMaxMs: 20,
  astarMs: 4,
  tickP95Bytes: 12 * 1024,
  helloBytes: 900 * 1024,
  dayWallMs: 60_000,
};
const ASTAR_PAIRS = 100;

const readJson = (rel: string): unknown => JSON.parse(readFileSync(repoPath(rel), 'utf8'));
const bytes = (msg: unknown) => Buffer.byteLength(JSON.stringify(msg), 'utf8');

function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
}

/**
 * CPU time of this thread in ms, or null before Node 22.19 / 23.9. The step max is gated on it
 * because wall time also counts time the OS or the hypervisor keeps the thread off the CPU (CPU
 * steal on cloud VMs), which stretches a 2 ms step to 20–30 ms now and then.
 */
const threadCpuMs: (() => number) | null =
  typeof process.threadCpuUsage === 'function'
    ? () => {
        const u = process.threadCpuUsage();
        return (u.user + u.system) / 1000;
      }
    : null;

interface StepSample {
  wall: number;
  /**
   * Thread CPU time, capped at the wall time; null where Node has no `process.threadCpuUsage`.
   * Linux updates a thread's CPU time only at scheduler ticks and switches, so one reading can be
   * off by one tick (4 ms at HZ=250); the cap keeps it from ever reading above the wall time.
   */
  cpu: number | null;
}

/** The step max on CPU time, or on wall time where CPU time is not available. */
function stepMax(steps: readonly StepSample[]): { max: number; step: number; on: 'CPU' | 'wall' } {
  const on = steps.every((s) => s.cpu !== null) ? 'CPU' : 'wall';
  const xs = steps.map((s) => (on === 'CPU' ? s.cpu! : s.wall));
  const max = Math.max(...xs);
  return { max, step: xs.indexOf(max), on };
}

/** The configured roster, topped up with copies (own ids, same homes) to MAX_VILLAGERS residents. */
function twentyProfiles(): VillagerProfile[] {
  const raw = readJson(featurePath('villagers')) as VillagerProfile[] | { villagers: VillagerProfile[] };
  const roster = (Array.isArray(raw) ? raw : raw.villagers).slice(0, MAX_VILLAGERS);
  const out = [...roster];
  for (let i = 0; out.length < MAX_VILLAGERS; i++) {
    const p = roster[i % roster.length]!;
    out.push({ ...p, id: `${p.id}_perf${i}`, name: `${p.name} ${i + 2}`, initialRelationships: {} });
  }
  return out;
}

function hello(w: TestWorld): HelloMessage {
  return {
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    map: w.engine.map,
    villagers: w.engine.profiles.map(toPublicProfile),
    snapshot: w.state(),
    llm: { provider: 'mock', model: w.config.llm.model, embeddings: 'mock-embed' },
    debug: w.config.debug,
  };
}

interface MockDay {
  steps: StepSample[];
  ticks: number[];
  hellos: number[];
  villagers: number;
  animals: number;
  wallMs: number;
  errors: string[];
}

/** Extra work inside one sim step: `busy` spins on the CPU, otherwise the thread sleeps. */
interface SlowStep {
  step: number;
  ms: number;
  busy: boolean;
}

function slowDown({ ms, busy }: SlowStep): void {
  if (!busy) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return;
  }
  const clock = threadCpuMs ?? (() => performance.now());
  const end = clock() + ms;
  while (clock() < end);
}

/** 20 villagers and the animals from 06:00, one game minute per step, for `minutes` steps. */
async function mockDay(minutes = 24 * 60, slow?: SlowStep): Promise<MockDay> {
  const w = await createTestWorld({
    villagers: MAX_VILLAGERS,
    profiles: twentyProfiles(),
    seed: 5,
    startAt: '06:00',
    config: { sim: { villagers: MAX_VILLAGERS } },
  });
  try {
    const day: MockDay = {
      steps: [],
      ticks: [],
      hellos: [bytes(hello(w))],
      villagers: 0,
      animals: 0,
      wallMs: 0,
      errors: [],
    };
    if (slow) {
      const engine = w.engine as unknown as { stepAnimals: () => void };
      const stepAnimals = engine.stepAnimals.bind(engine);
      engine.stepAnimals = () => {
        stepAnimals();
        if (day.steps.length === slow.step) slowDown(slow);
      };
    }
    let wall0 = 0;
    let cpu0 = 0;
    const off = w.engine.onMessage((m) => {
      if (m.type !== 'tick') return;
      // The tick is emitted right after the synchronous step, before the LLM queue drains.
      if (wall0 > 0) {
        const wall = performance.now() - wall0;
        const cpu = threadCpuMs ? Math.min(wall, threadCpuMs() - cpu0) : null;
        day.steps.push({ wall, cpu });
        wall0 = 0;
      }
      day.ticks.push(bytes(m));
    });
    const end = at(0, '06:00') + minutes;
    const t0 = performance.now();
    while (w.now() < end) {
      cpu0 = threadCpuMs?.() ?? 0;
      wall0 = performance.now();
      await w.engine.advance(1, { drainLlm: true, step: 1 });
      const snap = w.state();
      day.villagers = Math.max(day.villagers, snap.villagers.length);
      day.animals = Math.max(day.animals, snap.animals?.length ?? 0);
    }
    day.wallMs = performance.now() - t0;
    off();
    day.hellos.push(bytes(hello(w)));
    day.errors = w.errors();
    return day;
  } finally {
    w.dispose();
  }
}

describe.skipIf(!readyV2(...F))(`AC18: performance budgets${waitingForV2(...F)}`, () => {
  describe('one mock day with 20 villagers and the animals', () => {
    let day: MockDay;

    beforeAll(async () => {
      day = await mockDay();
    }, 600_000);

    it('runs 20 villagers and the animals', () => {
      expect(day.villagers).toBe(MAX_VILLAGERS);
      expect(day.animals).toBeGreaterThanOrEqual(50);
    });

    it(`keeps the sim step at p95 ≤ ${BUDGET.stepP95Ms} ms wall time and max ≤ ${BUDGET.stepMaxMs} ms CPU time`, async () => {
      const { steps } = day;
      expect(steps.length).toBeGreaterThanOrEqual(1440);
      const walls = steps.map((s) => s.wall);
      const p95 = percentile(walls, 95);
      const wallMax = Math.max(...walls);
      const wallAt = walls.indexOf(wallMax);
      const cpuAt = steps[wallAt]!.cpu;
      let m = stepMax(steps);
      console.info(
        `AC18 sim step: p95 ${p95.toFixed(2)} ms wall; max ${m.max.toFixed(2)} ms ${m.on} (step ${m.step} of ${steps.length}); ` +
          `wall max ${wallMax.toFixed(2)} ms (step ${wallAt}${cpuAt === null ? '' : `, ${cpuAt.toFixed(2)} ms CPU`}); first ${steps[0]!.wall.toFixed(2)} ms wall`,
      );
      expect(p95, `p95 ${p95.toFixed(2)} ms`).toBeLessThanOrEqual(BUDGET.stepP95Ms);
      if (m.on === 'wall' && m.max > BUDGET.stepMaxMs) {
        // Without CPU time a stall cannot be told from slow work; a real slow step shows up again.
        m = stepMax((await mockDay()).steps);
        console.info(`AC18 sim step rerun: max ${m.max.toFixed(2)} ms wall (step ${m.step})`);
      }
      expect(m.max, `max ${m.max.toFixed(2)} ms ${m.on} at step ${m.step}`).toBeLessThanOrEqual(
        BUDGET.stepMaxMs,
      );
    }, 120_000);

    it(`keeps tick messages at p95 ≤ ${BUDGET.tickP95Bytes} bytes`, () => {
      const p95 = percentile(day.ticks, 95);
      expect(p95, `p95 ${p95} bytes, max ${Math.max(...day.ticks)}`).toBeLessThanOrEqual(BUDGET.tickP95Bytes);
    });

    it(`keeps the hello message ≤ ${BUDGET.helloBytes} bytes`, () => {
      for (const n of day.hellos) expect(n).toBeLessThanOrEqual(BUDGET.helloBytes);
    });

    it(`runs the full mock day in ≤ ${BUDGET.dayWallMs / 1000} s wall time`, () => {
      expect(day.wallMs, `${(day.wallMs / 1000).toFixed(1)} s`).toBeLessThanOrEqual(BUDGET.dayWallMs);
      expect(day.errors).toEqual([]);
    });
  });

  it(`answers A* across the map in ≤ ${BUDGET.astarMs} ms per query (${ASTAR_PAIRS} random entry pairs)`, () => {
    const map = readJson(featurePath('villageMap')) as WorldMap;
    const entries = map.locations.map((l) => l.entry);
    const rng = new Rng(1234);
    const pair = () => [rng.pick(entries)!, rng.pick(entries)!] as const;
    for (let i = 0; i < 20; i++) findPath(map, ...pair());
    const times: number[] = [];
    let unreachable = 0;
    for (let i = 0; i < ASTAR_PAIRS; i++) {
      const [a, b] = pair();
      const t0 = performance.now();
      const path = findPath(map, a, b);
      times.push(performance.now() - t0);
      if (path === null) unreachable++;
    }
    expect(unreachable).toBe(0);
    const max = Math.max(...times);
    console.info(`AC18 A*: worst ${max.toFixed(2)} ms over ${ASTAR_PAIRS} queries`);
    expect(max, `worst ${max.toFixed(2)} ms`).toBeLessThanOrEqual(BUDGET.astarMs);
  });

  describe('the step meter', () => {
    // 10 ms over the budget: more than the CPU reading's error of one scheduler tick at either end.
    const SLOW = { step: 5, ms: BUDGET.stepMaxMs + 10 };

    it('counts CPU work inside a step against the max', async () => {
      const { steps } = await mockDay(10, { ...SLOW, busy: true });
      const m = stepMax(steps);
      expect(m.step).toBe(SLOW.step);
      expect(m.max).toBeGreaterThan(BUDGET.stepMaxMs);
    });

    it.skipIf(!threadCpuMs)('does not count time the thread spends off the CPU', async () => {
      const { steps } = await mockDay(10, { ...SLOW, busy: false });
      const s = steps[SLOW.step]!;
      expect(s.wall).toBeGreaterThanOrEqual(SLOW.ms);
      expect(s.cpu!).toBeLessThan(BUDGET.stepMaxMs);
    });
  });
});
