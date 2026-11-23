import {
  PLAYER_HOME_ID,
  PLAYER_ID,
  type ItemSpawnArea,
  type Location,
  type Scene,
} from '../../src/shared/types.ts';
import { rng } from './canvas.ts';
import { E, N, S, W, type Layer, type TileAtlas } from './tiles.ts';

export type Terrain =
  | 'grass'
  | 'path'
  | 'sand'
  | 'water'
  | 'soil'
  | 'gravel'
  | 'paving'
  | 'savanna'
  | 'snow'
  | 'mud'
  | 'moss'
  | 'lake'
  | 'planks';

export type DraftLocation = Location;

export interface Light {
  x: number;
  y: number;
  kind: 'lamp' | 'window';
}

/** Terrains that blend into each other without a grass seam. */
const JOINS: Record<Terrain, Terrain[]> = {
  grass: [],
  path: ['path', 'sand', 'paving', 'planks'],
  sand: ['sand', 'path'],
  water: ['water'],
  soil: ['soil'],
  gravel: ['gravel'],
  paving: ['paving', 'path'],
  savanna: ['savanna'],
  snow: ['snow'],
  mud: ['mud'],
  moss: ['moss'],
  lake: ['lake', 'planks'],
  planks: ['planks', 'path'],
};

/** Terrains nobody can walk on. */
const BLOCKING = new Set<Terrain>(['water', 'lake']);

