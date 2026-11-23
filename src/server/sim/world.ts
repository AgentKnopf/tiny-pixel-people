import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  FOREST_SPECIES,
  ZOO_SPECIES,
  type ForestSpecies,
  type Location,
  type LocationId,
  type Point,
  type RomanceStage,
  type VillagerId,
  type VillagerProfile,
  type WorldMap,
  type ZooSpecies,
} from '../../shared/types.ts';
import { isWalkable } from './pathfinding.ts';

export const DEFAULT_MAP_PATH = fileURLToPath(new URL('../../../data/map/village.json', import.meta.url));
export const DEFAULT_VILLAGERS_PATH = fileURLToPath(new URL('../../../data/villagers.json', import.meta.url));

export const DEFAULT_ROMANCE_PATH = fileURLToPath(new URL('../../../data/romance.json', import.meta.url));
export const DEFAULT_ZOO_PATH = fileURLToPath(new URL('../../../data/zoo.json', import.meta.url));
export const DEFAULT_AMBIENT_PATH = fileURLToPath(new URL('../../../data/ambient.json', import.meta.url));

export class WorldDataError extends Error {}

/** Zoo population (data/zoo.json, spec v2 §3.2). */
export interface ZooData {
  /** Animals per enclosure, inclusive [min, max], for species without an entry in `counts`. */
  defaultCount: [number, number];
  counts: Partial<Record<ZooSpecies, number>>;
  names: Partial<Record<ZooSpecies, string[]>>;
}

/** Forest animals and the crow (data/ambient.json, spec v2 §3.5–3.6). */
export interface AmbientData {
  crow: { name: string };
  forest: Record<ForestSpecies, number>;
}

export const DEFAULT_ZOO_DATA: ZooData = {
  defaultCount: [1, 2],
  counts: { penguin: 3, flamingo: 3 },
  names: {
    lion: ['Leo', 'Nala'],
    elephant: ['Ellie', 'Jumbo'],
    giraffe: ['Gigi', 'Stretch'],
    zebra: ['Ziggy', 'Stripes'],
    penguin: ['Pingu', 'Waddles', 'Flipper'],
    monkey: ['Momo', 'Coco'],
    panda: ['Bao', 'Mei'],
    flamingo: ['Rosa', 'Flo', 'Pinky'],
    kangaroo: ['Joey', 'Skip'],
    polar_bear: ['Frost', 'Nanook'],
    hippo: ['Gloria', 'Hugo'],
    crocodile: ['Snappy', 'Chomp'],
  },
};

export const DEFAULT_AMBIENT_DATA: AmbientData = {
  crow: { name: 'Quill' },
  forest: { deer: 3, rabbit: 5, squirrel: 4, hedgehog: 2, fox: 2, bird: 6, duck: 5 },
};

const count = z.number().int().min(0).max(20);
const animalName = z.string().trim().min(1).max(32);
const zooSchema = z
  .object({
    defaultCount: z
      .tuple([count, count])
      .refine(([a, b]) => a <= b, 'min must not exceed max')
      .optional(),
    counts: z.partialRecord(z.enum(ZOO_SPECIES), count).optional(),
    names: z.partialRecord(z.enum(ZOO_SPECIES), z.array(animalName).min(1)).optional(),
  })
  .strict();
const ambientSchema = z
  .object({
    crow: z.object({ name: animalName }).strict().optional(),
    forest: z.partialRecord(z.enum(FOREST_SPECIES), count).optional(),
  })
  .strict();
const romanceSchema = z.array(
  z
    .object({
      pair: z.tuple([z.string().min(1), z.string().min(1)]),
      stage: z.enum(['crush', 'dating', 'couple', 'ended']),
      crushFrom: z.array(z.string().min(1)).max(2),
      shy: z.boolean().optional(),
    })
    .strict(),
);

/** Parsed JSON, or null when the file does not exist. */
function readJson(path: string, what: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new WorldDataError(`${what} (${path}) is not valid JSON: ${(err as Error).message}`);
  }
}

function check<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const res = schema.safeParse(data);
  if (res.success) return res.data;
  const problems = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new WorldDataError(`Invalid ${what}:\n  - ${problems.join('\n  - ')}`);
}

/** data/zoo.json merged over the defaults; a missing file means the defaults. */
export function loadZooData(path: string = DEFAULT_ZOO_PATH): ZooData {
  const raw = readJson(path, 'zoo data');
  if (raw === null) return structuredClone(DEFAULT_ZOO_DATA);
  const d = check(zooSchema, raw, 'zoo data');
  return {
    defaultCount: d.defaultCount ?? [...DEFAULT_ZOO_DATA.defaultCount],
    counts: { ...DEFAULT_ZOO_DATA.counts, ...d.counts },
    names: { ...structuredClone(DEFAULT_ZOO_DATA.names), ...d.names },
  };
}

/** data/ambient.json merged over the defaults; a missing file means the defaults. */
export function loadAmbientData(path: string = DEFAULT_AMBIENT_PATH): AmbientData {
  const raw = readJson(path, 'ambient data');
  if (raw === null) return structuredClone(DEFAULT_AMBIENT_DATA);
  const d = check(ambientSchema, raw, 'ambient data');
  return {
    crow: { name: d.crow?.name ?? DEFAULT_AMBIENT_DATA.crow.name },
    forest: { ...DEFAULT_AMBIENT_DATA.forest, ...d.forest },
  };
}
/** A pre-seeded romance (data/romance.json, spec v2 §7.1). */
export interface RomanceSeed {
  pair: [VillagerId, VillagerId];
  stage: RomanceStage;
  crushFrom: VillagerId[];
  shy?: boolean;
}

/** data/romance.json; a missing file means no seeded romances. */
export function loadRomanceSeeds(path: string = DEFAULT_ROMANCE_PATH): RomanceSeed[] {
  const raw = readJson(path, 'romance seeds');
  if (raw === null) return [];
  const seeds: RomanceSeed[] = check(romanceSchema, raw, 'romance seeds').map((s) => ({
    pair: s.pair,
    stage: s.stage,
    crushFrom: s.crushFrom,
    ...(s.shy !== undefined ? { shy: s.shy } : {}),
  }));
  for (const s of seeds) {
    if (s.pair[0] === s.pair[1])
      throw new WorldDataError(`Invalid romance seed pair ${JSON.stringify(s.pair)}`);
    if (!s.crushFrom.every((id) => s.pair.includes(id)))
      throw new WorldDataError(`Romance seed ${s.pair.join('/')}: crushFrom must be in the pair`);
  }
  return seeds;
}
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

/** Distance (tiles) from `p` to the nearest tile of a location's area; 0 inside it. */
export function distanceToArea(loc: Location, p: Point): number {
  const { x, y, w, h } = loc.area;
  const dx = Math.max(x - p.x, 0, p.x - (x + w - 1));
  const dy = Math.max(y - p.y, 0, p.y - (y + h - 1));
  return Math.hypot(dx, dy);
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
