/** AC10: farm animals breed, produce, die of old age and go to the butcher; hard cap of 10 per species. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FARM_CAP_PER_SPECIES,
  FARM_SPECIES,
  type AnimalState,
  type FarmSpecies,
  type FarmState,
  type FoodStock,
  type GameMinutes,
  type VillagerProfile,
  type WorldMap,
} from '../../../src/shared/types.ts';
import { at, dayOf, minuteOfDay, parseClock } from '../../../src/shared/time.ts';
import type { AppConfig } from '../../../src/server/config.ts';
import type { AnimalChange } from '../../../src/server/sim/types.ts';
import { featurePath, readyV2, repoPath, waitingForV2, type Feature } from '../../helpers/features.ts';
import { animalCapProblems, farmCounts, hourlyInvariants } from '../../helpers/invariants.ts';
import { animalSimFactory, graphicWords, V2 } from '../../helpers/v2.ts';
import { setup } from '../../unit/player/fake-host.ts';
import { addV2Locations } from '../../unit/player/v2-fixtures.ts';
import { createTestWorld, testConfig, type TestWorld } from '../../helpers/world.ts';

const F: Feature[] = [...V2.farm];

/** Options passed to the AnimalSim factory of src/server/sim/animals.ts (see animalSimFactory). */
interface AnimalSimOptions {
  map: WorldMap;
  config: AppConfig;
  /** Seeds the animal RNG. */
  seed: number;
  /** Seeding time when not restoring. */
  now: GameMinutes;
  restore?: { animals: AnimalState[]; farm: FarmState };
  /** Burger stock at burger_joint, for the butcher rule (spec v2 §3.3). */
  burgerStock?: () => number;
  profiles?: readonly VillagerProfile[];
}

const DAYS = 60;
const SEED = 7;
const BURGERS: Record<FarmSpecies, number> = { cow: 4, sheep: 2, chicken: 2 };
const STOCK_CAP = 30;
const FARM_TOAST = /🐣|🕊️|🍔|butcher|hatched|born|passed away/i;

const readJson = (rel: string): unknown => JSON.parse(readFileSync(repoPath(rel), 'utf8'));
const burgers = (s: Readonly<FoodStock>) => s.burger_joint?.burger ?? 0;

interface UnitLog {
  capProblems: string[];
  births: Record<FarmSpecies, number>;
  oldAge: Record<FarmSpecies, number>;
  butcher: Record<FarmSpecies, number>;
  /** Products per game day: item -> count. */
  productsByDay: Map<number, Record<string, number>>;
  productTimes: Set<number>;
  burgerProblems: string[];
  butcherToasts: string[];
  toasts: string[];
}

const zero = (): Record<FarmSpecies, number> => ({ cow: 0, sheep: 0, chicken: 0 });

