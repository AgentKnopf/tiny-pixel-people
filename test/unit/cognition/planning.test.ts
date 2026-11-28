import { describe, expect, it } from 'vitest';
import {
  ensureVariety,
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
import { DEFAULT_CONFIG } from '../../../src/server/config.ts';
import { updateNeeds } from '../../../src/server/sim/needs.ts';
import { at } from '../../../src/shared/time.ts';
import { LOCATIONS, PROFILES } from './helpers.ts';

const mia = PROFILES[0]!;
const decay = DEFAULT_CONFIG.needs.decayPerHour;
const w = wakeWindow(mia);

function coversDay(blocks: { start: number; end: number }[]) {
  expect(blocks[0]!.start).toBe(w.wake);
  expect(blocks.at(-1)!.end).toBe(w.sleep);
  for (let i = 1; i < blocks.length; i++) expect(blocks[i]!.start).toBe(blocks[i - 1]!.end);
}

describe('two places a day', () => {
  const allDay = (locationId: string) =>
    normalizeBlocks(
      [{ start: 0, end: 24 * 60, locationId, activity: 'mind the shop', emoji: '🛍️' }],
      w,
      mia.homeId,
    );
  const places = (b: { locationId: string }[]) => new Set(b.map((x) => x.locationId));

  it('adds a lunch break elsewhere to a one-place plan, never at the place already used', () => {
    const atWork = ensureVariety(allDay('bakery'), w, LOCATIONS);
    expect(places(atWork)).toEqual(new Set(['bakery', 'plaza']));
    expect(atWork.find((b) => b.locationId === 'plaza')).toMatchObject({ start: 720, end: 780 });
    coversDay(atWork);
    const atHome = ensureVariety(allDay(mia.homeId), w, LOCATIONS);
    expect(atHome.find((b) => b.locationId !== mia.homeId)).toMatchObject({
      locationId: 'bakery',
      start: 720,
    });
  });

  it('keeps events and tasks, prefers a slot after now, and leaves varied plans alone', () => {
    const event = {
      start: 690,
      end: 810,
      locationId: 'bakery',
      activity: 'host Bake-off',
      emoji: '🎉',
      eventId: 'ev1',
    };
    const out = ensureVariety(insertBlock(allDay('bakery'), event), w, LOCATIONS);
    expect(out.find((b) => b.eventId === 'ev1')).toMatchObject({ start: 690, end: 810 });
    const brk = out.find((b) => b.locationId !== 'bakery')!;
    expect(brk.end <= 690 || brk.start >= 810).toBe(true);
    const late = ensureVariety(allDay('bakery'), w, LOCATIONS, 15 * 60);
    expect(late.find((b) => b.locationId !== 'bakery')!.start).toBeGreaterThanOrEqual(15 * 60);
    const varied = fallbackBlocks(mia, LOCATIONS);
    expect(ensureVariety(varied, w, LOCATIONS)).toEqual(varied);
  });

  it('gives fallback plans a second place even when work, food and company are all at home', () => {
    const writer = { ...mia, occupation: 'Writer', bio: 'Writes.', id: 'zed' };
    const locs = LOCATIONS.filter((l) => l.id === mia.homeId || l.id === 'farm');
    const blocks = fallbackBlocks(writer, locs);
    expect(places(blocks)).toEqual(new Set([mia.homeId, 'farm']));
  });
});

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

  it('a less urgent need never replaces the block that fixes a more urgent one', () => {
    const needs = { hunger: 5, energy: 80, social: 10, fun: 10 };
    const fixed = new Set<string>(['hunger']);
    const meal = { start: 600, end: 645, locationId: 'cafe', activity: 'grab a bite to eat' };
    expect(needOverride(needs, meal, LOCATIONS, 'house_mia', 610, (n) => fixed.has(n))).toBeNull();
    const lunch = { start: 600, end: 660, locationId: 'cafe', activity: 'eat lunch' };
    expect(needOverride(needs, lunch, LOCATIONS, 'house_mia', 610, () => false)).toBeNull();
    // With hunger fine, the next need still gets its override.
    const fed = { ...needs, hunger: 60 };
    expect(needOverride(fed, lunch, LOCATIONS, 'house_mia', 610, () => false)?.need).toBe('social');
  });

  it('a fun override at the park restores fun under the needs rules', () => {
    const needs = { hunger: 80, energy: 80, social: 80, fun: 15 };
    const o = needOverride(needs, undefined, LOCATIONS, 'house_mia', 900, () => false)!;
    expect(o.need).toBe('fun');
    const where = LOCATIONS.find((l) => l.id === o.block.locationId) ?? null;
    expect(where?.id).toBe('park');
    for (let m = o.block.start; m < o.block.end; m++)
      updateNeeds(needs, { status: 'acting', activity: o.block.activity, location: where }, 1, decay);
    expect(o.block.end - o.block.start).toBe(45);
    expect(needs.fun).toBeGreaterThanOrEqual(25);
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
