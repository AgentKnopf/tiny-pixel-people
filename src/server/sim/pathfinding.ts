import type { Point } from '../../shared/types.ts';

export interface Grid {
  width: number;
  height: number;
  /** Row-major, 1 = blocked. */
  collision: readonly (0 | 1)[];
}

export function isWalkable(grid: Grid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height && grid.collision[y * grid.width + x] === 0;
}

const DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Binary min-heap keyed by f-score. */
class Heap {
  private readonly items: number[] = [];
  constructor(private readonly score: Float64Array) {}
  get size(): number {
    return this.items.length;
  }
  push(n: number): void {
    const a = this.items;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.score[a[p]!]! <= this.score[a[i]!]!) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.score[a[l]!]! < this.score[a[m]!]!) m = l;
        if (r < a.length && this.score[a[r]!]! < this.score[a[m]!]!) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * 4-directional A* on the collision grid. Returns the tiles to walk through, excluding `from` and
 * including `to`; `[]` when already there; `null` when unreachable. The start tile may be blocked
 * (someone standing on a door or spawned on an edge) so entities can always walk off it.
 */
export function findPath(grid: Grid, from: Point, to: Point): Point[] | null {
  const sx = Math.round(from.x);
  const sy = Math.round(from.y);
  const tx = Math.round(to.x);
  const ty = Math.round(to.y);
  if (sx === tx && sy === ty) return [];
  if (!isWalkable(grid, tx, ty)) return null;
  const w = grid.width;
  const size = w * grid.height;
  const start = sy * w + sx;
  const goal = ty * w + tx;
  if (start < 0 || start >= size) return null;
  const g = new Float64Array(size).fill(Infinity);
  const f = new Float64Array(size).fill(Infinity);
  const came = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const open = new Heap(f);
  g[start] = 0;
  f[start] = Math.abs(sx - tx) + Math.abs(sy - ty);
  open.push(start);
  while (open.size > 0) {
    const cur = open.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(grid, nx, ny)) continue;
      const n = ny * w + nx;
      if (closed[n]) continue;
      const ng = g[cur]! + 1;
      if (ng < g[n]!) {
        g[n] = ng;
        came[n] = cur;
        // Tiny tie-breaker towards the goal keeps paths straight instead of zig-zagging.
        f[n] = ng + (Math.abs(nx - tx) + Math.abs(ny - ty)) * 1.001;
        open.push(n);
      }
    }
  }
  if (came[goal] === -1) return null;
  const out: Point[] = [];
  for (let n = goal; n !== start; n = came[n]!) out.push({ x: n % w, y: Math.floor(n / w) });
  return out.reverse();
}

/** A* with a bounded cache keyed by (from, to) tile pairs. */
const pathKey = (from: Point, to: Point) =>
  `${Math.round(from.x)},${Math.round(from.y)}>${Math.round(to.x)},${Math.round(to.y)}`;

export class PathFinder {
  private readonly cache = new Map<string, Point[] | null>();

  constructor(
    private readonly grid: Grid,
    private readonly maxEntries = 4000,
  ) {}

  /** Whether find(from, to) would be answered from the cache. */
  has(from: Point, to: Point): boolean {
    return this.cache.has(pathKey(from, to));
  }

  find(from: Point, to: Point): Point[] | null {
    const key = pathKey(from, to);
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit && hit.map((p) => ({ ...p }));
    }
    const path = findPath(this.grid, from, to);
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, path);
    return path && path.map((p) => ({ ...p }));
  }

  clear(): void {
    this.cache.clear();
  }
}