async function runUnit(): Promise<UnitLog> {
  const createAnimalSim = await animalSimFactory<AnimalSimOptions>();
  const config = testConfig({ villagers: 12, seed: SEED });
  const map = readJson(featurePath('villageMap')) as WorldMap;
  // The engine feeds AnimalSim changes to PlayerWorld.onAnimalChange and villager meals to
  // PlayerWorld.consumeFood; drive the same public entry points with WP8's in-memory host.
  const { host, pw } = setup();
  addV2Locations(host);
  const start = at(0, '06:00');
  host.time = start;
  const sim = createAnimalSim({
    map,
    config,
    seed: SEED,
    now: start,
    burgerStock: () => burgers(pw.farm.stock()),
  });
  let seenToasts = host.of('toast').length;  const log: UnitLog = {
    capProblems: [],
    births: zero(),
    oldAge: zero(),
    butcher: zero(),
    productsByDay: new Map(),
    productTimes: new Set(),
    burgerProblems: [],
    butcherToasts: [],
    toasts: [],
  };
  const cap = Math.min(config.farm.capPerSpecies, FARM_CAP_PER_SPECIES);
  const isFarm = (s: string): s is FarmSpecies => (FARM_SPECIES as readonly string[]).includes(s);
  for (let t = start + 1; t <= start + DAYS * 1440; t++) {
    const change: AnimalChange = sim.step(t, []);
    // Villagers eat at the burger joint twice a day, so the low-stock butcher rule also fires.
    const mod = minuteOfDay(t);
    if (mod === parseClock('12:30') || mod === parseClock('18:30')) pw.consumeFood('burger_joint', 'burger');
    const before = burgers(pw.farm.stock());
    host.time = t;
    pw.onAnimalChange(change);
    const after = burgers(pw.farm.stock());
    const all = host.of('toast');
    const toasts = all.slice(seenToasts).map((m) => m.text);
    seenToasts = all.length;
    log.toasts.push(...toasts);
    for (const a of change.added) if (a.group === 'farm' && isFarm(a.species)) log.births[a.species]++;
    let expectedBurgers = 0;
    for (const r of change.removed) {
      if (!isFarm(r.species)) continue;
      if (r.reason === 'oldAge') log.oldAge[r.species]++;
      if (r.reason === 'butcher') {
        log.butcher[r.species]++;
        expectedBurgers += BURGERS[r.species];
      }
    }
    if (expectedBurgers > 0) {
      const want = Math.min(STOCK_CAP, before + expectedBurgers);
      if (after !== want)
        log.burgerProblems.push(`day ${dayOf(t)}: burgers ${before} -> ${after}, expected ${want}`);
      log.butcherToasts.push(...toasts.filter((x) => /butcher/i.test(x)));
    }
    for (const p of change.produced) {
      const day = dayOf(t);
      const counts = log.productsByDay.get(day) ?? {};
      counts[p.itemId] = (counts[p.itemId] ?? 0) + p.count;
      log.productsByDay.set(day, counts);
      log.productTimes.add(minuteOfDay(t));
    }
    for (const s of FARM_SPECIES) {
      const n = sim.count(s);
      const listed = farmCounts(sim.all())[s] ?? 0;
      if (n > cap || listed > cap) log.capProblems.push(`day ${dayOf(t)} ${mod}: ${s} count ${n}/${listed}`);
      if (n !== listed) log.capProblems.push(`day ${dayOf(t)} ${mod}: ${s} count() ${n} != all() ${listed}`);
    }
  }
  return log;
}