export class MapBuilder {
  readonly terrain: Terrain[];
  readonly layers: Record<Layer, (string | null)[]>;
  readonly collision: (0 | 1)[];
  readonly locations: DraftLocation[] = [];
  readonly lights: Light[] = [];
  private readonly reserved = new Set<number>();

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly atlas: TileAtlas,
  ) {
    const size = width * height;
    this.terrain = new Array<Terrain>(size).fill('grass');
    this.layers = {
      ground: new Array<string | null>(size).fill(null),
      decor: new Array<string | null>(size).fill(null),
      overhead: new Array<string | null>(size).fill(null),
    };
    this.collision = new Array<0 | 1>(size).fill(0);
  }

  private i(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  paint(x: number, y: number, w: number, h: number, t: Terrain): void {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) if (this.inBounds(xx, yy)) this.terrain[this.i(xx, yy)] = t;
  }

  paintEllipse(cx: number, cy: number, rx: number, ry: number, t: Terrain): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1 && this.inBounds(x, y)) this.terrain[this.i(x, y)] = t;
      }
  }

  terrainAt(x: number, y: number): Terrain | null {
    return this.inBounds(x, y) ? this.terrain[this.i(x, y)]! : null;
  }

  /** Places a multi-tile object; throws if it overlaps another object so layout mistakes are caught. */
  place(name: string, x: number, y: number): { x: number; y: number } {
    const def = this.atlas.objects[name];
    if (!def) throw new Error(`unknown object ${name}`);
    for (let dy = 0; dy < def.h; dy++) {
      for (let dx = 0; dx < def.w; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        if (!this.inBounds(tx, ty)) throw new Error(`${name} at ${x},${y} is out of bounds`);
        const idx = this.i(tx, ty);
        for (const layer of ['decor', 'overhead'] as const) {
          const cell = def.layers[layer]?.[dy]?.[dx] ?? null;
          if (cell === null) continue;
          if (this.layers[layer][idx] !== null)
            throw new Error(
              `${name} at ${x},${y} overlaps ${this.layers[layer][idx]} on ${layer} (${tx},${ty})`,
            );
          this.layers[layer][idx] = cell;
        }
        if (def.collision[dy]?.[dx]) this.collision[idx] = 1;
      }
    }
    return { x, y };
  }

  /** Places a building and returns its door tile (absolute). */
  building(name: string, x: number, y: number): { x: number; y: number } {
    this.place(name, x, y);
    const def = this.atlas.objects[name]!;
    const door = def.anchors!.door!;
    for (let dy = 0; dy < def.h; dy++)
      for (let dx = 0; dx < def.w; dx++) {
        const cell = def.layers.decor?.[dy]?.[dx] ?? def.layers.overhead?.[dy]?.[dx];
        if (cell && this.atlas.lit.has(cell) && dy >= def.h - 2) {
          if (dy === def.h - 2 && dx !== door.x) this.lights.push({ x: x + dx, y: y + dy, kind: 'window' });
        }
      }
    return { x: x + door.x, y: y + door.y };
  }

  lamp(x: number, y: number): void {
    this.place('lamp', x, y);
    this.lights.push({ x, y, kind: 'lamp' });
  }

  fence(
    x: number,
    y: number,
    w: number,
    h: number,
    gaps: { x: number; y: number }[] = [],
    prefix = 'fence',
  ): void {
    const cells = new Set<string>();
    for (let xx = x; xx < x + w; xx++) {
      cells.add(`${xx},${y}`);
      cells.add(`${xx},${y + h - 1}`);
    }
    for (let yy = y; yy < y + h; yy++) {
      cells.add(`${x},${yy}`);
      cells.add(`${x + w - 1},${yy}`);
    }
    for (const g of gaps) cells.delete(`${g.x},${g.y}`);
    for (const key of cells) {
      const [fx, fy] = key.split(',').map(Number) as [number, number];
      let mask = 0;
      if (cells.has(`${fx},${fy - 1}`)) mask |= N;
      if (cells.has(`${fx + 1},${fy}`)) mask |= E;
      if (cells.has(`${fx},${fy + 1}`)) mask |= S;
      if (cells.has(`${fx - 1},${fy}`)) mask |= W;
      const idx = this.i(fx, fy);
      if (this.layers.decor[idx] !== null) throw new Error(`fence overlaps at ${fx},${fy}`);
      this.layers.decor[idx] = `${prefix}_${mask}`;
      this.collision[idx] = 1;
    }
  }

  /** Places an object only if every cell is free and on one of the given terrains; used for scattered nature. */
  tryPlace(name: string, x: number, y: number, on: readonly Terrain[] = ['grass']): boolean {
    const def = this.atlas.objects[name]!;
    for (let dy = 0; dy < def.h; dy++)
      for (let dx = 0; dx < def.w; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        if (!this.inBounds(tx, ty)) return false;
        const idx = this.i(tx, ty);
        if (
          this.reserved.has(idx) ||
          !on.includes(this.terrain[idx]!) ||
          this.layers.decor[idx] ||
          this.layers.overhead[idx] ||
          this.collision[idx]
        )
          return false;
      }
    this.place(name, x, y);
    return true;
  }

  /** Resolves terrain to autotile names and grass variants. */
  finalizeGround(seed: number): void {
    const r = rng(seed);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const t = this.terrain[this.i(x, y)]!;
        if (t === 'grass') {
          const v = r();
          const variant = v < 0.45 ? 0 : v < 0.65 ? 1 : v < 0.8 ? 2 : v < 0.88 ? 3 : v < 0.94 ? 4 : 5;
          this.layers.ground[this.i(x, y)] = `grass_${variant}`;
          continue;
        }
        const same = (nx: number, ny: number) => {
          const n = this.terrainAt(nx, ny);
          return n === null || JOINS[t].includes(n);
        };
        let mask = 0;
        if (same(x, y - 1)) mask |= N;
        if (same(x + 1, y)) mask |= E;
        if (same(x, y + 1)) mask |= S;
        if (same(x - 1, y)) mask |= W;
        this.layers.ground[this.i(x, y)] = `${t}_${mask}`;
        if (BLOCKING.has(t)) this.collision[this.i(x, y)] = 1;
      }
    }
  }

  walkable(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.collision[this.i(x, y)] === 0;
  }

  location(loc: DraftLocation): void {
    this.locations.push(loc);
  }

  /** Keeps scattered nature off the cells an object would cover once placed later. */
  reserveObject(name: string, x: number, y: number): void {
    const def = this.atlas.objects[name];
    if (!def) throw new Error(`unknown object ${name}`);
    for (let dy = 0; dy < def.h; dy++)
      for (let dx = 0; dx < def.w; dx++)
        if (this.inBounds(x + dx, y + dy)) this.reserved.add(this.i(x + dx, y + dy));
  }

  /** Keeps scattered nature off every entry, door and activity spot (and the tiles around entries). */
  reserveLocationTiles(): void {
    for (const loc of this.locations) {
      for (const p of [loc.entry, ...(loc.door ? [loc.door] : []), ...(loc.spots ?? [])]) {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if (this.inBounds(p.x + dx, p.y + dy)) this.reserved.add(this.i(p.x + dx, p.y + dy));
      }
    }
  }
}

