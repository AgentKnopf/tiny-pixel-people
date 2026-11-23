/**
 * Deterministic plan sanitizing for the v2 map (spec v2 §2.1, §7.1, §10): opening hours, the
 * forest at night, places nobody plans to visit, and the shy pair's post office visits.
 */
import { parseClock } from '../../shared/time.ts';
import type { Location, LocationId, PlanBlock } from '../../shared/types.ts';
import { insertBlock, planEnd, sortBlocks, type WakeWindow } from './planning.ts';
import { compareIds } from './rng.ts';

export interface Hours {
  open: number;
  close: number;
}

/** Fallback places for blocks at a closed place, in order of preference (always open). */
const OPEN_ALTERNATIVES: readonly LocationId[] = ['square', 'park', 'market', 'forest'];
/** The forest is always open, but nobody walks there after 22:00. */
export const FOREST_LATE = 22 * 60;
/** Never planned: the butcher is off-screen. */
const NEVER_PLANNED: readonly LocationId[] = ['butcher'];

function clockOr(s: string | undefined, d: number): number {
  if (!s) return d;
  try {
    return parseClock(s);
  } catch {
    return d;
  }
}

export function isForest(loc: Location): boolean {
  return loc.district === 'forest' || /^forest/.test(loc.id);
}

/** Opening hours of a place, or null when it is always open. Zoo places use the zoo's hours. */
export function hoursOf(loc: Location, zoo: Hours): Hours | null {
  if (loc.hours) return { open: clockOr(loc.hours.open, 0), close: clockOr(loc.hours.close, 24 * 60) };
  if (loc.kind === 'zoo' || loc.kind === 'ride') return zoo;
  if (isForest(loc)) return { open: 0, close: FOREST_LATE };
  return null;
}

export function isOpenAt(loc: Location, mod: number, zoo: Hours): boolean {
  const h = hoursOf(loc, zoo);
  return !h || (mod >= h.open && mod < h.close);
}

/** True when the place is open for the whole span. */
export function isOpenFor(loc: Location, start: number, end: number, zoo: Hours): boolean {
  const h = hoursOf(loc, zoo);
  return !h || (start >= h.open && end <= h.close);
}

function dist(a: Location, b: Location): number {
  return Math.abs(a.entry.x - b.entry.x) + Math.abs(a.entry.y - b.entry.y);
}

function alternativeFor(
  from: Location,
  start: number,
  end: number,
  locations: readonly Location[],
  zoo: Hours,
): Location | null {
  const byId = new Map(locations.map((l) => [l.id, l]));
  let cands = OPEN_ALTERNATIVES.map((id) => byId.get(id)).filter((l): l is Location => !!l);
  if (cands.length === 0) cands = locations.filter((l) => l.kind === 'public' || l.kind === 'nature');
  const open = cands.filter((l) => l.id !== from.id && isOpenFor(l, start, end, zoo));
  open.sort((a, b) => dist(from, a) - dist(from, b) || compareIds(a.id, b.id));
  return open[0] ?? null;
}

export interface SanitizeContext {
  locations: readonly Location[];
  homeId: LocationId;
  window: WakeWindow;
  zoo: Hours;
}

/**
 * Moves the parts of blocks that fall outside a place's opening hours to the nearest open place
 * (square, park, market, forest), or home when none is open; forest blocks after 22:00 go home.
 * Event and task blocks are left alone. The result covers the same time span.
 */
export function sanitizeBlocks(blocks: readonly PlanBlock[], ctx: SanitizeContext): PlanBlock[] {
  const byId = new Map(ctx.locations.map((l) => [l.id, l]));
  const out: PlanBlock[] = [];
  for (const b of blocks) {
    const loc = byId.get(b.locationId);
    if (!loc || b.eventId || b.taskId) {
      out.push(b);
      continue;
    }
    if (NEVER_PLANNED.includes(loc.id)) {
      const alt = alternativeFor(loc, b.start, b.end, ctx.locations, ctx.zoo);
      out.push(moved(b, b.start, b.end, alt, ctx.homeId));
      continue;
    }
    const h = hoursOf(loc, ctx.zoo);
    if (!h || (b.start >= h.open && b.end <= h.close)) {
      out.push(b);
      continue;
    }
    const pieces: [number, number, boolean][] = [
      [b.start, Math.min(b.end, h.open), false],
      [Math.max(b.start, h.open), Math.min(b.end, h.close), true],
      [Math.max(b.start, h.close), b.end, false],
    ];
    for (const [s, e, open] of pieces) {
      if (e - s < 1) continue;
      if (open) out.push({ ...b, start: s, end: e });
      else {
        const alt = isForest(loc) ? null : alternativeFor(loc, s, e, ctx.locations, ctx.zoo);
        out.push(moved(b, s, e, alt, ctx.homeId));
      }
    }
  }
  return sortBlocks(out);
}

function moved(
  b: PlanBlock,
  start: number,
  end: number,
  alt: Location | null,
  homeId: LocationId,
): PlanBlock {
  if (!alt) return { start, end, locationId: homeId, activity: 'head home for the evening', emoji: '🏠' };
  return {
    start,
    end,
    locationId: alt.id,
    activity: alt.kind === 'nature' ? `take a stroll in the ${alt.name}` : `wander around the ${alt.name}`,
    emoji: '🚶',
  };
}

/** Deterministic value in [0, 1) for a key (stable however often a plan is re-sanitized). */
export function hashUnit(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // FNV-1a alone barely changes the high bits for keys differing in their last character.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2 ** 32;
}

/**
 * Adds a short visit to `placeId` during its opening hours (the shy pair's post office visits,
 * spec v2 §7.1) unless the plan already has one. The slot avoids event and task blocks and, when
 * possible, the past (`from`).
 */
export function addVisit(
  blocks: readonly PlanBlock[],
  place: Location,
  ctx: SanitizeContext,
  opts: { key: string; activity: string; emoji: string; from?: number },
): PlanBlock[] {
  if (blocks.some((b) => b.locationId === place.id)) return [...blocks];
  const h = hoursOf(place, ctx.zoo) ?? { open: ctx.window.wake, close: planEnd(ctx.window) };
  const lo = Math.max(h.open, ctx.window.wake + 30);
  const hi = Math.min(h.close, planEnd(ctx.window) - 15);
  const len = 20 + Math.floor(hashUnit(`${opts.key}:len`) * 21);
  const pinned = blocks.filter((b) => b.eventId || b.taskId);
  const slots: number[] = [];
  for (let s = Math.ceil(lo / 15) * 15; s + len <= hi; s += 15)
    if (!pinned.some((p) => p.start < s + len && p.end > s)) slots.push(s);
  if (slots.length === 0) return [...blocks];
  const later = slots.filter((s) => s >= (opts.from ?? 0));
  const pool = later.length ? later : slots;
  const start = pool[Math.floor(hashUnit(`${opts.key}:slot`) * pool.length)]!;
  return insertBlock(blocks, {
    start,
    end: start + len,
    locationId: place.id,
    activity: opts.activity,
    emoji: opts.emoji,
  });
}
