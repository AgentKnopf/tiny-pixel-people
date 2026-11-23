import type { Facing, Point } from '../../shared/types.ts';

export interface Mover {
  pos: Point;
  facing: Facing;
  path: Point[];
}

export function facingFor(dx: number, dy: number, fallback: Facing): Facing {
  if (dx === 0 && dy === 0) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

/**
 * Move along `path` by up to `distance` tiles. Consumes reached waypoints. Returns true when the path
 * is (now) empty, i.e. the mover stands on its destination.
 */
export function advanceAlongPath(m: Mover, distance: number): boolean {
  let left = distance;
  while (left > 1e-9 && m.path.length > 0) {
    const next = m.path[0]!;
    const dx = next.x - m.pos.x;
    const dy = next.y - m.pos.y;
    const d = Math.hypot(dx, dy);
    m.facing = facingFor(dx, dy, m.facing);
    if (d <= left) {
      m.pos = { x: next.x, y: next.y };
      m.path.shift();
      left -= d;
    } else {
      m.pos = { x: m.pos.x + (dx / d) * left, y: m.pos.y + (dy / d) * left };
      left = 0;
    }
  }
  return m.path.length === 0;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function tileOf(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

export function sameTile(a: Point, b: Point): boolean {
  return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
}
