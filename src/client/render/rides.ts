import type { Location, Point, RideState, TrainState, WorldMap } from '../../shared/types.ts';

/** `assets/vehicles/index.json` (art contract). */
export interface VehicleSheet {
  sprite: string;
  frameWidth: number;
  frameHeight: number;
  frames?: number;
  rows?: string[];
  columns?: string[];
  object?: string;
  note?: string;
}

export interface VehicleIndex {
  train?: VehicleSheet;
  coasterCar?: VehicleSheet;
  iceCreamTruck?: VehicleSheet;
  ferrisWheel?: VehicleSheet;
  carousel?: VehicleSheet;
}

// ---------- Rollercoaster ----------

/** Track tiles are named `coaster_<mask>` with N=1, E=2, S=4, W=8 for the sides they connect. */
const DIRS = [
  { bit: 1, dx: 0, dy: -1, name: 'north' },
  { bit: 2, dx: 1, dy: 0, name: 'east' },
  { bit: 4, dx: 0, dy: 1, name: 'south' },
  { bit: 8, dx: -1, dy: 0, name: 'west' },
] as const;

export type Heading = (typeof DIRS)[number]['name'];

/** Connection mask per tile from the decor layer (`names`: global tile index → tile name). */
export function trackMasks(
  map: WorldMap,
  names: Map<number, string>,
  area: Location['area'],
): Map<number, number> {
  const out = new Map<number, number>();
  const pad = 1;
  for (let y = Math.max(0, area.y - pad); y < Math.min(map.height, area.y + area.h + pad); y++) {
    for (let x = Math.max(0, area.x - pad); x < Math.min(map.width, area.x + area.w + pad); x++) {
      const i = y * map.width + x;
      const name = names.get(map.layers.decor[i] ?? -1);
      const m = name ? /^coaster_(\d+)$/.exec(name) : null;
      if (m) out.set(i, Number(m[1]));
    }
  }
  return out;
}

/**
 * The closed track loop as an ordered list of tiles, starting at the track tile closest to `start`
 * (the boarding point) and leaving east (else any open side). Null when the tiles do not form a loop.
 */
export function traceLoop(masks: Map<number, number>, width: number, start: Point): Point[] | null {
  if (masks.size < 4) return null;
  let first = -1;
  let best = Infinity;
  for (const i of masks.keys()) {
    const d = Math.abs((i % width) - start.x) + Math.abs(Math.floor(i / width) - start.y);
    if (d < best) [best, first] = [d, i];
  }
  const firstMask = masks.get(first)!;
  let dir = DIRS.find((d) => d.name === 'east' && firstMask & d.bit) ?? DIRS.find((d) => firstMask & d.bit);
  if (!dir) return null;
  const loop: Point[] = [];
  let cur = first;
  for (let guard = 0; guard <= masks.size; guard++) {
    loop.push({ x: cur % width, y: Math.floor(cur / width) });
    const next = cur + dir.dx + dir.dy * width;
    const nm = masks.get(next);
    const back = DIRS.find((d) => d.dx === -dir!.dx && d.dy === -dir!.dy)!;
    if (nm === undefined || !(nm & back.bit)) return null;
    if (next === first) return loop;
    cur = next;
    dir = DIRS.find((d) => d !== back && nm & d.bit);
    if (!dir) return null;
  }
  return null;
}

/** Point `dist` tiles along the loop (wrapping), with the heading of that segment. */
export function alongLoop(loop: Point[], dist: number): { pos: Point; heading: Heading } {
  const n = loop.length;
  const d = ((dist % n) + n) % n;
  const i = Math.floor(d);
  const f = d - i;
  const a = loop[i]!;
  const b = loop[(i + 1) % n]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const heading: Heading = dx > 0 ? 'east' : dx < 0 ? 'west' : dy > 0 ? 'south' : 'north';
  return { pos: { x: a.x + dx * f, y: a.y + dy * f }, heading };
}

export const COASTER_CARS = 3;
/** Tiles per real second while the ride runs. */
export const COASTER_SPEED = 4;

/** Car positions (front first). Parked at the boarding point unless the ride is running. */
export function coasterCars(
  loop: Point[],
  ride: RideState | undefined,
  now: number,
): { pos: Point; heading: Heading }[] {
  const running = ride?.status === 'running';
  const head = running ? (now / 1000) * COASTER_SPEED : COASTER_CARS - 1;
  const cars = [];
  for (let k = 0; k < COASTER_CARS; k++) cars.push(alongLoop(loop, head - k));
  return cars;
}

// ---------- Ferris wheel and carousel ----------

/** Frame of a looping ride animation; frame 0 (the map art) when not running. */
export function rideFrame(
  ride: RideState | undefined,
  frames: number,
  fps: number,
  now: number,
): number | null {
  if (ride?.status !== 'running' || frames <= 1) return null;
  return Math.floor((now / 1000) * fps) % frames;
}

/** Villagers drawn inside a running ride rather than standing on the map. */
export function ridingIds(rides: Iterable<RideState>): Set<string> {
  const out = new Set<string>();
  for (const r of rides) if (r.status === 'running') for (const id of r.riders) out.add(id);
  return out;
}

// ---------- Train ----------

/** Game minutes the train takes to pull in and to pull out (spec v2 §5.1). */
export const TRAIN_MOVE_MIN = 5;
/** Engine plus three carriages, 4 tiles each. */
export const TRAIN_CARS = 4;
export const CAR_TILES = 4;

export interface TrainPose {
  /** Left edge of the engine in tiles (fractional); carriages follow to the east. */
  x: number;
  /** Rail row the frames stand on (the middle of the `railway.rows` bed). */
  row: number;
  moving: boolean;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Where the train is at `gameTime`: it enters from the east edge, stops centred on the platform while
 * boarding and leaves off the west edge. Null while away or when the map has no railway.
 */
export function trainPose(train: TrainState | null, gameTime: number, map: WorldMap): TrainPose | null {
  const rail = map.railway;
  if (!train || !rail || train.status === 'away') return null;
  const len = TRAIN_CARS * CAR_TILES;
  const stop = rail.platform.x + Math.floor((rail.platform.w - len) / 2);
  // `rows` is the first and last row of the bed (gravel, rail, gravel); the rails run in the middle.
  const row = Math.round((rail.rows[0] + rail.rows[1]) / 2);
  if (train.status === 'boarding') return { x: stop, row, moving: false };
  if (train.status === 'arriving') {
    const t = clamp01((gameTime - (train.arrivesAt - TRAIN_MOVE_MIN)) / TRAIN_MOVE_MIN);
    const ease = 1 - (1 - t) * (1 - t);
    return { x: map.width + (stop - map.width) * ease, row, moving: t < 1 };
  }
  const t = clamp01((gameTime - train.departsAt) / TRAIN_MOVE_MIN);
  const end = -len - 1;
  return { x: stop + (end - stop) * t * t, row, moving: t > 0 && t < 1 };
}
