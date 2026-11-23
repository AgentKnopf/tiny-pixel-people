import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Location, LocationId, Point, VillagerProfile, WorldMap } from '../../shared/types.ts';
import { isWalkable } from './pathfinding.ts';

export const DEFAULT_MAP_PATH = fileURLToPath(new URL('../../../data/map/village.json', import.meta.url));
export const DEFAULT_VILLAGERS_PATH = fileURLToPath(new URL('../../../data/villagers.json', import.meta.url));

export class WorldDataError extends Error {}

/** Load and sanity-check a WorldMap JSON file. */
export function loadMap(path: string = DEFAULT_MAP_PATH): WorldMap {
  const map = JSON.parse(readFileSync(path, 'utf8')) as WorldMap;
  validateMap(map);
  return map;
}

export function validateMap(map: WorldMap): void {
  const size = map.width * map.height;
  const problems: string[] = [];
  if (map.collision.length !== size)
    problems.push(`collision has ${map.collision.length} cells, expected ${size}`);
  for (const [name, layer] of Object.entries(map.layers)) {
    if (layer.length !== size) problems.push(`layer ${name} has ${layer.length} cells, expected ${size}`);
  }
  const ids = new Set<string>();
  for (const loc of map.locations) {
    if (ids.has(loc.id)) problems.push(`duplicate location id ${loc.id}`);
    ids.add(loc.id);
    if (!isWalkable(map, loc.entry.x, loc.entry.y)) problems.push(`entry of ${loc.id} is blocked`);
    for (const s of loc.spots ?? []) {
      if (!isWalkable(map, s.x, s.y)) problems.push(`spot ${s.x},${s.y} of ${loc.id} is blocked`);
    }
  }
  if (problems.length) throw new WorldDataError(`Invalid map:\n  - ${problems.join('\n  - ')}`);
}

/** Load villager profiles and check that every home exists on the map. */
export function loadProfiles(
  map: WorldMap,
  path: string = DEFAULT_VILLAGERS_PATH,
  count?: number,
): VillagerProfile[] {
  const all = JSON.parse(readFileSync(path, 'utf8')) as VillagerProfile[];
  validateProfiles(map, all);
  return count === undefined ? all : all.slice(0, count);
}

export function validateProfiles(map: WorldMap, profiles: readonly VillagerProfile[]): void {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const p of profiles) {
    if (ids.has(p.id)) problems.push(`duplicate villager id ${p.id}`);
    ids.add(p.id);
    if (!map.locations.some((l) => l.id === p.homeId)) problems.push(`${p.id}: unknown homeId ${p.homeId}`);
  }
  if (problems.length) throw new WorldDataError(`Invalid villagers:\n  - ${problems.join('\n  - ')}`);
}

export function inRect(p: Point, r: { x: number; y: number; w: number; h: number }): boolean {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

/** Is `p` at this location: inside its area, or (for buildings) on one of its entry/spot tiles. */
export function isAt(loc: Location, p: Point): boolean {
  if (inRect(p, loc.area)) return true;
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (loc.entry.x === x && loc.entry.y === y) return true;
  return (loc.spots ?? []).some((s) => s.x === x && s.y === y);
}

/** The most specific location at a point (smallest area wins). */
export function locationAt(locations: readonly Location[], p: Point): Location | null {
  let best: Location | null = null;
  for (const loc of locations) {
    if (!isAt(loc, p)) continue;
    if (!best || loc.area.w * loc.area.h < best.area.w * best.area.h) best = loc;
  }
  return best;
}

export function locationById(locations: readonly Location[], id: LocationId): Location | null {
  return locations.find((l) => l.id === id) ?? null;
}

/** Nearest walkable tile to `p` within `radius` (spiral search), or null. */
export function nearestWalkable(map: WorldMap, p: Point, radius = 4): Point | null {
  const cx = Math.round(p.x);
  const cy = Math.round(p.y);
  for (let r = 0; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (isWalkable(map, cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
      }
    }
  }
  return null;
}
