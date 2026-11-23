import { DEFAULT_CONFIG, type AppConfig } from '../../../src/server/config.ts';
import {
  ZOO_SPECIES,
  type Location,
  type Point,
  type Rect,
  type WorldMap,
} from '../../../src/shared/types.ts';
import { createAnimalSim, type AnimalSimOptions } from '../../../src/server/sim/animals.ts';

export const W = 128;
export const H = 60;

function loc(id: string, kind: Location['kind'], area: Rect, extra: Partial<Location> = {}): Location {
  return { id, name: id, kind, area, entry: { x: area.x, y: area.y + area.h }, ...extra };
}

/** Lake water: the inner rect of forest_lake; the 1-tile ring around it is walkable shore. */
export const LAKE: Rect = { x: 60, y: 40, w: 10, h: 8 };
export const WATER: Rect = { x: 61, y: 41, w: 8, h: 6 };
export const FOREST: Rect = { x: 90, y: 30, w: 30, h: 20 };
export const PERCH: Point[] = [
  { x: 20, y: 5 },
  { x: 21, y: 5 },
  { x: 22, y: 5 },
];
export const POST_OFFICE: Point = { x: 21, y: 6 };

/** Synthetic 128×60 map with the spec v2 location ids the animal sim uses. */
export function animalTestMap(): WorldMap {
  const collision: (0 | 1)[] = new Array<0 | 1>(W * H).fill(0);
  for (let y = WATER.y; y < WATER.y + WATER.h; y++)
    for (let x = WATER.x; x < WATER.x + WATER.w; x++) collision[y * W + x] = 1;
  // A few trees inside the forest.
  for (const [x, y] of [
    [95, 35],
    [100, 40],
    [110, 33],
  ] as const)
    collision[y * W + x] = 1;

  const pen = (r: Rect, extra: Partial<Location>) => ({ pen: r, ...extra });
  const locations: Location[] = [
    loc(
      'cow_pasture',
      'farm',
      { x: 5, y: 40, w: 12, h: 8 },
      pen({ x: 6, y: 41, w: 10, h: 6 }, { species: 'cow' }),
    ),
    loc(
      'sheep_pasture',
      'farm',
      { x: 20, y: 40, w: 12, h: 8 },
      pen({ x: 21, y: 41, w: 10, h: 6 }, { species: 'sheep' }),
    ),
    loc(
      'chicken_coop',
      'farm',
      { x: 35, y: 40, w: 8, h: 6 },
      pen({ x: 36, y: 41, w: 6, h: 4 }, { species: 'chicken' }),
    ),
    loc('butcher', 'shop', { x: 5, y: 20, w: 4, h: 3 }, { entry: { x: 6, y: 23 } }),
    loc('post_office', 'post', { x: 19, y: 4, w: 5, h: 3 }, { entry: POST_OFFICE, perch: PERCH }),
    loc('forest', 'nature', FOREST, { pen: FOREST }),
    loc('forest_lake', 'nature', LAKE, { pen: LAKE }),
  ];
  ZOO_SPECIES.forEach((species, i) => {
    const x = 50 + (i % 6) * 12;
    const y = 5 + Math.floor(i / 6) * 10;
    locations.push(
      loc(
        `zoo_${species}`,
        'zoo',
        { x, y, w: 10, h: 8 },
        { species, pen: { x: x + 1, y: y + 1, w: 8, h: 6 } },
      ),
    );
  });
  return {
    width: W,
    height: H,
    tileSize: 16,
    tilesets: [],
    layers: { ground: [], decor: [], overhead: [] },
    collision,
    locations,
    scenes: [],
    itemSpawns: [],
  };
}

export function testConfig(patch: { farm?: Partial<AppConfig['farm']>; seed?: number } = {}): AppConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.farm, patch.farm ?? {});
  if (patch.seed !== undefined) cfg.sim.seed = patch.seed;
  return cfg;
}

export function makeSim(opts: Partial<AnimalSimOptions> = {}) {
  return createAnimalSim({
    config: opts.config ?? testConfig(),
    map: opts.map ?? animalTestMap(),
    now: opts.now ?? 8 * 60,
    burgerStock: () => 10,
    farmerName: 'Tom',
    ...opts,
  });
}

export function inRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
}
