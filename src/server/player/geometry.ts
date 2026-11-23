import type { Facing, Point, Rect, WorldMap } from '../../shared/types.ts';

export function tileOf(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

export function sameTile(a: Point, b: Point): boolean {
  return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function inRect(r: Rect, p: Point): boolean {
  const t = tileOf(p);
  return t.x >= r.x && t.x < r.x + r.w && t.y >= r.y && t.y < r.y + r.h;
}

/** Distance from a point to the nearest tile of a rect (0 inside). */
export function distanceToRect(r: Rect, p: Point): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w - 1));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h - 1));
  return Math.hypot(dx, dy);
}

export function isWalkable(map: WorldMap, p: Point): boolean {
  if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) return false;
  if (p.x < 0 || p.y < 0 || p.x >= map.width || p.y >= map.height) return false;
  return map.collision[p.y * map.width + p.x] !== 1;
}

export function facingFrom(dx: number, dy: number): Facing {
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'up' : 'down';
}

const NEIGHBOURS: Point[] = [
  { x: 0, y: 1 },
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];

/** Walkable tiles next to `p`, nearest to `from` first. */
export function walkableNeighbours(map: WorldMap, p: Point, from: Point): Point[] {
  const t = tileOf(p);
  return NEIGHBOURS.map((d) => ({ x: t.x + d.x, y: t.y + d.y }))
    .filter((n) => isWalkable(map, n))
    .sort((a, b) => distance(a, from) - distance(b, from));
}

export interface StepResult {
  pos: Point;
  path: Point[];
  facing: Facing | null;
}

/** Move along `path` by up to `budget` tiles. */
export function stepAlong(pos: Point, path: readonly Point[], budget: number): StepResult {
  let p = { ...pos };
  const rest = [...path];
  let facing: Facing | null = null;
  while (budget > 1e-9 && rest.length > 0) {
    const t = rest[0]!;
    const dx = t.x - p.x;
    const dy = t.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d > 0) facing = facingFrom(dx, dy);
    if (d <= budget) {
      p = { x: t.x, y: t.y };
      budget -= d;
      rest.shift();
    } else {
      p = { x: p.x + (dx / d) * budget, y: p.y + (dy / d) * budget };
      budget = 0;
    }
  }
  return { pos: p, path: rest, facing };
}

/** Random walkable tile inside `area`, avoiding `taken` tiles; null after a few failed tries. */
export function randomTileIn(
  map: WorldMap,
  area: Rect,
  random: () => number,
  taken: (p: Point) => boolean = () => false,
): Point | null {
  for (let i = 0; i < 24; i++) {
    const p = { x: area.x + Math.floor(random() * area.w), y: area.y + Math.floor(random() * area.h) };
    if (isWalkable(map, p) && !taken(p)) return p;
  }
  return null;
}
