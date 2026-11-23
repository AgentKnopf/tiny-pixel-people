import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/server/config.ts';
import { NEED_LOW, initialNeeds, updateNeeds, urgentNeedFix } from '../../src/server/sim/needs.ts';
import { SimClock } from '../../src/server/sim/clock.ts';
import { loadMap } from '../../src/server/sim/world.ts';
import { createSimTestWorld } from '../helpers/sim.ts';

const decay = DEFAULT_CONFIG.needs.decayPerHour;
const locations = loadMap().locations;

describe('needs', () => {
  it('decays per game hour and restores energy while sleeping', () => {
    const n = initialNeeds();
    updateNeeds(n, { status: 'walking', activity: 'walking to the park', location: null }, 60, decay);
    expect(n.hunger).toBeCloseTo(80 - decay.hunger);
    expect(n.fun).toBeCloseTo(70 - decay.fun);
    const tired = { ...initialNeeds(), energy: 10 };
    updateNeeds(tired, { status: 'sleeping', activity: 'sleeping', location: null }, 120, decay);
    expect(tired.energy).toBeCloseTo(34);
  });

  it('restores needs by activity keywords and location', () => {
    const n = { hunger: 30, energy: 50, social: 50, fun: 30 };
    const bakery = locations.find((l) => l.id === 'bakery')!;
    updateNeeds(n, { status: 'acting', activity: 'have lunch', location: bakery }, 60, decay);
    expect(n.hunger).toBeGreaterThan(60);
    const park = locations.find((l) => l.id === 'park')!;
    updateNeeds(
      n,
      { status: 'acting', activity: 'take an evening stroll in the park', location: park },
      60,
      decay,
    );
    expect(n.fun).toBeGreaterThan(40);
  });

  it('overrides the block when a need drops below the threshold', () => {
    const needs = { hunger: NEED_LOW - 5, energy: 80, social: 80, fun: 80 };
    const fix = urgentNeedFix(
      needs,
      { activity: 'mind the store', locationId: 'shop' },
      locations,
      'house_01',
    );
    expect(fix).toMatchObject({ need: 'hunger', locationId: 'bakery' });
    expect(
      urgentNeedFix(needs, { activity: 'have lunch', locationId: 'bakery' }, locations, 'house_01'),
    ).toBeNull();
  });

  it('sends a hungry villager to the nearest open food place, or home when that is closer', () => {
    const needs = { hunger: NEED_LOW - 5, energy: 80, social: 80, fun: 80 };
    const burger = locations.find((l) => l.id === 'burger_joint')!;
    const block = { activity: 'look around', locationId: 'hotel' };
    const noon = 12 * 60;
    expect(
      urgentNeedFix(needs, block, locations, 'hotel', { pos: burger.entry, minute: noon }),
    ).toMatchObject({
      locationId: 'burger_joint',
      activity: expect.stringMatching(/bite/),
    });
    // The zoo food is closed at night; the hotel guest eats a snack in their room instead.
    const night = urgentNeedFix(needs, block, locations, 'hotel', { pos: burger.entry, minute: 23 * 60 });
    expect(night?.locationId).not.toBe('burger_joint');
    const home = locations.find((l) => l.id === 'house_01')!;
    expect(
      urgentNeedFix(needs, block, locations, 'house_01', { pos: home.entry, minute: noon })?.locationId,
    ).toBe('house_01');
  });

  it('sends a hungry villager to the bakery in the sim', async () => {
    const { engine } = createSimTestWorld({ startAt: '09:00', config: { sim: { villagers: 10 } } });
    const tom = engine.villager('tom')!;
    tom.needs.hunger = 5;
    await engine.advance(30);
    const s = engine.villager('tom')!;
    expect(s.activity.text).toMatch(/bite|café|snack/);
  });
});

describe('clock', () => {
  it('scales game time with speed and the night multiplier', () => {
    const c = new SimClock(0, { dayLengthMinutes: 15, speed: 1, nightSpeedMultiplier: 6 });
    expect(c.gameMinutesFor(1000, false)).toBeCloseTo(1.6);
    for (const s of [2, 4, 8]) {
      c.speed = s;
      expect(c.gameMinutesFor(1000, false)).toBeCloseTo(1.6 * s);
    }
    c.speed = 1;
    expect(c.gameMinutesFor(1000, true)).toBeCloseTo(9.6);
    c.speed = 0;
    expect(c.gameMinutesFor(1000, false)).toBe(0);
  });
});
