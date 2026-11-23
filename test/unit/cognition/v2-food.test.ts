import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Location, Needs } from '../../../src/shared/types.ts';
import { nearestFood } from '../../../src/server/cognition/sanitize.ts';
import { needOverride } from '../../../src/server/cognition/planning.ts';

const MAP = JSON.parse(readFileSync(new URL('../../../data/map/village.json', import.meta.url), 'utf8')) as {
  locations: Location[];
};
const LOCS = MAP.locations;
const ZOO = { open: 8 * 60, close: 21 * 60 };
const entry = (id: string) => LOCS.find((l) => l.id === id)!.entry;
const far = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

describe('nearest food when hungry (real map)', () => {
  it('feeds a hotel guest at the hotel, not across the map at the bakery', () => {
    const f = nearestFood(LOCS, 'hotel', entry('hotel'), 12 * 60, ZOO);
    expect(f.locationId).toBe('hotel');
    expect(f.activity).toMatch(/\beat\b|snack/);
  });

  it('uses open zoo food stands near the guest, and skips them once closed', () => {
    const nearBurger = { x: 82, y: 31 };
    expect(nearestFood(LOCS, 'hotel', nearBurger, 12 * 60, ZOO)).toMatchObject({
      locationId: 'burger_joint',
      emoji: '🍔',
    });
    const nearTruck = entry('ice_cream_truck_1');
    expect(nearestFood(LOCS, 'hotel', nearTruck, 15 * 60, ZOO).locationId).toBe('ice_cream_truck_1');
    // 21:30: the burger joint and trucks are closed.
    const late = nearestFood(LOCS, 'hotel', nearBurger, 21 * 60 + 30, ZOO);
    expect(['hotel', 'bakery']).toContain(late.locationId);
    expect(late.locationId).not.toMatch(/burger|ice_cream/);
  });

  it('keeps residents eating close by: the bakery from the square, home from home', () => {
    const fromBakery = nearestFood(LOCS, 'house_01', entry('bakery'), 12 * 60, ZOO);
    expect(fromBakery.locationId).toBe('bakery');
    expect(fromBakery.activity).toMatch(/bite/);
    expect(nearestFood(LOCS, 'house_09', entry('house_09'), 12 * 60, ZOO).locationId).toBe('house_09');
  });

  it('every choice is the closest candidate, for positions all over the map', () => {
    for (let x = 2; x < 128; x += 9)
      for (let y = 2; y < 60; y += 7) {
        const f = nearestFood(LOCS, 'hotel', { x, y }, 13 * 60, ZOO);
        const d = far(entry(f.locationId), { x, y });
        expect(d, `${x},${y} -> ${f.locationId}`).toBeLessThanOrEqual(far(entry('hotel'), { x, y }));
        expect(d).toBeLessThanOrEqual(far(entry('bakery'), { x, y }));
      }
  });

  it('needOverride uses the given food stop and still keeps the old default', () => {
    const needs: Needs = { hunger: 10, energy: 80, social: 80, fun: 80 };
    const cur = { start: 600, end: 700, locationId: 'shop', activity: 'browse the shelves' };
    const food = () => nearestFood(LOCS, 'hotel', entry('hotel'), 600, ZOO);
    expect(needOverride(needs, cur, LOCS, 'hotel', 600, () => false, food)!.block).toMatchObject({
      locationId: 'hotel',
      activity: 'eat a snack at home',
    });
    expect(needOverride(needs, cur, LOCS, 'house_01', 600, () => false)!.block.locationId).toBe('bakery');
  });
});
