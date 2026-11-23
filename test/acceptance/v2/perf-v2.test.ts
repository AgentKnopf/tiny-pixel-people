/** AC18: the §16 performance budgets (sim step, A*, tick and hello sizes, a full mock day). */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe.skipIf(!readyV2(...F))(`AC18: performance budgets${waitingForV2(...F)}`, () => {
  describe('one mock day with 20 villagers and the animals', () => {
    let w: TestWorld;
    const steps: number[] = [];
    const ticks: number[] = [];
    const hellos: number[] = [];
    let villagers = 0;
    let animals = 0;
    let wallMs = 0;

    beforeAll(async () => {
      const profiles = twentyProfiles();
      w = await createTestWorld({
        villagers: MAX_VILLAGERS,
        profiles,
        seed: 5,
        startAt: '06:00',
        config: { sim: { villagers: MAX_VILLAGERS } },
      });
      hellos.push(bytes(hello(w)));
      let stepStart = 0;
      const off = w.engine.onMessage((m) => {
        if (m.type !== 'tick') return;
        ticks.push(bytes(m));
        // The tick is emitted right after the synchronous step, before the LLM queue drains.
        if (stepStart > 0) {
          steps.push(performance.now() - stepStart);
          stepStart = 0;
        }
      });
      const end = at(1, '06:00');
      const t0 = performance.now();
      while (w.now() < end) {
        stepStart = performance.now();
        await w.engine.advance(1, { drainLlm: true, step: 1 });
        const snap = w.state();
        villagers = Math.max(villagers, snap.villagers.length);
        animals = Math.max(animals, snap.animals?.length ?? 0);
      }
      wallMs = performance.now() - t0;
      off();
      hellos.push(bytes(hello(w)));
    }, 600_000);

    afterAll(() => w?.dispose());

    it('runs 20 villagers and the animals', () => {
      expect(villagers).toBe(MAX_VILLAGERS);
      expect(animals).toBeGreaterThanOrEqual(50);
    });

    it(`keeps the sim step at p95 ≤ ${BUDGET.stepP95Ms} ms and max ≤ ${BUDGET.stepMaxMs} ms`, () => {
      expect(steps.length).toBeGreaterThanOrEqual(1440);
      const p95 = percentile(steps, 95);
      const max = Math.max(...steps);
      const worst = steps.indexOf(max);
      console.info(
        `AC18 sim step: p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms (step ${worst} of ${steps.length}), first ${steps[0]!.toFixed(2)} ms`,
      );
      expect(p95, `p95 ${p95.toFixed(2)} ms`).toBeLessThanOrEqual(BUDGET.stepP95Ms);
      expect(max, `max ${max.toFixed(2)} ms`).toBeLessThanOrEqual(BUDGET.stepMaxMs);
    });

    it(`keeps tick messages at p95 ≤ ${BUDGET.tickP95Bytes} bytes`, () => {
      const p95 = percentile(ticks, 95);
      expect(p95, `p95 ${p95} bytes, max ${Math.max(...ticks)}`).toBeLessThanOrEqual(BUDGET.tickP95Bytes);
    });

    it(`keeps the hello message ≤ ${BUDGET.helloBytes} bytes`, () => {
      for (const n of hellos) expect(n).toBeLessThanOrEqual(BUDGET.helloBytes);
    });

    it(`runs the full mock day in ≤ ${BUDGET.dayWallMs / 1000} s wall time`, () => {
      expect(wallMs, `${(wallMs / 1000).toFixed(1)} s`).toBeLessThanOrEqual(BUDGET.dayWallMs);
      expect(w.errors()).toEqual([]);
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
});
