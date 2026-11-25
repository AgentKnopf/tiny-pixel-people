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
import {
  blockingWait,
  busySpin,
  cpuMax,
  startTiming,
  threadCpuMs,
  timeEach,
  wallMax,
  type Max,
  type Timing,
} from '../../helpers/cpu-meter.ts';

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
/** Runs of each A* query timed together: one query (1–2 ms) is below the CPU clock's resolution. */
const ASTAR_REPEATS = 10;

const readJson = (rel: string): unknown => JSON.parse(readFileSync(repoPath(rel), 'utf8'));
const bytes = (msg: unknown) => Buffer.byteLength(JSON.stringify(msg), 'utf8');

function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
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
  steps: Timing[];
  ticks: number[];
  hellos: number[];
  villagers: number;
  animals: number;
  wallMs: number;
  errors: string[];
}

/** Extra time inside one sim step: `busy` spins on the CPU, otherwise the thread blocks. */
interface SlowStep {
  step: number;
  ms: number;
  busy: boolean;
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
        if (day.steps.length === slow.step) (slow.busy ? busySpin : blockingWait)(slow.ms);
      };
    }
    let stop: (() => Timing) | null = null;
    const off = w.engine.onMessage((m) => {
      if (m.type !== 'tick') return;
      // The tick is emitted right after the synchronous step, before the LLM queue drains.
      if (stop) {
        day.steps.push(stop());
        stop = null;
      }
      day.ticks.push(bytes(m));
    });
    const end = at(0, '06:00') + minutes;
    const t0 = performance.now();
    while (w.now() < end) {
      stop = startTiming();
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

/**
 * The step max: CPU time within the budget, where Node can measure it. Wall time over the budget
 * fails only if a rerun of the day shows it too: a host pause passes, a thread that blocks fails.
 */
async function stepMaxProblems(
  first: readonly Timing[],
  rerun: () => Promise<readonly Timing[]>,
  onRerun: (wall: Max) => void = () => {},
): Promise<string[]> {
  const cpu = cpuMax(first);
  if (cpu.on === 'CPU' && cpu.max > BUDGET.stepMaxMs)
    return [`max ${cpu.max.toFixed(2)} ms CPU at step ${cpu.at}`];
  const w1 = wallMax(first);
  if (w1.max <= BUDGET.stepMaxMs) return [];
  const w2 = wallMax(await rerun());
  onRerun(w2);
  if (w2.max <= BUDGET.stepMaxMs) return [];
  return [
    `wall max ${w1.max.toFixed(2)} ms at step ${w1.at}, and ${w2.max.toFixed(2)} ms at step ${w2.at} in a rerun`,
  ];
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

    it(`keeps the sim step at p95 ≤ ${BUDGET.stepP95Ms} ms wall time and max ≤ ${BUDGET.stepMaxMs} ms`, async () => {
      const { steps } = day;
      expect(steps.length).toBeGreaterThanOrEqual(1440);
      const p95 = percentile(
        steps.map((s) => s.wall),
        95,
      );
      const cpu = cpuMax(steps);
      const wall = wallMax(steps);
      const cpuAtWallMax = steps[wall.at]!.cpu;
      console.info(
        `AC18 sim step: p95 ${p95.toFixed(2)} ms wall; max ${cpu.max.toFixed(2)} ms ${cpu.on} (step ${cpu.at} of ${steps.length}); ` +
          `wall max ${wall.max.toFixed(2)} ms (step ${wall.at}${cpuAtWallMax === null ? '' : `, ${cpuAtWallMax.toFixed(2)} ms CPU`}); first ${steps[0]!.wall.toFixed(2)} ms wall`,
      );
      expect(p95, `p95 ${p95.toFixed(2)} ms`).toBeLessThanOrEqual(BUDGET.stepP95Ms);
      const problems = await stepMaxProblems(
        steps,
        async () => (await mockDay()).steps,
        (w) => console.info(`AC18 sim step rerun: wall max ${w.max.toFixed(2)} ms (step ${w.at})`),
      );
      expect(problems, problems.join('; ')).toEqual([]);
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
    const pairs = Array.from({ length: ASTAR_PAIRS }, pair);
    expect(pairs.filter(([a, b]) => findPath(map, a, b) === null)).toEqual([]);
    const timeAll = () => pairs.map(([a, b]) => timeEach(() => findPath(map, a, b), ASTAR_REPEATS));
    let m = cpuMax(timeAll());
    console.info(
      `AC18 A*: worst ${m.max.toFixed(2)} ms ${m.on} over ${ASTAR_PAIRS} queries (each run ${ASTAR_REPEATS}×)`,
    );
    if (m.on === 'wall' && m.max > BUDGET.astarMs) {
      // Without CPU time a host pause cannot be told from slow work; a slow query shows up again.
      m = cpuMax(timeAll());
      console.info(`AC18 A* rerun: worst ${m.max.toFixed(2)} ms wall`);
    }
    expect(m.max, `worst ${m.max.toFixed(2)} ms ${m.on} (pair ${m.at})`).toBeLessThanOrEqual(BUDGET.astarMs);
  });

  describe('the meters', () => {
    // 10 ms over the budget: more than the CPU reading's error of one scheduler tick at either end.
    const SLOW = { step: 5, ms: BUDGET.stepMaxMs + 10 };
    const shortDay = async (slow?: SlowStep) => (await mockDay(10, slow)).steps;

    it('fail a step that spends too long on the CPU', async () => {
      const steps = await shortDay({ ...SLOW, busy: true });
      expect(cpuMax(steps).at).toBe(SLOW.step);
      expect(await stepMaxProblems(steps, () => shortDay({ ...SLOW, busy: true }))).not.toEqual([]);
    });

    it('fail a step that blocks the thread in the day and in the rerun', async () => {
      const steps = await shortDay({ ...SLOW, busy: false });
      expect(steps[SLOW.step]!.wall).toBeGreaterThanOrEqual(SLOW.ms);
      expect(await stepMaxProblems(steps, () => shortDay({ ...SLOW, busy: false }))).not.toEqual([]);
    });

    it.skipIf(!threadCpuMs)('pass a pause that does not come back in the rerun', async () => {
      const steps = await shortDay({ ...SLOW, busy: false });
      expect(steps[SLOW.step]!.cpu!).toBeLessThan(BUDGET.stepMaxMs);
      expect(await stepMaxProblems(steps, () => shortDay())).toEqual([]);
    });

    it('count CPU work inside a batch of A* queries', () => {
      const t = timeEach(() => busySpin(BUDGET.astarMs + 1), ASTAR_REPEATS);
      expect(cpuMax([t]).max).toBeGreaterThan(BUDGET.astarMs);
    });
  });
});
