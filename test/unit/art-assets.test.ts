import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArt } from '../../scripts/art/generate.ts';
import type { WorldMap } from '../../src/shared/types.ts';

const root = join(import.meta.dirname, '..', '..');
const art = buildArt();
const map = JSON.parse(readFileSync(join(root, 'assets/maps/village.json'), 'utf8')) as WorldMap;
const tileset = JSON.parse(readFileSync(join(root, 'assets/tiles/village.json'), 'utf8')) as {
  count: number;
};

describe('generated art assets', () => {
  it('committed JSON matches the generator (run `npm run art` after changing scripts/art)', () => {
    for (const [rel, data] of art) {
      expect(existsSync(join(root, rel)), rel).toBe(true);
      if (rel.endsWith('.json')) expect(readFileSync(join(root, rel), 'utf8'), rel).toBe(data);
    }
  });

  it('map layers and collision are consistent with the tileset', () => {
    const size = map.width * map.height;
    for (const layer of [map.layers.ground, map.layers.decor, map.layers.overhead]) {
      expect(layer).toHaveLength(size);
      for (const id of layer) expect(id === -1 || (id >= 0 && id < tileset.count)).toBe(true);
    }
    expect(map.collision).toHaveLength(size);
    expect(map.layers.ground.every((id) => id >= 0)).toBe(true);
  });

  it('player home decoration slots are free of map objects', () => {
    const home = map.locations.find((l) => l.id === 'player_home')!;
    expect(home.decorSlots?.length).toBe(10);
    for (const p of home.decorSlots!) {
      const i = p.y * map.width + p.x;
      expect(map.layers.decor[i], `slot ${p.x},${p.y}`).toBe(-1);
      expect(map.layers.overhead[i], `slot ${p.x},${p.y}`).toBe(-1);
    }
    expect(map.scenes.map((s) => s.id)).toEqual(
      expect.arrayContaining(['plaza', 'farm', 'shop_street', 'park', 'home']),
    );
  });

  it('every location entry, door and spot is walkable and reachable from the square', () => {
    const walkable = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < map.width && y < map.height && map.collision[y * map.width + x] === 0;
    const square = map.locations.find((l) => l.id === 'square')!;
    const seen = new Set<number>([square.entry.y * map.width + square.entry.x]);
    const queue = [square.entry];
    while (queue.length) {
      const p = queue.shift()!;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const x = p.x + dx;
        const y = p.y + dy;
        const k = y * map.width + x;
        if (!walkable(x, y) || seen.has(k)) continue;
        seen.add(k);
        queue.push({ x, y });
      }
    }
    const houses = map.locations.filter((l) => l.kind === 'house' && l.id !== 'player_home');
    expect(houses.length).toBeGreaterThanOrEqual(10);
    for (const loc of map.locations) {
      for (const p of [loc.entry, ...(loc.door ? [loc.door] : []), ...(loc.spots ?? [])]) {
        expect(seen.has(p.y * map.width + p.x), `${loc.id} ${p.x},${p.y}`).toBe(true);
      }
    }
  });
});
