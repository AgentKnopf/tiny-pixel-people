/** §14.1 Needs: decay over time, restoration by activity and sleep, override block when a need < 20. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Needs, VillagerState } from '../../src/shared/types.ts';
import { at } from '../../src/shared/time.ts';
import { ready, SIM_FEATURES, waitingFor } from '../helpers/features.ts';
import { createTestWorld, type TestWorld } from '../helpers/world.ts';

const FEATURES = [...SIM_FEATURES, 'needs'] as const;
const KEYS: (keyof Needs)[] = ['hunger', 'energy', 'social', 'fun'];
const FOOD = /eat|lunch|breakfast|dinner|bite|snack|food|meal|bread|coffee|cake/i;

describe.skipIf(!ready(...FEATURES))(`§14.1 needs${waitingFor(...FEATURES)}`, () => {
  let w: TestWorld;
  const series: { time: number; villagers: VillagerState[] }[] = [];

  beforeAll(async () => {
    w = await createTestWorld({ villagers: 10, startAt: '06:00' });
    await w.advanceTo(at(1, '06:00'), {
      chunk: 10,
      onStep: ({ time, snapshot }) => series.push({ time, villagers: structuredClone(snapshot().villagers) }),
    });
  }, 300_000);

  afterAll(() => w?.dispose());

  it('keeps every need within 0..100', () => {
    for (const s of series)
      for (const v of s.villagers)
        for (const k of KEYS) {
          expect(v.needs[k], `${v.id}.${k}`).toBeGreaterThanOrEqual(0);
          expect(v.needs[k], `${v.id}.${k}`).toBeLessThanOrEqual(100);
        }
  });

  it('decays and restores each need during the day', () => {
    for (const k of KEYS) {
      let down = 0;
      let up = 0;
      for (let i = 1; i < series.length; i++)
        for (const v of series[i]!.villagers) {
          const prev = series[i - 1]!.villagers.find((x) => x.id === v.id);
          if (!prev) continue;
          if (v.needs[k] < prev.needs[k]) down++;
          if (v.needs[k] > prev.needs[k]) up++;
        }
      expect(down, `${k} decays`).toBeGreaterThan(0);
      expect(up, `${k} restored`).toBeGreaterThan(0);
    }
  });

  it('restores energy overnight', () => {
    const evening = series.find((s) => s.time >= at(0, '23:00'))!;
    const morning = series.find((s) => s.time >= at(1, '05:00'))!;
    for (const v of morning.villagers) {
      const e = evening.villagers.find((x) => x.id === v.id)!;
      if (e.status === 'sleeping') expect(v.needs.energy, v.id).toBeGreaterThan(e.needs.energy);
    }
  });
});

describe.skipIf(!ready(...FEATURES))(`§14.1 needs override${waitingFor(...FEATURES)}`, () => {
  it('inserts a block to eat when hunger drops below 20', async () => {
    const w = await createTestWorld({
      villagers: 6,
      startAt: '06:00',
      config: { needs: { decayPerHour: { hunger: 45, energy: 4, social: 5, fun: 4 } } },
    });
    const hungrySince = new Map<string, number>();
    const fixed = new Set<string>();
    await w.advanceTo('13:00', {
      chunk: 2,
      onStep: ({ time, snapshot }) => {
        for (const v of snapshot().villagers) {
          if (v.status === 'sleeping') continue;
          if (v.needs.hunger < 20 && !hungrySince.has(v.id)) hungrySince.set(v.id, time);
          const since = hungrySince.get(v.id);
          if (since !== undefined && time - since <= 60 && FOOD.test(v.activity.text)) fixed.add(v.id);
        }
      },
    });
    w.dispose();
    expect(hungrySince.size).toBeGreaterThan(0);
    expect([...hungrySince.keys()].filter((id) => !fixed.has(id))).toEqual([]);
  }, 120_000);
});
