import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZOO_SPECIES, type Point, type WorldMap } from '../../src/shared/types.ts';

const root = join(import.meta.dirname, '..', '..');
const read = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8')) as WorldMap;
const map = read('assets/maps/village.json');
const data = read('data/map/village.json');

function reachable(m: { width: number; height: number; collision: (0 | 1)[] }, from: Point): Set<number> {
  const seen = new Set([from.y * m.width + from.x]);
  const queue = [from];
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
      const k = y * m.width + x;
      if (x < 0 || y < 0 || x >= m.width || y >= m.height || m.collision[k] !== 0 || seen.has(k)) continue;
      seen.add(k);
      queue.push({ x, y });
    }
  }
  return seen;
}

const within = (r: { x: number; y: number; w: number; h: number }, o: typeof r) =>
  r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h;

describe('v2 map art (assets/maps/village.json)', () => {
  it('is 128×60 and data/map/village.json differs only in locations', () => {
    expect([map.width, map.height]).toEqual([128, 60]);
    for (const key of Object.keys(map) as (keyof WorldMap)[])
      if (key !== 'locations') expect(data[key], key).toEqual(map[key]);
    expect(data.locations.map((l) => [l.id, l.area, l.entry, l.door])).toEqual(
      map.locations.map((l) => [l.id, l.area, l.entry, l.door]),
    );
  });

  it('places every location inside its district', () => {
    expect(map.districts?.map((d) => d.id)).toEqual([
      'town',
      'post_row',
      'zoo',
      'forest',
      'farmstead',
      'market',
      'station',
    ]);
    for (const loc of map.locations) {
      const d = map.districts!.find((x) => x.id === loc.district);
      expect(d, loc.id).toBeDefined();
      expect(within(loc.area, d!.rect), loc.id).toBe(true);
    }
  });

  it('has one enclosure per zoo species and roomy farm pens', () => {
    for (const species of ZOO_SPECIES) {
      const loc = map.locations.find((l) => l.id === `zoo_${species}`)!;
      expect(loc.species).toBe(species);
      expect(loc.area.w >= 6 && loc.area.h >= 5, species).toBe(true);
      expect(within(loc.pen!, loc.area)).toBe(true);
      expect(loc.spots!.filter((p) => !within({ ...p, w: 1, h: 1 }, loc.pen!)).length).toBeGreaterThanOrEqual(
        2,
      );
    }
    for (const [id, w, h] of [
      ['cow_pasture', 14, 10],
      ['sheep_pasture', 12, 9],
      ['chicken_coop', 10, 7],
    ] as const) {
      const pen = map.locations.find((l) => l.id === id)!.pen!;
      expect(pen.w >= w && pen.h >= h, id).toBe(true);
    }
  });

  it('reaches every entry, door and spot from the square', () => {
    const seen = reachable(map, map.locations.find((l) => l.id === 'square')!.entry);
    for (const loc of map.locations)
      for (const p of [loc.entry, ...(loc.door ? [loc.door] : []), ...(loc.spots ?? [])])
        expect(seen.has(p.y * map.width + p.x), `${loc.id} ${p.x},${p.y}`).toBe(true);
  });

  it('blocks the railway except at the level crossings', () => {
    const { rows, platform } = map.railway!;
    expect(platform.w).toBeGreaterThanOrEqual(12);
    const open = new Set<number>();
    for (let x = 0; x < map.width; x++) if (map.collision[rows[0] * map.width + x] === 0) open.add(x);
    expect(open.size).toBeGreaterThan(0);
    expect(open.size).toBeLessThanOrEqual(4);
  });

  it('gives every house but the player home a valid interior', () => {
    const interiors = new Map(map.interiors!.map((t) => [t.id, t]));
    for (const loc of map.locations.filter((l) => l.kind === 'house'))
      if (loc.id === 'player_home') expect(loc.interiorId).toBeUndefined();
      else expect(interiors.has(loc.interiorId!), loc.id).toBe(true);
    for (const id of ['hotel', 'post_office'])
      expect(interiors.has(map.locations.find((l) => l.id === id)!.interiorId!)).toBe(true);
    expect(interiors.get('post_office')!.objects?.map((o) => o.id)).toContain('keep_cupboard');
    for (const t of interiors.values()) {
      const n = t.width * t.height;
      for (const layer of Object.values(t.layers)) expect(layer).toHaveLength(n);
      expect(t.collision).toHaveLength(n);
      const seen = reachable(t, t.entry);
      for (const p of [t.exit, ...t.spots])
        expect(seen.has(p.y * t.width + p.x), `${t.id} ${p.x},${p.y}`).toBe(true);
    }
  });
});

describe('v1 town preservation', () => {
  const v1 = JSON.parse(readFileSync(join(root, 'test/fixtures/art-v1-town.json'), 'utf8')) as {
    width: number;
    height: number;
    layers: Record<'ground' | 'decor' | 'overhead', number[]>;
    collision: number[];
  };
  /** Authorized v2 integrations: house_laude's corner and the market road joining the v1 road. */
  const allowed = [
    { x: 44, y: 0, w: 4, h: 6 },
    { x: 44, y: 27, w: 2, h: 3 },
  ];

  it('keeps every other v1 town cell identical on every layer and in collision', () => {
    const changed: string[] = [];
    for (let y = 0; y < v1.height; y++)
      for (let x = 0; x < v1.width; x++) {
        if (allowed.some((r) => within({ x, y, w: 1, h: 1 }, r))) continue;
        const a = y * v1.width + x;
        const b = y * map.width + x;
        for (const key of ['ground', 'decor', 'overhead'] as const)
          if (map.layers[key][b] !== v1.layers[key][a]) changed.push(`${key} ${x},${y}`);
        if (map.collision[b] !== v1.collision[a]) changed.push(`collision ${x},${y}`);
      }
    expect(changed.slice(0, 20), `${changed.length} changed cells`).toEqual([]);
  });
});
