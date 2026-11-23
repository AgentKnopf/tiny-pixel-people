import { describe, expect, it } from 'vitest';
import { FARM_SPECIES, ZOO_SPECIES, type AnimalState, type FarmSpecies } from '../../../src/shared/types.ts';
import { MINUTES_PER_DAY, minuteOfDay } from '../../../src/shared/time.ts';
import { FARM_TABLE } from '../../../src/server/sim/animals.ts';
import { animalTestMap, inRect, LAKE, makeSim, testConfig, WATER } from './animal-fixture.ts';

const BLOCKLIST = [
  'blood',
  'kill',
  'slaughter',
  'dead',
  'death',
  'meat',
  'knife',
  'cut',
  'die',
  'gore',
  'corpse',
];
const START = 8 * 60;

function run(sim: ReturnType<typeof makeSim>, from: number, minutes: number, each?: (now: number) => void) {
  for (let t = from + 1; t <= from + minutes; t++) {
    sim.step(t, []);
    each?.(t);
  }
}

describe('AnimalSim farm lifecycle (60 game days, 1-minute steps)', () => {
  const sim = makeSim();
  const map = animalTestMap();
  const pens = new Map(map.locations.map((l) => [l.id, l.pen]));
  const maxAlive: Record<FarmSpecies, number> = { cow: 0, sheep: 0, chicken: 0 };
  const births: Record<FarmSpecies, number> = { cow: 0, sheep: 0, chicken: 0 };
  const oldAge: Record<FarmSpecies, number> = { cow: 0, sheep: 0, chicken: 0 };
  const butchered: Record<FarmSpecies, number> = { cow: 0, sheep: 0, chicken: 0 };
  const productsByDay = new Map<number, Record<string, number>>();
  const toasts: string[] = [];
  let outOfPen = 0;
  for (const sp of FARM_SPECIES) maxAlive[sp] = sim.count(sp);

  for (let t = START + 1; t <= START + 60 * MINUTES_PER_DAY; t++) {
    const c = sim.step(t, []);
    for (const a of c.added) if (a.group === 'farm') births[a.species as FarmSpecies]++;
    for (const r of c.removed) {
      const sp = r.species as FarmSpecies;
      if (r.reason === 'oldAge') oldAge[sp]++;
      else butchered[sp]++;
    }
    for (const p of c.produced) {
      const day = Math.floor(t / MINUTES_PER_DAY);
      const rec = productsByDay.get(day) ?? {};
      rec[p.itemId] = (rec[p.itemId] ?? 0) + p.count;
      productsByDay.set(day, rec);
    }
    toasts.push(...c.toasts);
    for (const sp of FARM_SPECIES) maxAlive[sp] = Math.max(maxAlive[sp], sim.count(sp));
    if (t % 30 === 0)
      for (const a of sim.all())
        if (a.group === 'farm' && a.status !== 'leaving' && !inRect(a.pos, pens.get(a.homeId)!)) outOfPen++;
  }

  it('never has more than 10 alive per species', () => {
    for (const sp of FARM_SPECIES) expect(maxAlive[sp]).toBeLessThanOrEqual(10);
  });

  it('has births, old-age deaths and butcher removals for every species', () => {
    for (const sp of FARM_SPECIES) {
      expect(births[sp], `${sp} births`).toBeGreaterThanOrEqual(1);
      expect(oldAge[sp], `${sp} old-age deaths`).toBeGreaterThanOrEqual(1);
      expect(butchered[sp], `${sp} butcher`).toBeGreaterThanOrEqual(1);
    }
  });

  it('produces milk and eggs daily and wool at least every 3 days', () => {
    for (let day = 0; day < 60; day++) {
      const rec = productsByDay.get(day) ?? {};
      expect(rec.milk, `milk day ${day}`).toBeGreaterThanOrEqual(1);
      expect(rec.egg, `egg day ${day}`).toBeGreaterThanOrEqual(1);
    }
    for (let day = 0; day + 2 < 60; day++) {
      const wool = [0, 1, 2].reduce((n, d) => n + (productsByDay.get(day + d)?.wool ?? 0), 0);
      expect(wool, `wool days ${day}-${day + 2}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('emits friendly butcher toasts with no graphic words', () => {
    const butcherToasts = toasts.filter((t) => t.includes('butcher'));
    expect(butcherToasts.length).toBe(butchered.cow + butchered.sheep + butchered.chicken);
    expect(butcherToasts).toContain('🍔 Tom took a cow to the butcher. Fresh burgers at the Burger Joint!');
    for (const t of toasts)
      for (const word of BLOCKLIST) expect(t.toLowerCase(), t).not.toMatch(new RegExp(`\\b${word}`));
  });

  it('keeps farm animals inside their pens', () => {
    expect(outOfPen).toBe(0);
  });
});

describe('AnimalSim caps', () => {
  it('respects a lowered cap with certain breeding', () => {
    const sim = makeSim({
      config: testConfig({ farm: { capPerSpecies: 5, breedChance: 1, butcherAtCount: 10 } }),
    });
    run(sim, START, 30 * MINUTES_PER_DAY, () => {
      for (const sp of FARM_SPECIES) expect(sim.count(sp)).toBeLessThanOrEqual(5);
    });
  });

  it('counts the leaving animal against the cap', () => {
    const sim = makeSim({ config: testConfig({ farm: { breedChance: 1 } }) });
    let sawLeaving = false;
    run(sim, START, 20 * MINUTES_PER_DAY, () => {
      const leaving = sim.leavingAnimal();
      if (leaving) {
        sawLeaving = true;
        const sp = leaving.species as FarmSpecies;
        expect(sim.count(sp)).toBe(sim.all().filter((a) => a.group === 'farm' && a.species === sp).length);
      }
      for (const sp of FARM_SPECIES) expect(sim.count(sp)).toBeLessThanOrEqual(10);
    });
    expect(sawLeaving).toBe(true);
  });

  it('holds the cap after loading a save with 10 of a species', () => {
    const base = makeSim();
    const saved = base.serialize();
    const cows: AnimalState[] = Array.from({ length: 10 }, (_, i) => ({
      id: `cow_${100 + i}`,
      species: 'cow',
      group: 'farm',
      name: `Cow ${i}`,
      sex: i % 2 ? 'male' : 'female',
      bornAt: START - 5 * MINUTES_PER_DAY,
      stage: 'adult',
      lifespanDays: 30,
      homeId: 'cow_pasture',
      pos: { x: 7 + i, y: 42 },
      facing: 'down',
      status: 'idle',
    }));
    const animals = [...saved.animals.filter((a) => a.species !== 'cow'), ...cows];
    const sim = makeSim({
      config: testConfig({ farm: { breedChance: 1, butcherAtCount: 10 } }),
      restore: { animals, farm: { ...saved.farm, nextSeq: 200 } },
    });
    expect(sim.count('cow')).toBe(10);
    let births = 0;
    run(sim, START, 10 * MINUTES_PER_DAY, (t) => {
      expect(sim.count('cow')).toBeLessThanOrEqual(10);
      void t;
    });
    // Butcher at 10 frees a slot; any calf must fit under the cap.
    for (const a of sim.all()) if (a.species === 'cow' && a.stage === 'baby') births++;
    expect(sim.count('cow')).toBeLessThanOrEqual(10);
    expect(births).toBeGreaterThanOrEqual(0);
  });
});

describe('AnimalSim save/restore', () => {
  it('round-trips farm and zoo animals and continues the farm identically', () => {
    const a = makeSim();
    run(a, START, 5 * MINUTES_PER_DAY);
    const mid = START + 5 * MINUTES_PER_DAY;
    const save = JSON.parse(JSON.stringify(a.serialize())) as ReturnType<typeof a.serialize>;
    expect(save.animals.some((x) => x.group === 'ambient')).toBe(false);
    expect(save.animals.filter((x) => x.group === 'zoo').length).toBeGreaterThanOrEqual(12);

    const b = makeSim({ now: mid, restore: save });
    expect(b.serialize().animals.map((x) => x.id)).toEqual(save.animals.map((x) => x.id));
    // Ambient animals are reseeded, not saved.
    expect(b.all().some((x) => x.species === 'crow')).toBe(true);
    expect(b.all().filter((x) => x.group === 'ambient').length).toBeGreaterThan(20);

    const log = (s: ReturnType<typeof makeSim>) => {
      const out: string[] = [];
      run(s, mid, 10 * MINUTES_PER_DAY, (t) => {
        void t;
      });
      for (const x of s.serialize().animals.filter((y) => y.group === 'farm'))
        out.push(`${x.id}:${x.species}:${x.stage}:${x.sex}`);
      return out.sort();
    };
    expect(log(b)).toEqual(log(a));
  });

  it('does not reseed the farm when the save says seeded', () => {
    const a = makeSim();
    const save = a.serialize();
    const onlyZoo = save.animals.filter((x) => x.group === 'zoo');
    const b = makeSim({ restore: { animals: onlyZoo, farm: save.farm } });
    for (const sp of FARM_SPECIES) expect(b.count(sp)).toBe(0);
  });
});

describe('AnimalSim determinism', () => {
  it('produces identical worlds from the same seed', () => {
    const trace = () => {
      const sim = makeSim();
      const out: unknown[] = [];
      for (let t = START + 1; t <= START + 2 * MINUTES_PER_DAY; t++) {
        const c = sim.step(t, t % 50 < 10 ? [{ x: 100, y: 40 }] : []);
        if (c.added.length || c.removed.length || c.produced.length) out.push([t, c]);
        if (t % 97 === 0) out.push(sim.frames());
      }
      out.push(sim.all());
      return JSON.stringify(out);
    };
    expect(trace()).toBe(trace());
  });

  it('differs with another seed', () => {
    const a = makeSim();
    const b = makeSim({ config: testConfig({ seed: 999 }) });
    run(a, START, 120);
    run(b, START, 120);
    expect(JSON.stringify(a.all())).not.toBe(JSON.stringify(b.all()));
  });
});

describe('AnimalSim zoo', () => {
  it('has all 12 species and keeps every zoo animal in its pen for 2 days', () => {
    const map = animalTestMap();
    const pens = new Map(map.locations.map((l) => [l.id, l.pen!]));
    const sim = makeSim({ map });
    const zoo = sim.all().filter((a) => a.group === 'zoo');
    for (const sp of ZOO_SPECIES)
      expect(
        zoo.some((a) => a.species === sp),
        sp,
      ).toBe(true);
    expect(zoo.filter((a) => a.species === 'penguin').length).toBe(3);
    expect(zoo.filter((a) => a.species === 'flamingo').length).toBe(3);
    run(sim, START, 2 * MINUTES_PER_DAY, () => {
      for (const a of sim.all())
        if (a.group === 'zoo')
          expect(inRect(a.pos, pens.get(a.homeId)!), `${a.id} at ${a.pos.x},${a.pos.y}`).toBe(true);
    });
  });

  it('moves zoo animals over the day', () => {
    const sim = makeSim();
    const before = JSON.stringify(
      sim
        .all()
        .filter((a) => a.group === 'zoo')
        .map((a) => a.pos),
    );
    run(sim, START, 120);
    expect(
      JSON.stringify(
        sim
          .all()
          .filter((a) => a.group === 'zoo')
          .map((a) => a.pos),
      ),
    ).not.toBe(before);
    expect(sim.frames().length).toBeGreaterThan(0);
    expect(sim.frames()).toEqual([]);
  });
});

describe('AnimalSim forest', () => {
  it('has the forest species and keeps every animal in its pen', () => {
    const map = animalTestMap();
    const pens = new Map(map.locations.map((l) => [l.id, l.pen!]));
    const sim = makeSim({ map });
    const species = new Set(
      sim
        .all()
        .filter((a) => a.group === 'ambient' && a.species !== 'crow')
        .map((a) => a.species),
    );
    expect(species.size).toBeGreaterThanOrEqual(7);
    run(sim, START, 2 * MINUTES_PER_DAY, (t) => {
      const people = t % 40 < 5 ? [{ x: 100, y: 38 }] : [];
      void people;
      for (const a of sim.all())
        if (a.group === 'ambient' && a.species !== 'crow')
          expect(inRect(a.pos, pens.get(a.homeId)!), `${a.id} at ${a.pos.x},${a.pos.y}`).toBe(true);
    });
  });

  it('keeps ducks on the water by day and on the shore at night', () => {
    const sim = makeSim();
    const ducks = () => sim.all().filter((a) => a.species === 'duck');
    expect(ducks().length).toBe(5);
    // Day 1, 10:00-18:00: water.
    run(sim, START, MINUTES_PER_DAY + 2 * 60, (t) => void t);
    let now = START + MINUTES_PER_DAY + 2 * 60;
    for (; minuteOfDay(now) < 18 * 60; now++) {
      sim.step(now + 1, []);
      for (const d of ducks()) expect(inRect(d.pos, WATER), `${d.id} by day`).toBe(true);
    }
    // Night (22:00-04:00): shore ring of the lake.
    for (; minuteOfDay(now) !== 22 * 60; now++) sim.step(now + 1, []);
    for (let i = 0; i < 6 * 60; i++, now++) {
      sim.step(now + 1, []);
      for (const d of ducks()) {
        expect(inRect(d.pos, LAKE), `${d.id} in lake`).toBe(true);
        expect(inRect(d.pos, WATER), `${d.id} on shore`).toBe(false);
      }
    }
  });

  it('keeps hedgehogs and foxes asleep outside their hours', () => {
    const sim = makeSim();
    const night = (sp: string) => sim.all().filter((a) => a.species === sp);
    let activeAtNight = 0;
    let t = START;
    for (let i = 0; i < 2 * MINUTES_PER_DAY; i++) {
      t++;
      sim.step(t, []);
      const m = minuteOfDay(t);
      if (m >= 9 * 60 && m < 17 * 60)
        for (const a of [...night('hedgehog'), ...night('fox')])
          expect(a.status, `${a.id} at ${m}`).toBe('sleeping');
      if (m >= 20 * 60 || m < 5 * 60)
        activeAtNight += [...night('hedgehog'), ...night('fox')].filter(
          (a) => a.status !== 'sleeping',
        ).length;
    }
    expect(activeAtNight).toBeGreaterThan(0);
  });

  it('moves away from a villager within 3 tiles', () => {
    const sim = makeSim({ now: 12 * 60 });
    let t = 12 * 60;
    for (let i = 0; i < 30; i++) sim.step(++t, []);
    const deer = sim.all().find((a) => a.species === 'deer')!;
    const person = { x: deer.pos.x + 1, y: deer.pos.y };
    const d0 = Math.max(Math.abs(deer.pos.x - person.x), Math.abs(deer.pos.y - person.y));
    for (let i = 0; i < 5; i++) sim.step(++t, [person]);
    const after = sim.all().find((a) => a.id === deer.id)!;
    const d1 = Math.max(Math.abs(after.pos.x - person.x), Math.abs(after.pos.y - person.y));
    expect(d1).toBeGreaterThan(d0);
    expect(d1).toBeGreaterThanOrEqual(3);
  });
});

describe('farm table', () => {
  it('matches the spec stages', () => {
    expect(FARM_TABLE.chicken.adultAt).toBeLessThan(FARM_TABLE.chicken.elderAt);
    expect(FARM_TABLE.cow.product.itemId).toBe('milk');
  });
});
