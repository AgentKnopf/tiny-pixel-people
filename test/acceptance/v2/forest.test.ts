/** AC26: the forest with a grove, a lake and small animals. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FOREST_SPECIES,
  type AnimalState,
  type FarmState,
  type ForestSpecies,
  type GameMinutes,
  type Memory,
  type Point,
  type Rect,
  type WorldMap,
  type WorldSnapshot,
} from '../../../src/shared/types.ts';
import { at, minuteOfDay, parseClock } from '../../../src/shared/time.ts';
import type { AppConfig } from '../../../src/server/config.ts';
import { featurePath, readyV2, repoPath, waitingForV2, type Feature } from '../../helpers/features.ts';
import { animalPenProblems, walkable } from '../../helpers/invariants.ts';
import { animalSimFactory, dist, loc, V2 } from '../../helpers/v2.ts';
import { createTestWorld, testConfig, type TestWorld } from '../../helpers/world.ts';

const F: Feature[] = [...V2.animals];

/** `AnimalSimOptions` of src/server/sim/animals.ts; the RNG seed comes from `config.sim.seed`. */
interface AnimalSimOptions {
  map: WorldMap;
  config: AppConfig;
  now: GameMinutes;
  restore?: { animals: AnimalState[]; farm: FarmState };
  burgerStock?: () => number;
}

const SEED = 17;
const COUNTS: Record<ForestSpecies, number> = {
  deer: 3,
  rabbit: 5,
  squirrel: 4,
  hedgehog: 2,
  fox: 2,
  bird: 6,
  duck: 5,
};
/** Inactive windows [from, until) in minutes of day, from the §3.5 active hours. */
const RESTING: Partial<Record<ForestSpecies, [number, number]>> = {
  hedgehog: [parseClock('06:00'), parseClock('19:00')],
  fox: [parseClock('07:00'), parseClock('18:00')],
};
const SLACK = 5;
const FOREST_LOCATIONS = ['forest', 'forest_grove', 'forest_lake'];
const ANIMAL_WORDS = /\b(deer|rabbits?|squirrels?|hedgehogs?|fox(es)?|birds?|ducks?)\b/i;

const readJson = (rel: string): unknown => JSON.parse(readFileSync(repoPath(rel), 'utf8'));
const isForest = (a: AnimalState) =>
  a.group === 'ambient' && (FOREST_SPECIES as readonly string[]).includes(a.species);
const forestAnimals = (s: WorldSnapshot) => (s.animals ?? []).filter(isForest);
const inRect = (p: Point, r: Rect) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
const rectInside = (a: Rect, b: Rect) =>
  a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
const tile = (p: Point) => ({ x: Math.round(p.x), y: Math.round(p.y) });

function within(m: number, [from, until]: [number, number]): boolean {
  return m >= from + SLACK && m < until;
}

