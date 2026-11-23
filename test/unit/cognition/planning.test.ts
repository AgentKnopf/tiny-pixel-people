import { describe, expect, it } from 'vitest';
import {
  fallbackBlocks,
  insertBlock,
  needOverride,
  normalizeBlocks,
  parsePlan,
  rainSafe,
  resolveLocation,
  wakeWindow,
  workLocation,
  planDayFor,
} from '../../../src/server/cognition/planning.ts';
import { at } from '../../../src/shared/time.ts';
import { LOCATIONS, PROFILES } from './helpers.ts';

const mia = PROFILES[0]!;
const w = wakeWindow(mia);

function coversDay(blocks: { start: number; end: number }[]) {
  expect(blocks[0]!.start).toBe(w.wake);
  expect(blocks.at(-1)!.end).toBe(w.sleep);
  for (let i = 1; i < blocks.length; i++) expect(blocks[i]!.start).toBe(blocks[i - 1]!.end);
}

describe('planning', () => {
  it('resolves messy location names', () => {
    expect(resolveLocation('the Bakery', LOCATIONS, 'house_mia')).toBe('bakery');
    expect(resolveLocation('home', LOCATIONS, 'house_mia')).toBe('house_mia');
    expect(resolveLocation('village plaza', LOCATIONS, 'house_mia')).toBe('plaza');
    expect(resolveLocation('Park bench', LOCATIONS, 'house_mia')).toBe('park');
    expect(resolveLocation('the moon', LOCATIONS, 'house_mia')).toBeNull();
  });

  it('finds work places from ownership and occupation', () => {
    expect(workLocation(mia, LOCATIONS)).toBe('bakery');
    expect(workLocation(PROFILES[1]!, LOCATIONS)).toBe('farm');
    expect(workLocation(PROFILES[2]!, LOCATIONS)).toBe('cafe');
  });

  it('builds a contiguous fallback plan from wake to bedtime', () => {
    const blocks = fallbackBlocks(mia, LOCATIONS);
    coversDay(blocks);
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    expect(blocks.some((b) => b.locationId === 'bakery')).toBe(true);
  });

  it('parses a sloppy model plan and normalises it', () => {
    const raw = {
      Summary: 'Busy day',
      schedule: [
        { start: '7am', end: '11:00', place: 'Bakery', action: 'bake bread' },
        { from: '10:30', to: '13:00', location: 'cafe', activity: 'lunch with Cleo', emoji: '☕' },
        { start: 15, duration: 90, location: 'mars', activity: 'stargazing' },
        { activity: 'no time' },
      ],
    };
    const parsed = parsePlan(raw, LOCATIONS, 'house_mia')!;
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[2]!.locationId).toBe('house_mia');
    const blocks = normalizeBlocks(parsed.blocks, w, 'house_mia');
    coversDay(blocks);
    expect(blocks.find((b) => b.activity === 'lunch with Cleo')!.start).toBe(660);
    expect(parsePlan({ blocks: [] }, LOCATIONS, 'house_mia')).toBeNull();
  });

  it('insertBlock splits what it overlaps', () => {
    const base = [{ start: 360, end: 1320, locationId: 'house_mia', activity: 'x' }];
    const out = insertBlock(base, {
      start: 900,
      end: 1020,
      locationId: 'plaza',
      activity: 'bake-off',
      eventId: 'e1',
    });
    expect(out.map((b) => [b.start, b.end])).toEqual([
      [360, 900],
      [900, 1020],
      [1020, 1320],
    ]);
  });

  it('needs override inserts a fixing block only when needed', () => {
    const cur = { start: 600, end: 700, locationId: 'bakery', activity: 'bake bread' };
    const needs = { hunger: 10, energy: 80, social: 80, fun: 80 };
    const o = needOverride(needs, cur, LOCATIONS, 'house_mia', 610, () => false)!;
    expect(o.need).toBe('hunger');
    expect(['cafe', 'bakery']).toContain(o.block.locationId);
    expect(
      needOverride(needs, { ...cur, activity: 'eat lunch' }, LOCATIONS, 'house_mia', 610, () => false),
    ).toBeNull();
    expect(needOverride({ ...needs, hunger: 50 }, cur, LOCATIONS, 'house_mia', 610, () => false)).toBeNull();
  });

  it('moves outdoor blocks indoors while it rains', () => {
    const b = { start: 600, end: 700, locationId: 'park', activity: 'paint' };
    expect(rainSafe(b, { state: 'clear', since: 0, until: null }, LOCATIONS, 'house_dan')).toBe(b);
    const r = rainSafe(b, { state: 'rain', since: 0, until: 700 }, LOCATIONS, 'house_dan');
    expect(LOCATIONS.find((l) => l.id === r.locationId)!.kind).toBe('shop');
  });

  it('knows which day a moment belongs to', () => {
    expect(planDayFor(w, at(0, '12:00'))).toBe(0);
    expect(planDayFor(w, at(0, '23:00'))).toBe(1);
    expect(planDayFor(w, at(1, '03:00'))).toBe(1);
  });
});