export interface DecorationDef {
  id: string;
  name: string;
  emoji: string;
  cost: number;
  /** Object name in assets/tiles/village.json `objects`. */
  sprite: string;
  slot: number;
}

export interface VillageDraft {
  builder: MapBuilder;
  scenes: Scene[];
  itemSpawns: ItemSpawnArea[];
  decorations: DecorationDef[];
}

/** Reference "Decorate your cottage" items, in the reference order; slot = index into player_home decorSlots. */
const DECORATIONS: Omit<DecorationDef, 'slot'>[] = [
  { id: 'welcome_rug', name: 'Welcome rug', emoji: '🟥', cost: 6, sprite: 'deco_rug' },
  { id: 'porch_cushion', name: 'Porch cushion', emoji: '🪑', cost: 6, sprite: 'deco_cushion' },
  { id: 'flower_vase', name: 'Flower vase', emoji: '🏺', cost: 8, sprite: 'deco_vase' },
  { id: 'lanterns', name: 'Lanterns', emoji: '🏮', cost: 10, sprite: 'deco_lantern' },
  { id: 'flower_pots', name: 'Flower pots', emoji: '🪴', cost: 8, sprite: 'deco_flowerpots' },
  { id: 'garden_bench', name: 'Garden bench', emoji: '🪵', cost: 12, sprite: 'deco_bench' },
  { id: 'string_lights', name: 'String lights', emoji: '✨', cost: 15, sprite: 'deco_string_lights' },
  { id: 'mailbox', name: 'Mailbox', emoji: '📮', cost: 6, sprite: 'deco_mailbox' },
  { id: 'flag', name: 'Flag', emoji: '🚩', cost: 6, sprite: 'deco_flag' },
  { id: 'bird_bath', name: 'Bird bath', emoji: '🐦', cost: 10, sprite: 'deco_birdbath' },
];

/** Top-left tile of each decoration slot around the player cottage (same order as DECORATIONS). */
const DECOR_SLOTS = [
  { x: 3, y: 27 },
  { x: 1, y: 26 },
  { x: 1, y: 25 },
  { x: 1, y: 24 },
  { x: 6, y: 28 },
  { x: 2, y: 28 },
  { x: 2, y: 22 },
  { x: 1, y: 27 },
  { x: 0, y: 23 },
  { x: 5, y: 28 },
];

const HOUSE_SLOTS_TOP = [
  { x: 2, color: 'brown' },
  { x: 8, color: 'blue' },
  { x: 26, color: 'teal' },
  { x: 32, color: 'red' },
  { x: 38, color: 'slate' },
] as const;

const HOUSE_SLOTS_BOTTOM = [
  { x: 8, color: 'green' },
  { x: 14, color: 'brown' },
  { x: 20, color: 'blue' },
  { x: 26, color: 'red' },
  { x: 32, color: 'slate' },
  { x: 38, color: 'teal' },
] as const;

