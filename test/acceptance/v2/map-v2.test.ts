/** AC8: one contiguous 128×60 map with districts, reachable everywhere; the v1 town is unchanged. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLAYER_HOME_ID,
  ZOO_SPECIES,
  type DistrictId,
  type Location,
  type LocationKind,
  type Point,
  type Rect,
  type WorldMap,
} from '../../../src/shared/types.ts';
import { DEFAULT_CONFIG } from '../../../src/server/config.ts';
import { findPath } from '../../../src/server/sim/pathfinding.ts';
import { featurePath, readyV2, repoPath, waitingForV2, type Feature } from '../../helpers/features.ts';
import { loc } from '../../helpers/v2.ts';

const F: Feature[] = ['villageMap'];

interface V1Fixture {
  width: number;
  height: number;
  locations: { id: string; kind: LocationKind; area: Rect; entry: Point; door?: Point }[];
  scenes: { id: string; rect: Rect }[];
  /** Every layer of the v1 map (e769b2b), one array per tile row. */
  layers: Record<'ground' | 'decor' | 'overhead' | 'collision', number[][]>;
}

/** Spec v2 §2.1: the only town tiles that may differ from v1 (house_laude; the main road's south edge). */
const TOWN_EXCEPTIONS: Rect[] = [
  { x: 44, y: 0, w: 4, h: 6 },
  { x: 43, y: 27, w: 4, h: 3 },
];

/** Spec v2 §2.1 district rects. */
const DISTRICT_RECTS: Record<DistrictId, Rect> = {
  town: { x: 0, y: 0, w: 48, h: 30 },
  post_row: { x: 44, y: 0, w: 20, h: 9 },
  zoo: { x: 48, y: 0, w: 48, h: 34 },
  forest: { x: 96, y: 0, w: 32, h: 60 },
  farmstead: { x: 0, y: 30, w: 36, h: 30 },
  market: { x: 36, y: 30, w: 12, h: 30 },
  station: { x: 48, y: 34, w: 48, h: 26 },
};

const readJson = (rel: string): unknown => JSON.parse(readFileSync(repoPath(rel), 'utf8'));

const DISTRICTS: DistrictId[] = ['town', 'post_row', 'zoo', 'forest', 'farmstead', 'market', 'station'];

const ENCLOSURES = ZOO_SPECIES.map((s) => `zoo_${s}`);

/** Spec v2 §2.1: id -> kind and district. */
const V2_LOCATIONS: [string, LocationKind, DistrictId][] = [
  ['house_laude', 'house', 'post_row'],
  ['post_office', 'post', 'post_row'],
  ['notice_board', 'public', 'post_row'],
  ['house_franzi', 'house', 'post_row'],
  ['zoo_gate', 'zoo', 'zoo'],
  ...ENCLOSURES.map((id): [string, LocationKind, DistrictId] => [id, 'zoo', 'zoo']),
  ['rollercoaster', 'ride', 'zoo'],
  ['ferris_wheel', 'ride', 'zoo'],
  ['carousel', 'ride', 'zoo'],
  ['burger_joint', 'food', 'zoo'],
  ['ice_cream_truck_1', 'food', 'zoo'],
  ['ice_cream_truck_2', 'food', 'zoo'],
  ['forest', 'nature', 'forest'],
  ['forest_grove', 'nature', 'forest'],
  ['forest_lake', 'nature', 'forest'],
  ['cow_pasture', 'farm', 'farmstead'],
  ['sheep_pasture', 'farm', 'farmstead'],
  ['chicken_coop', 'farm', 'farmstead'],
  ['barn', 'farm', 'farmstead'],
  ['farmhouse', 'farm', 'farmstead'],
  ['butcher', 'farm', 'farmstead'],
  ['market', 'public', 'market'],
  ['station', 'station', 'station'],
  ['hotel', 'hotel', 'station'],
];

