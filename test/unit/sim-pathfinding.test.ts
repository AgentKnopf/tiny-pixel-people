import { describe, expect, it } from 'vitest';
import { PathFinder, findPath, type Grid } from '../../src/server/sim/pathfinding.ts';
import { advanceAlongPath } from '../../src/server/sim/movement.ts';

function grid(rows: string[]): Grid {
  return {
    width: rows[0]!.length,
    height: rows.length,
    collision: rows
      .join('')
      .split('')
      .map((c) => (c === '#' ? 1 : 0)),
  };
}

describe('pathfinding', () => {
  const g = grid(['.....', '.###.', '...#.', '.#...']);

  it('finds a shortest 4-directional path around walls', () => {
    const path = findPath(g, { x: 0, y: 2 }, { x: 4, y: 2 })!;
    expect(path.at(-1)).toEqual({ x: 4, y: 2 });
    expect(path).toHaveLength(6);
    for (const p of path) expect(g.collision[p.y * g.width + p.x]).toBe(0);
    let prev = { x: 0, y: 2 };
    for (const p of path) {
      expect(Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y)).toBe(1);
      prev = p;
    }
  });

  it('returns [] when already there and null when blocked', () => {
    expect(findPath(g, { x: 1, y: 0 }, { x: 1, y: 0 })).toEqual([]);
    expect(findPath(g, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
    const walled = grid(['.#.', '##.', '...']);
    expect(findPath(walled, { x: 0, y: 0 }, { x: 2, y: 2 })).toBeNull();
  });

  it('caches results without sharing mutable arrays', () => {
    const pf = new PathFinder(g);
    const a = pf.find({ x: 0, y: 0 }, { x: 4, y: 3 })!;
    a.length = 0;
    expect(pf.find({ x: 0, y: 0 }, { x: 4, y: 3 })!.length).toBeGreaterThan(0);
  });

  it('moves along a path by distance and reports arrival', () => {
    const m = {
      pos: { x: 0, y: 0 },
      facing: 'down' as const,
      path: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
    };
    expect(advanceAlongPath(m, 1.5)).toBe(false);
    expect(m.pos).toEqual({ x: 1.5, y: 0 });
    expect(m.facing).toBe('right');
    expect(advanceAlongPath(m, 1)).toBe(true);
    expect(m.pos).toEqual({ x: 2, y: 0 });
  });
});