describe.skipIf(!readyV2(...F))(`AC26: the forest${waitingForV2(...F)}`, () => {
  it('has forest, forest_grove and forest_lake in the forest district, with blocked water and a walkable shore', () => {
    const m = readJson(featurePath('villageMap')) as WorldMap;
    const district = m.districts?.find((d) => d.id === 'forest');
    expect(district).toBeDefined();
    for (const id of FOREST_LOCATIONS) {
      const l = loc(m, id);
      expect(l.kind, id).toBe('nature');
      expect(rectInside(l.area, district!.rect), `${id} inside the forest`).toBe(true);
      if (l.district) expect(l.district, id).toBe('forest');
    }
    expect(loc(m, 'forest').pen, 'forest pen').toBeDefined();
    const grove = loc(m, 'forest_grove');
    expect((grove.spots ?? []).filter((p) => walkable(m, p)).length, 'grove spots').toBeGreaterThanOrEqual(3);
    const lake = loc(m, 'forest_lake');
    expect(lake.pen, 'lake pen').toBeDefined();
    let water = 0;
    for (let y = lake.area.y; y < lake.area.y + lake.area.h; y++)
      for (let x = lake.area.x; x < lake.area.x + lake.area.w; x++) if (!walkable(m, { x, y })) water++;
    expect(water, 'blocked water tiles').toBeGreaterThanOrEqual(12);
    const shore = (lake.spots ?? []).filter((p) => walkable(m, p));
    expect(shore.length, 'walkable shore spots').toBeGreaterThanOrEqual(3);
  });

  describe('3 default days', () => {
    let w: TestWorld;
    let first: WorldSnapshot;
    const penProblems: string[] = [];
    const duckProblems: string[] = [];
    const restProblems: string[] = [];
    const activeSeen = new Set<string>();
    const visitedForest = new Set<string>();
    let observations: Memory[] = [];

    beforeAll(async () => {
      w = await createTestWorld({ villagers: 12, seed: SEED, startAt: '06:00' });
      first = w.state();
      const map = w.engine.map;
      const lake = loc(map, 'forest_lake');
      const prev = new Map<string, Point>();
      const forestIds = new Set(FOREST_LOCATIONS);
      await w.advanceTo(at(3, '06:00'), {
        chunk: 1,
        onStep: ({ time, snapshot }) => {
          const snap = snapshot();
          const animals = forestAnimals(snap);
          penProblems.push(...animalPenProblems({ ...snap, animals }, map));
          const occupants = [snap.player.pos, ...snap.villagers.map((v) => v.pos)];
          for (const v of snap.villagers)
            if (v.locationId && forestIds.has(v.locationId)) visitedForest.add(v.id);
          const mod = minuteOfDay(time);
          for (const a of animals) {
            const window = RESTING[a.species as ForestSpecies];
            const before = prev.get(a.id);
            const moved = before !== undefined && (before.x !== a.pos.x || before.y !== a.pos.y);
            if (window) {
              if (within(mod, window)) {
                const disturbed = occupants.some(
                  (p) => dist(p, a.pos) <= 4 || (before && dist(p, before) <= 4),
                );
                if (a.status !== 'sleeping')
                  restProblems.push(`${time} ${a.id} ${a.status} outside its hours`);
                else if (moved && !disturbed) restProblems.push(`${time} ${a.id} moved while resting`);
              } else if (moved || a.status !== 'sleeping') activeSeen.add(a.id);
            }
            prev.set(a.id, { ...a.pos });
            if (a.species === 'duck' && mod % 60 === 0) {
              const onWater = inRect(tile(a.pos), lake.area) && !walkable(map, a.pos);
              const hour = mod / 60;
              if (hour >= 10 && hour <= 16 && !onWater)
                duckProblems.push(`${time} ${a.id} not on the water by day`);
              if ((hour >= 23 || hour <= 4) && onWater)
                duckProblems.push(`${time} ${a.id} on the water at night`);
            }
          }
        },
      });
      observations = w
        .state()
        .villagers.flatMap((v) => w.memories(v.id))
        .filter((m) => m.kind === 'observation' && ANIMAL_WORDS.test(m.text) && m.importance === 2);
    }, 600_000);

    afterAll(() => w?.dispose());

    it('has the 7 forest species with their §3.5 counts', () => {
      const animals = forestAnimals(first);
      for (const species of FOREST_SPECIES) {
        const here = animals.filter((a) => a.species === species);
        expect(here.length, species).toBe(COUNTS[species]);
        for (const a of here) expect(a.homeId, a.id).toBe(species === 'duck' ? 'forest_lake' : 'forest');
      }
    });

    it('keeps every forest animal inside its pen at every step', () => {
      expect(penProblems.slice(0, 10), `${penProblems.length} problems`).toEqual([]);
    });

    it('keeps ducks on the water by day and on the shore at night', () => {
      expect(duckProblems.slice(0, 10), `${duckProblems.length} problems`).toEqual([]);
    });

    it('keeps hedgehogs and foxes resting outside their hours and active within them', () => {
      expect(restProblems.slice(0, 10), `${restProblems.length} problems`).toEqual([]);
      const nocturnal = forestAnimals(first).filter((a) => a.species === 'hedgehog' || a.species === 'fox');
      for (const a of nocturnal) expect(activeSeen.has(a.id), `${a.id} active at night`).toBe(true);
    });

    it('gives a villager in the forest an animal observation without importance.rate', () => {
      expect(visitedForest.size, 'villagers who went to the forest').toBeGreaterThanOrEqual(1);
      const observers = new Set(observations.map((m) => m.villagerId));
      expect(
        [...visitedForest].some((id) => observers.has(id)),
        'a forest visitor saw an animal',
      ).toBe(true);
      const texts = new Set(observations.map((m) => m.text));
      const rated = w.provider.calls
        .filter((c) => c.task === 'importance.rate')
        .flatMap((c) => (Array.isArray(c.meta?.memories) ? (c.meta.memories as unknown[]) : []))
        .map((m) => (typeof m === 'object' && m !== null && 'text' in m ? String(m.text) : ''))
        .filter((t) => texts.has(t));
      expect(rated).toEqual([]);
      expect(w.errors()).toEqual([]);
    });
  });

  describe('AnimalSim unit: shy animals', () => {
    it('moves an animal away from someone within 3 tiles, at most 4 steps, inside its pen', async () => {
      const createAnimalSim = await animalSimFactory<AnimalSimOptions>();
      const config = testConfig({ villagers: 12, seed: SEED });
      const map = readJson(featurePath('villageMap')) as WorldMap;
      const noon = at(0, '12:00');
      let tested = 0;
      for (const species of ['deer', 'rabbit', 'squirrel'] as const) {
        const sim = createAnimalSim({ map, config, now: noon });
        sim.step(noon + 1, []);
        const a = sim.all().find((x) => x.species === species && x.status !== 'sleeping');
        if (!a) continue;
        const start = { ...a.pos };
        const candidates = [
          { x: start.x + 2, y: start.y },
          { x: start.x - 2, y: start.y },
          { x: start.x, y: start.y + 2 },
          { x: start.x, y: start.y - 2 },
        ];
        const occupant = candidates.find((p) => walkable(map, p)) ?? candidates[0]!;
        const before = dist(start, occupant);
        sim.step(noon + 2, [occupant]);
        sim.step(noon + 3, [occupant]);
        const after = sim.all().find((x) => x.id === a.id)!;
        const pen = loc(map, a.homeId).pen ?? loc(map, a.homeId).area;
        expect(dist(after.pos, occupant), `${a.id} distance from the occupant`).toBeGreaterThan(before);
        expect(
          Math.abs(after.pos.x - start.x) + Math.abs(after.pos.y - start.y),
          `${a.id} steps`,
        ).toBeLessThanOrEqual(4);
        expect(inRect(tile(after.pos), pen), `${a.id} in its pen`).toBe(true);
        tested++;
      }
      expect(tested, 'awake forest animals at noon').toBeGreaterThanOrEqual(1);
    });
  });
});