const NEW_SCENES = ['overview', 'post_row', 'zoo', 'rides', 'forest', 'farmstead', 'station', 'market'];

const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;

const contains = (r: Rect, p: Point) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

const walkableAt = (m: WorldMap, p: Point) =>
  p.x >= 0 && p.y >= 0 && p.x < m.width && p.y < m.height && m.collision[p.y * m.width + p.x] === 0;

/** Size of the largest 4-connected walkable region that stays inside `r`. */
function largestWalkableRegion(m: WorldMap, r: Rect): number {
  const seen = new Set<number>();
  let best = 0;
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) {
      const k = y * m.width + x;
      if (seen.has(k) || !walkableAt(m, { x, y })) continue;
      seen.add(k);
      let size = 0;
      const stack: Point[] = [{ x, y }];
      while (stack.length) {
        const p = stack.pop()!;
        size++;
        for (const q of [{ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 }]) {
          const qk = q.y * m.width + q.x;
          if (!contains(r, q) || seen.has(qk) || !walkableAt(m, q)) continue;
          seen.add(qk);
          stack.push(q);
        }
      }
      best = Math.max(best, size);
    }
  return best;
}

function districtRect(m: WorldMap, id: DistrictId): Rect {
  const d = m.districts?.find((x) => x.id === id);
  if (!d) throw new Error(`map has no district ${id}`);
  return d.rect;
}