/** The reference layout ("Thinkyville"), adapted: see specs/visual-style-guide.md §5. */
export function buildVillage(atlas: TileAtlas): VillageDraft {
  const m = new MapBuilder(48, 30, atlas);
  layoutTown(m);
  m.reserveLocationTiles();
  townTrees(m);
  m.finalizeGround(7);
  townScatter(m);
  const decorations = DECORATIONS.map((d, slot) => ({ ...d, slot }));
  return { builder: m, scenes: [...TOWN_SCENES], itemSpawns: [...TOWN_ITEM_SPAWNS], decorations };
}

export const DECORATION_DEFS: DecorationDef[] = DECORATIONS.map((d, slot) => ({ ...d, slot }));

/** Lays out the v1 town (roads, buildings, locations, furniture) in tiles x0-47 y0-29 of any builder. */
export function layoutTown(m: MapBuilder): void {
  const TOP_Y = 2;
  const BOTTOM_Y = 23;

  // roads
  m.paint(0, 7, 48, 2, 'path');
  m.paint(0, 20, 48, 2, 'path');
  m.paint(0, 27, 48, 1, 'path');
  m.paint(14, 9, 1, 11, 'path');
  m.paint(33, 9, 1, 11, 'path');
  for (const gx of [7, 25, 43]) m.paint(gx, 22, 1, 5, 'path');

  // plaza
  m.paintEllipse(23.5, 14.5, 8, 5.6, 'sand');
  m.paint(21, 9, 6, 1, 'sand');

  // park pond
  m.paintEllipse(41, 17, 3.6, 2, 'water');

  // farm
  m.paint(5, 11, 7, 7, 'soil');
  m.paint(13, 14, 1, 1, 'path');

  // buildings (top row)
  let houseNo = 0;
  const addHouse = (color: string, x: number, y: number) => {
    houseNo++;
    const door = m.building(`house_${color}`, x, y);
    const id = `house_${String(houseNo).padStart(2, '0')}`;
    const entry = { x: door.x, y: door.y + 1 };
    m.paint(entry.x, entry.y, 1, 1, 'path');
    m.location({
      id,
      name: `${color[0]!.toUpperCase()}${color.slice(1)} house`,
      kind: 'house',
      area: { x, y, w: 5, h: 4 },
      entry,
      door,
      spots: [entry, { x: entry.x - 1, y: entry.y }, { x: entry.x + 1, y: entry.y }],
    });
  };
  for (const h of HOUSE_SLOTS_TOP) addHouse(h.color, h.x, TOP_Y);
  const bakeryDoor = m.building('bakery', 15, TOP_Y);
  m.paint(bakeryDoor.x, bakeryDoor.y + 1, 1, 1, 'path');
  m.location({
    id: 'bakery',
    name: 'Bakery & Café',
    kind: 'shop',
    area: { x: 15, y: TOP_Y, w: 9, h: 4 },
    entry: { x: bakeryDoor.x, y: bakeryDoor.y + 1 },
    door: bakeryDoor,
    spots: [
      { x: 17, y: 6 },
      { x: 18, y: 6 },
      { x: 20, y: 6 },
      { x: 21, y: 6 },
    ],
    description:
      'Red-roofed bakery and café with a striped awning; bake-offs and open-mic nights happen here.',
  });

  // bottom row: player cottage + villager houses
  const playerDoor = m.building('house_purple', 2, BOTTOM_Y);
  m.location({
    id: PLAYER_HOME_ID,
    name: 'Your cottage',
    kind: 'house',
    area: { x: 0, y: BOTTOM_Y - 1, w: 8, h: 7 },
    entry: { x: playerDoor.x, y: playerDoor.y + 1 },
    door: playerDoor,
    ownerIds: [PLAYER_ID],
    decorSlots: DECOR_SLOTS,
    description: 'The player cottage; bought decorations appear in its decorSlots.',
  });
  for (const h of HOUSE_SLOTS_BOTTOM) {
    houseNo++;
    const door = m.building(`house_${h.color}`, h.x, BOTTOM_Y);
    const id = `house_${String(houseNo).padStart(2, '0')}`;
    const entry = { x: door.x, y: door.y + 1 };
    m.location({
      id,
      name: `${h.color[0]!.toUpperCase()}${h.color.slice(1)} cottage`,
      kind: 'house',
      area: { x: h.x, y: BOTTOM_Y, w: 5, h: 4 },
      entry,
      door,
      spots: [entry, { x: entry.x - 1, y: entry.y }, { x: entry.x + 1, y: entry.y }],
    });
  }

  // shop
  const shopDoor = m.building('shop', 35, 10);
  m.paint(34, 14, 5, 1, 'path');
  m.paint(shopDoor.x, shopDoor.y + 1, 1, 1, 'path');
  m.place('crate', 40, 14);
  m.place('crate', 41, 14);
  m.place('barrel', 42, 14);
  m.location({
    id: 'shop',
    name: 'General Store',
    kind: 'shop',
    area: { x: 35, y: 10, w: 7, h: 4 },
    entry: { x: shopDoor.x, y: shopDoor.y + 1 },
    door: shopDoor,
    spots: [
      { x: 36, y: 15 },
      { x: 37, y: 15 },
      { x: 39, y: 14 },
    ],
  });

  // plaza furniture
  m.place('fountain', 22, 12);
  m.place('bench', 17, 13);
  m.place('bench', 29, 13);
  m.place('bench', 19, 17);
  m.place('bench', 27, 17);
  m.place('stall_red', 17, 9);
  m.place('stall_blue', 29, 9);
  m.location({
    id: 'square',
    name: 'Town Square',
    kind: 'public',
    area: { x: 16, y: 9, w: 16, h: 11 },
    entry: { x: 23, y: 16 },
    spots: [
      { x: 21, y: 15 },
      { x: 26, y: 15 },
      { x: 23, y: 16 },
      { x: 24, y: 16 },
      { x: 18, y: 12 },
      { x: 30, y: 12 },
      { x: 20, y: 18 },
      { x: 28, y: 18 },
      { x: 21, y: 11 },
      { x: 26, y: 11 },
    ],
    description:
      'Oval sandy square with a fountain, benches and two market stalls; the usual place for events.',
  });

  // farm
  m.fence(1, 10, 12, 9, [{ x: 12, y: 14 }]);
  m.place('shed', 2, 11);
  m.place('well', 2, 15);
  const crops = [
    'crop_wheat',
    'crop_cabbage',
    'crop_carrot',
    'crop_sprout',
    'crop_pumpkin',
    'crop_wheat',
    'crop_cabbage',
  ];
  for (let y = 11; y < 18; y++) for (let x = 5; x < 12; x++) if (x % 2 === 1) m.place(crops[y - 11]!, x, y);
  m.location({
    id: 'farm',
    name: 'Farm',
    kind: 'nature',
    area: { x: 1, y: 10, w: 12, h: 9 },
    entry: { x: 13, y: 14 },
    spots: [
      { x: 6, y: 12 },
      { x: 8, y: 14 },
      { x: 10, y: 16 },
      { x: 6, y: 16 },
      { x: 11, y: 12 },
    ],
    description: 'Fenced vegetable field with a shed and a well; gate on the east side.',
  });

  // park
  m.place('lilypad', 40, 17);
  m.place('bench', 37, 18);
  m.place('tree_blossom', 44, 15);
  m.place('tree_green', 35, 16);
  m.place('flowers_pink', 39, 15);
  m.place('flowers_yellow', 44, 18);
  m.place('flowers_blue', 46, 19);
  m.location({
    id: 'park',
    name: 'Pond Park',
    kind: 'nature',
    area: { x: 34, y: 15, w: 14, h: 5 },
    entry: { x: 38, y: 19 },
    spots: [
      { x: 37, y: 19 },
      { x: 39, y: 19 },
      { x: 42, y: 19 },
      { x: 46, y: 16 },
      { x: 37, y: 15 },
    ],
    description: 'Small park around a lily pond, with blossom trees and a bench.',
  });

  // signs and lamps
  m.place('sign_town', 42, 9);
  for (const x of [7, 13, 24, 31, 37, 43]) m.lamp(x, 5);
  for (const x of [13, 19, 31, 37]) m.lamp(x, 22);
  m.lamp(16, 18);
  m.lamp(31, 17);

  // player cottage decoration slots stay free; the client draws placed decorations there
  DECORATIONS.forEach((d, i) => m.reserveObject(d.sprite, DECOR_SLOTS[i]!.x, DECOR_SLOTS[i]!.y));
}