describe.skipIf(!readyV2(...F))(`AC10: farm lifecycle${waitingForV2(...F)}`, () => {
  describe('AnimalSim unit (seeded, 60 game days in 1-minute steps)', () => {
    let log: UnitLog;
    beforeAll(async () => {
      log = await runUnit();
    }, 300_000);

    it('never has more than 10 alive per species at any step', () => {
      expect(log.capProblems.slice(0, 10)).toEqual([]);
    });

    it('has at least one birth, one old-age death and one butcher removal per species', () => {
      for (const s of FARM_SPECIES) {
        expect(log.births[s], `${s} births`).toBeGreaterThanOrEqual(1);
        expect(log.oldAge[s], `${s} old-age deaths`).toBeGreaterThanOrEqual(1);
        expect(log.butcher[s], `${s} butcher removals`).toBeGreaterThanOrEqual(1);
      }
    });

    it('produces daily at 07:00', () => {
      const missing: number[] = [];
      for (let d = 0; d < DAYS; d++) if (!log.productsByDay.has(d)) missing.push(d);
      expect(missing, 'days without products').toEqual([]);
      expect([...log.productTimes]).toEqual([parseClock('07:00')]);
      const totals: Record<string, number> = {};
      for (const counts of log.productsByDay.values())
        for (const [item, n] of Object.entries(counts)) totals[item] = (totals[item] ?? 0) + n;
      for (const item of ['milk', 'egg', 'wool']) expect(totals[item] ?? 0, item).toBeGreaterThan(0);
    });

    it('adds burger stock for each butcher removal and toasts without graphic words', () => {
      expect(log.burgerProblems.slice(0, 10)).toEqual([]);
      expect(log.butcherToasts.length).toBeGreaterThanOrEqual(1);
      const graphic = log.toasts.flatMap((t) => graphicWords(t).map((w) => `"${w}" in: ${t}`));
      expect(graphic).toEqual([]);
    });
  });

  describe('engine level, 5 default days', () => {
    let w: TestWorld;
    let inv: ReturnType<typeof hourlyInvariants>;
    const capProblems: string[] = [];

    beforeAll(async () => {
      w = await createTestWorld({ villagers: 12, seed: SEED, startAt: '06:00' });
      inv = hourlyInvariants(w.engine.map, {
        farmCap: w.config.farm.capPerSpecies,
        hotelRooms: w.config.hotel.rooms,
        maxNotices: w.config.post.maxNotices,
      });
      await w.advanceTo(at(5, '06:00'), {
        chunk: 1,
        onStep: (info) => {
          const snap = info.snapshot();
          capProblems.push(...animalCapProblems(snap, w.config.farm.capPerSpecies));
          inv.onStep({ time: info.time, snapshot: () => snap });
        },
      });
    }, 600_000);

    afterAll(() => w?.dispose());

    it('keeps the cap at every step and the world invariants every hour', () => {
      expect(capProblems.slice(0, 10)).toEqual([]);
      expect(inv.checks).toBeGreaterThanOrEqual(5 * 24);
      expect(inv.problems.slice(0, 10)).toEqual([]);
    });

    it('broadcasts farm changes and their toasts to clients, never graphic', () => {
      const changes = w.of('animals.changed');
      expect(changes.some((m) => m.added.some((a) => a.group === 'farm'))).toBe(true);
      const toasts = w.of('toast').map((t) => `${t.icon} ${t.text}`);
      expect(toasts.filter((t) => FARM_TOAST.test(t)).length).toBeGreaterThanOrEqual(1);
      expect(toasts.flatMap((t) => graphicWords(t))).toEqual([]);
      const butchered = changes.some((m) => m.removed.some((r) => r.reason === 'butcher'));
      if (butchered) {
        expect(toasts.some((t) => /butcher/i.test(t))).toBe(true);
        expect(w.of('stock.updated').some((m) => burgers(m.stock) > 0)).toBe(true);
      }
      expect(w.errors()).toEqual([]);
    });
  });

  describe('cap after loading a save with 10 cows', () => {
    let w: TestWorld;
    const counts: number[] = [];
    let cowBirths = 0;

    beforeAll(async () => {
      w = await createTestWorld({
        villagers: 12,
        seed: SEED,
        startAt: '05:00',
        patchSave: (save) => {
          const animals = save.animals ?? [];
          const cows = animals.filter((a) => a.species === 'cow');
          const template = cows.find((a) => a.stage === 'adult') ?? cows[0];
          if (!template) throw new Error('the save has no cows to copy');
          for (let i = 0; cows.length + i < FARM_CAP_PER_SPECIES; i++)
            animals.push({
              ...structuredClone(template),
              id: `cow_capfixture_${i}`,
              name: `Fixture ${i}`,
              sex: i % 2 === 0 ? 'female' : 'male',
              status: 'idle',
            });
          save.animals = animals;
          if (save.farm) save.farm.seeded = true;
        },
      });
      const before = farmCounts(w.state().animals ?? []).cow ?? 0;
      counts.push(before);
      await w.advanceTo(at(2, '05:00'), {
        chunk: 1,
        onStep: (info) => {
          counts.push(farmCounts(info.snapshot().animals ?? []).cow ?? 0);
        },
      });
      cowBirths = w
        .of('animals.changed')
        .flatMap((m) => m.added)
        .filter((a) => a.species === 'cow').length;
    }, 300_000);

    afterAll(() => w?.dispose());

    it('starts at the cap and never goes above it', () => {
      expect(counts[0]).toBe(FARM_CAP_PER_SPECIES);
      expect(Math.max(...counts)).toBeLessThanOrEqual(FARM_CAP_PER_SPECIES);
    });

    it('only breeds cows after one has left', () => {
      const removed = w
        .of('animals.changed')
        .flatMap((m) => m.removed)
        .filter((r) => r.species === 'cow').length;
      expect(cowBirths).toBeLessThanOrEqual(removed);
    });
  });
});
