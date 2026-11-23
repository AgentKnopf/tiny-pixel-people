/**
 * World invariants for v2 suites (spec v2 §19 "hourly invariant checks"). Pure functions over a
 * snapshot and the map, so the mock suites and the live script judge the same way. Each returns a
 * list of human-readable problems; an empty list means the invariant holds.
 */
import { MAX_VILLAGERS } from '../../src/server/sim/engine.ts';
import {
  FARM_CAP_PER_SPECIES,
  FARM_SPECIES,
  type AnimalState,
  type GameMinutes,
  type Location,
  type Point,
  type Rect,
  type WorldMap,
  type WorldSnapshot,
} from '../../src/shared/types.ts';
import { formatClock, minuteOfDay } from '../../src/shared/time.ts';

export interface InvariantOptions {
  /** config.farm.capPerSpecies (never above FARM_CAP_PER_SPECIES). */
  farmCap?: number;
  /** config.hotel.rooms. */
  hotelRooms?: number;
  /** config.post.maxNotices. */
  maxNotices?: number;
  /** Crow flying range around the post office, in tiles. */
  crowRange?: number;
}

const inRect = (p: Point, r: Rect, slack = 0.5) =>
  p.x >= r.x - slack && p.x < r.x + r.w + slack && p.y >= r.y - slack && p.y < r.y + r.h + slack;

export function walkable(map: WorldMap, p: Point): boolean {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  return map.collision[y * map.width + x] === 0;
}

/** Living farm animals per species ("leaving" ones still count, spec v2 §3). */
export function farmCounts(animals: readonly AnimalState[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(FARM_SPECIES.map((s) => [s, 0]));
  for (const a of animals) if (a.group === 'farm') out[a.species] = (out[a.species] ?? 0) + 1;
  return out;
}

export function animalCapProblems(snap: WorldSnapshot, cap = FARM_CAP_PER_SPECIES): string[] {
  const limit = Math.min(cap, FARM_CAP_PER_SPECIES);
  return Object.entries(farmCounts(snap.animals ?? []))
    .filter(([, n]) => n > limit)
    .map(([species, n]) => `${species}: ${n} alive (cap ${limit})`);
}

/** Every penned animal stands inside its home location's pen; the crow on a perch or near it. */
export function animalPenProblems(snap: WorldSnapshot, map: WorldMap, crowRange = 6): string[] {
  const byId = new Map(map.locations.map((l) => [l.id, l]));
  const problems: string[] = [];
  for (const a of snap.animals ?? []) {
    const home = byId.get(a.homeId);
    if (!home) {
      problems.push(`${a.id} (${a.species}): unknown home ${a.homeId}`);
      continue;
    }
    if (a.species === 'crow') {
      const onPerch = (home.perch ?? []).some(
        (p) => Math.abs(p.x - a.pos.x) < 0.5 && Math.abs(p.y - a.pos.y) < 0.5,
      );
      if (!onPerch && distanceToRect(a.pos, home.area) > crowRange)
        problems.push(`crow ${a.id} at ${fmt(a.pos)} is more than ${crowRange} tiles from ${home.id}`);
      continue;
    }
    // Farm animals walk to the butcher when leaving (spec v2 §3.3).
    if (a.status === 'leaving') continue;
    const pen = home.pen ?? home.area;
    if (!inRect(a.pos, pen)) problems.push(`${a.id} (${a.species}) at ${fmt(a.pos)} outside ${home.id}`);
  }
  return problems;
}

/**
 * Villagers stand on walkable world tiles. Villagers indoors (location is a house or an interior
 * building) are drawn on interior spots and may keep any world position inside the building.
 */
export function villagerTileProblems(snap: WorldSnapshot, map: WorldMap): string[] {
  const byId = new Map(map.locations.map((l) => [l.id, l]));
  return snap.villagers
    .filter((v) => {
      const loc: Location | undefined = v.locationId ? byId.get(v.locationId) : undefined;
      if (loc && (loc.kind === 'house' || loc.interiorId) && inRect(v.pos, loc.area)) return false;
      return !walkable(map, v.pos);
    })
    .map((v) => `${v.id} on blocked tile ${fmt(v.pos)}`);
}

export function populationProblems(snap: WorldSnapshot): string[] {
  const n = snap.villagers.length;
  const ids = new Set(snap.villagers.map((v) => v.id));
  const problems = n > MAX_VILLAGERS ? [`${n} villagers (max ${MAX_VILLAGERS})`] : [];
  if (ids.size !== n) problems.push('duplicate villager ids');
  for (const vis of snap.visitors ?? [])
    if (!ids.has(vis.villagerId)) problems.push(`visitor ${vis.villagerId} has no villager`);
  return problems;
}

export function hotelProblems(snap: WorldSnapshot, rooms?: number): string[] {
  const hotel = snap.hotel;
  if (!hotel) return [];
  const problems: string[] = [];
  if (rooms !== undefined && hotel.rooms.length > rooms)
    problems.push(`${hotel.rooms.length} rooms (config ${rooms})`);
  const guests = hotel.rooms.map((r) => r.guestId).filter((g): g is string => g !== null);
  if (new Set(guests).size !== guests.length) problems.push('a guest holds two rooms');
  return problems;
}

export function noticeProblems(snap: WorldSnapshot, max?: number): string[] {
  const active = (snap.notices ?? []).filter((n) => n.expiresAt > snap.time);
  return max !== undefined && active.length > max ? [`${active.length} active notices (max ${max})`] : [];
}

/** All invariants at once, each problem prefixed with the game time. */
export function invariantProblems(snap: WorldSnapshot, map: WorldMap, opts: InvariantOptions = {}): string[] {
  const at = `day ${Math.floor(snap.time / 1440)} ${formatClock(minuteOfDay(snap.time))}`;
  return [
    ...animalCapProblems(snap, opts.farmCap),
    ...animalPenProblems(snap, map, opts.crowRange),
    ...villagerTileProblems(snap, map),
    ...populationProblems(snap),
    ...hotelProblems(snap, opts.hotelRooms),
    ...noticeProblems(snap, opts.maxNotices),
  ].map((p) => `${at}: ${p}`);
}

/**
 * An `onStep` hook for TestWorld.advanceTo that checks the invariants once per game hour (and on the
 * first step), collecting problems in `problems` instead of throwing mid-run.
 */
export function hourlyInvariants(
  map: WorldMap,
  opts: InvariantOptions = {},
): {
  onStep: (info: { time: GameMinutes; snapshot: () => WorldSnapshot }) => void;
  problems: string[];
  checks: number;
} {
  let lastHour: number | null = null;
  const state = {
    problems: [] as string[],
    checks: 0,
    onStep({ time, snapshot }: { time: GameMinutes; snapshot: () => WorldSnapshot }) {
      const hour = Math.floor(time / 60);
      if (hour === lastHour) return;
      lastHour = hour;
      state.checks++;
      state.problems.push(...invariantProblems(snapshot(), map, opts));
    },
  };
  return state;
}

function distanceToRect(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w - 1));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h - 1));
  return Math.hypot(dx, dy);
}

const fmt = (p: Point) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`;