/** Border tree rows of the town; call after every location is reserved. */
export function townTrees(m: MapBuilder): void {
  for (let x = 0; x < 48; x += 2) {
    m.tryPlace(x % 6 === 4 ? 'tree_autumn' : 'tree_green', x, 0);
    if (x >= 8) m.tryPlace(x % 8 === 2 ? 'tree_autumn' : 'tree_green', x, 28);
  }
}

/** Scattered bushes, rocks and flowers in the town; call after finalizeGround. */
export function townScatter(m: MapBuilder): void {
  const r = rng(99);
  const scatter = [
    'bush',
    'bush_berries',
    'bush_flowers',
    'rock',
    'flowers_pink',
    'flowers_yellow',
    'flowers_blue',
  ];
  for (const [x, y] of [
    [44, 2],
    [44, 4],
    [46, 3],
    [0, 4],
    [13, 2],
    [24, 3],
    [31, 3],
    [37, 2],
    [15, 10],
    [16, 18],
    [0, 11],
    [0, 15],
    [44, 12],
    [46, 12],
    [34, 12],
    [12, 23],
    [18, 22],
    [30, 22],
    [44, 23],
    [46, 25],
    [44, 25],
    [1, 22],
  ] as const) {
    if (!m.tryPlace(r() < 0.5 ? 'tree_green' : 'tree_autumn', x, y))
      m.tryPlace(scatter[Math.floor(r() * scatter.length)]!, x, y);
  }
  for (let k = 0; k < 60; k++) {
    const x = Math.floor(r() * 48);
    const y = Math.floor(r() * 30);
    m.tryPlace(scatter[Math.floor(r() * scatter.length)]!, x, y);
  }
}