describe.skipIf(!readyV2(...F))(`AC8: the v2 map${waitingForV2(...F)}`, () => {
  const map = () => readJson(featurePath('villageMap')) as WorldMap;
  const v1 = () => readJson('test/fixtures/map-v1-locations.json') as V1Fixture;

  it('is 128×60 at tile size 16 with consistent layers', () => {
    const m = map();
    expect(m.width).toBe(128);
    expect(m.height).toBe(60);
    expect(m.tileSize).toBe(16);
    const n = m.width * m.height;
    expect(m.collision).toHaveLength(n);
    for (const layer of ['ground', 'decor', 'overhead'] as const)
      expect(m.layers[layer], layer).toHaveLength(n);
  });

  it('has 7 districts that cover the map, and only post_row overlaps others', () => {
    const m = map();
    const ids = (m.districts ?? []).map((d) => d.id);
    expect([...ids].sort()).toEqual([...DISTRICTS].sort());
    for (const d of m.districts ?? []) expect(d.rect, d.id).toEqual(DISTRICT_RECTS[d.id]);
    for (const d of m.districts ?? [])
      expect(inside(d.rect, { x: 0, y: 0, w: m.width, h: m.height }), `${d.id} inside the map`).toBe(true);
    const uncovered: string[] = [];
    for (let y = 0; y < m.height; y++)
      for (let x = 0; x < m.width; x++)
        if (!(m.districts ?? []).some((d) => contains(d.rect, { x, y }))) uncovered.push(`(${x}, ${y})`);
    expect(uncovered.slice(0, 20), `${uncovered.length} tiles in no district`).toEqual([]);
    const ds = m.districts ?? [];
    const bad: string[] = [];
    for (let i = 0; i < ds.length; i++)
      for (let j = i + 1; j < ds.length; j++) {
        const a = ds[i]!;
        const b = ds[j]!;
        if (a.id !== 'post_row' && b.id !== 'post_row' && overlap(a.rect, b.rect) > 0)
          bad.push(`${a.id} overlaps ${b.id}`);
      }
    expect(bad).toEqual([]);
  });

  it('has every §2.1 id with the right kind, inside its district', () => {
    const m = map();
    const problems: string[] = [];
    const expected: [string, LocationKind, DistrictId][] = [
      ...v1().locations.map((l): [string, LocationKind, DistrictId] => [l.id, l.kind, 'town']),
      ...V2_LOCATIONS,
    ];
    for (const [id, kind, district] of expected) {
      const l = m.locations.find((x) => x.id === id);
      if (!l) {
        problems.push(`${id}: missing`);
        continue;
      }
      if (l.kind !== kind) problems.push(`${id}: kind ${l.kind}, expected ${kind}`);
      if (l.district !== undefined && l.district !== district)
        problems.push(`${id}: district ${l.district}, expected ${district}`);
      if (!inside(l.area, districtRect(m, district))) problems.push(`${id}: area outside ${district}`);
    }
    expect(problems).toEqual([]);
    const ids = m.locations.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('places the post row exactly as §2.1 says', () => {
    const m = map();
    const laude = loc(m, 'house_laude');
    expect(laude.area).toEqual({ x: 44, y: 2, w: 5, h: 4 });
    expect(laude.door).toEqual({ x: 46, y: 5 });
    expect(laude.entry).toEqual({ x: 46, y: 6 });
    expect(laude.ownerIds ?? [], 'house_laude ownerIds').toContain('laude');
    const post = loc(m, 'post_office');
    expect(post.area).toEqual({ x: 50, y: 2, w: 7, h: 4 });
    expect(post.door).toEqual({ x: 53, y: 5 });
    expect(post.entry).toEqual({ x: 53, y: 6 });
    expect(post.hours).toEqual({ open: '08:00', close: '18:00' });
    expect(post.perch?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(post.perch?.length ?? 0).toBeLessThanOrEqual(4);
    for (const p of post.perch ?? [])
      expect(contains(post.area, p), `perch ${p.x},${p.y} on the roof`).toBe(true);
    const franzi = loc(m, 'house_franzi');
    expect(franzi.area).toEqual({ x: 58, y: 2, w: 5, h: 4 });
    expect(franzi.door).toEqual({ x: 60, y: 5 });
    expect(franzi.entry).toEqual({ x: 60, y: 6 });
    expect(franzi.ownerIds ?? [], 'house_franzi ownerIds').toContain('franzi');
    const board = loc(m, 'notice_board');
    expect(overlap(board.area, { x: 56, y: 6, w: 2, h: 1 })).toBeGreaterThan(0);
    const gate = loc(m, 'zoo_gate');
    expect(Math.abs(gate.entry.x - 64)).toBeLessThanOrEqual(1);
    expect(gate.entry.y).toBeGreaterThanOrEqual(7);
    expect(gate.entry.y).toBeLessThanOrEqual(8);
  });

  it('has food venues and rides with the §2.1 hours and ride specs', () => {
    const m = map();
    expect(loc(m, 'burger_joint').hours).toEqual({ open: '11:00', close: '21:00' });
    for (const id of ['ice_cream_truck_1', 'ice_cream_truck_2'])
      expect(loc(m, id).hours, id).toEqual({ open: '10:00', close: '19:00' });
    expect(loc(m, 'rollercoaster').ride).toEqual({
      capacity: 8,
      durationMin: 10,
      playerCost: 4,
      funGain: 35,
    });
    expect(loc(m, 'ferris_wheel').ride).toEqual({ capacity: 8, durationMin: 15, playerCost: 3, funGain: 25 });
    expect(loc(m, 'carousel').ride).toEqual({ capacity: 6, durationMin: 8, playerCost: 2, funGain: 20 });
    const zooHours = { open: DEFAULT_CONFIG.zoo.openTime, close: DEFAULT_CONFIG.zoo.closeTime };
    for (const l of m.locations.filter((x) => x.kind === 'zoo' || x.kind === 'ride'))
      if (l.hours) expect(l.hours, l.id).toEqual(zooHours);
  });

  it('reaches every location entry from the square entry by A*', () => {
    const m = map();
    const from = loc(m, 'square').entry;
    const unreachable = m.locations
      .filter((l) => findPath(m, from, l.entry) === null)
      .map((l) => `${l.id} (${l.entry.x}, ${l.entry.y})`);
    expect(unreachable).toEqual([]);
  });

  it('keeps the v1 locations exactly (ids, rects, entries, doors)', () => {
    const m = map();
    const fixture = v1();
    expect(fixture.locations.length).toBeGreaterThanOrEqual(17);
    for (const f of fixture.locations) {
      const l = loc(m, f.id);
      const actual: { id: string; kind: LocationKind; area: Rect; entry: Point; door?: Point } = {
        id: l.id,
        kind: l.kind,
        area: l.area,
        entry: l.entry,
      };
      if (l.door) actual.door = l.door;
      expect(actual, f.id).toEqual(f);
    }
  });

  it('keeps every v1 town tile in every layer, except the two §2.1 exceptions', () => {
    const m = map();
    const fx = v1();
    const layers = { ...m.layers, collision: m.collision };
    const changed: string[] = [];
    for (const key of ['ground', 'decor', 'overhead', 'collision'] as const)
      for (let y = 0; y < fx.height; y++)
        for (let x = 0; x < fx.width; x++) {
          if (TOWN_EXCEPTIONS.some((r) => contains(r, { x, y }))) continue;
          const was = fx.layers[key][y]![x];
          const now = layers[key][y * m.width + x];
          if (now !== was) changed.push(`${key} (${x}, ${y}): ${was} -> ${now}`);
        }
    expect(changed.slice(0, 20), `${changed.length} changed v1 town tiles`).toEqual([]);
  });

  it('keeps the v1 scenes and adds the 8 new ones, all inside the map', () => {
    const m = map();
    for (const s of v1().scenes) {
      const now = m.scenes.find((x) => x.id === s.id);
      expect(now?.rect, `v1 scene ${s.id}`).toEqual(s.rect);
    }
    const ids = m.scenes.map((s) => s.id);
    for (const id of NEW_SCENES) expect(ids, `scene ${id}`).toContain(id);
    expect(m.scenes.find((s) => s.id === 'overview')?.rect).toEqual({ x: 0, y: 0, w: 128, h: 60 });
    const bounds = { x: 0, y: 0, w: m.width, h: m.height };
    for (const s of m.scenes) {
      expect(s.rect.w > 0 && s.rect.h > 0, `${s.id} not empty`).toBe(true);
      expect(inside(s.rect, bounds), `${s.id} inside the map`).toBe(true);
      expect(s.name, s.id).toBeTruthy();
    }
  });

  it('gives enclosures and pastures their minimum sizes', () => {
    const m = map();
    const problems: string[] = [];
    const rows = { A: [0, 6], B: [9, 15], C: [18, 24] } as const;
    const perRow: Record<keyof typeof rows, number> = { A: 0, B: 0, C: 0 };
    for (const species of ZOO_SPECIES) {
      const l = loc(m, `zoo_${species}`);
      if (l.species !== species) problems.push(`${l.id}: species ${l.species}`);
      // Spec v2 §2.1: the outer rect (fence included) is at least 6×5; the pen is the walkable
      // inside of the fence, at least 4×3.
      if (l.area.w < 6 || l.area.h < 5) problems.push(`${l.id}: outer ${l.area.w}×${l.area.h} < 6×5`);
      if (!l.pen) problems.push(`${l.id}: no pen`);
      else {
        if (!inside(l.pen, l.area)) problems.push(`${l.id}: pen outside its area`);
        if (l.pen.w < 4 || l.pen.h < 3) problems.push(`${l.id}: pen ${l.pen.w}×${l.pen.h} < 4×3`);
        // Props (trees, rocks, a pond) may sit in a pen; the animals still need one open
        // patch at least as large as the 4×3 minimum.
        const open = largestWalkableRegion(m, l.pen);
        if (open < 12) problems.push(`${l.id}: largest open patch in the pen is ${open} tiles < 12`);
      }
      const viewing = (l.spots ?? []).filter((p) => !l.pen || !contains(l.pen, p));
      if (viewing.length < 2) problems.push(`${l.id}: ${viewing.length} viewing spots outside the fence`);
      for (const p of viewing) if (!walkableAt(m, p)) problems.push(`${l.id}: spot (${p.x}, ${p.y}) blocked`);
      for (const [row, [y0, y1]] of Object.entries(rows) as [keyof typeof rows, readonly [number, number]][])
        if (l.area.y >= y0 && l.area.y + l.area.h - 1 <= y1) perRow[row]++;
    }
    expect(perRow).toEqual({ A: 4, B: 6, C: 2 });
    const minimum: [string, number, number, string | undefined][] = [
      ['cow_pasture', 14, 10, 'cow'],
      ['sheep_pasture', 12, 9, 'sheep'],
      ['chicken_coop', 10, 7, 'chicken'],
      ['rollercoaster', 14, 8, undefined],
    ];
    for (const [id, w, h, species] of minimum) {
      const l = loc(m, id);
      if (l.area.w < w || l.area.h < h) problems.push(`${id}: ${l.area.w}×${l.area.h} < ${w}×${h}`);
      if (species && l.species !== species) problems.push(`${id}: species ${l.species}`);
      if (species && !l.pen) problems.push(`${id}: no pen`);
    }
    const coaster = loc(m, 'rollercoaster').area;
    if (coaster.y < 18 || coaster.y + coaster.h > 31) problems.push('rollercoaster outside y 18–30');
    const platform = m.railway?.platform;
    if (!platform) problems.push('no railway platform');
    else if (Math.max(platform.w, platform.h) < 12 || Math.min(platform.w, platform.h) < 2)
      problems.push(`platform ${platform.w}×${platform.h} < 12×2`);
    expect(problems).toEqual([]);
  });

  it('gives every house except player_home an interior, and the post office the keep_cupboard', () => {
    const m = map();
    const interiors = new Map((m.interiors ?? []).map((t) => [t.id, t]));
    const problems: string[] = [];
    const houses = m.locations.filter((l) => l.kind === 'house');
    for (const l of houses) {
      if (l.id === PLAYER_HOME_ID) {
        if (l.interiorId) problems.push('player_home has an interior');
        continue;
      }
      if (!l.interiorId) problems.push(`${l.id}: no interiorId`);
      else if (!interiors.has(l.interiorId)) problems.push(`${l.id}: unknown interior ${l.interiorId}`);
    }
    const houseTemplates = new Set(houses.map((l) => l.interiorId).filter((x): x is string => !!x));
    expect(houseTemplates.size, 'house templates').toBeGreaterThanOrEqual(2);
    expect(houseTemplates.size, 'house templates').toBeLessThanOrEqual(3);
    for (const id of ['hotel', 'post_office']) {
      const l: Location = loc(m, id);
      if (!l.interiorId || !interiors.has(l.interiorId)) problems.push(`${id}: no resolvable interior`);
    }
    expect(interiors.has('hotel_lobby'), 'hotel_lobby template').toBe(true);
    const post = interiors.get(loc(m, 'post_office').interiorId ?? '');
    const cupboard = post?.objects?.find((o) => o.id === 'keep_cupboard');
    expect(cupboard, 'keep_cupboard in the post office interior').toBeDefined();
    for (const t of interiors.values()) {
      const n = t.width * t.height;
      const bounds = { x: 0, y: 0, w: t.width, h: t.height };
      if (t.collision.length !== n) problems.push(`${t.id}: collision length`);
      for (const layer of ['ground', 'decor', 'overhead'] as const)
        if (t.layers[layer].length !== n) problems.push(`${t.id}: ${layer} length`);
      for (const p of [t.entry, t.exit, ...t.spots, ...(t.objects ?? []).map((o) => o.pos)])
        if (!contains(bounds, p)) problems.push(`${t.id}: (${p.x}, ${p.y}) outside the interior`);
      if (t.collision[t.entry.y * t.width + t.entry.x] !== 0) problems.push(`${t.id}: entry blocked`);
    }
    expect(problems).toEqual([]);
  });
});