export const TOWN_SCENES: readonly Scene[] = [
  { id: 'plaza', name: 'Plaza', subtitle: 'The old town', rect: { x: 0, y: 0, w: 48, h: 30 } },
  { id: 'farm', name: 'Farm', subtitle: 'Crop field', rect: { x: 0, y: 8, w: 18, h: 12 } },
  { id: 'shop_street', name: 'Shop street', subtitle: 'General Store', rect: { x: 26, y: 2, w: 22, h: 14 } },
  { id: 'park', name: 'Park', subtitle: 'Pond Park', rect: { x: 30, y: 12, w: 18, h: 10 } },
  { id: 'square', name: 'Town square', subtitle: 'Fountain and stalls', rect: { x: 13, y: 5, w: 22, h: 16 } },
  { id: 'home', name: 'Your home', subtitle: 'Your cottage', rect: { x: 0, y: 18, w: 16, h: 12 } },
];

export const TOWN_ITEM_SPAWNS: readonly ItemSpawnArea[] = [
  { itemId: 'flower', area: { x: 34, y: 15, w: 13, h: 5 }, max: 4 },
  { itemId: 'apple', area: { x: 0, y: 2, w: 48, h: 4 }, max: 3 },
  { itemId: 'seed', area: { x: 1, y: 10, w: 12, h: 9 }, max: 3 },
  { itemId: 'gem', area: { x: 13, y: 22, w: 34, h: 5 }, max: 1 },
];
