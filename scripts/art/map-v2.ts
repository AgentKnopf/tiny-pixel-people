import type { ItemSpawnArea, Location, Rect, Scene } from '../../src/shared/types.ts';
import { rng } from './canvas.ts';
import {
  DECORATION_DEFS,
  MapBuilder,
  TOWN_ITEM_SPAWNS,
  TOWN_SCENES,
  layoutTown,
  townScatter,
  townTrees,
  type DecorationDef,
  type Terrain,
} from './map.ts';
import { E, N, S, W, type TileAtlas } from './tiles.ts';

/** Location fields added in v2 (spec v2 §2): interior template, ambient animal habitat, crow perch. */
export interface LocationV2 extends Location {
  district?: District;
  interiorId?: InteriorId;
  /** Habitat rect for animals that live here (enclosure interior, pasture, lake, woods). */
  pen?: Rect;
  /** Roof tiles the post office crow hops between. */
  perch?: Rect;
}

export type District = 'town' | 'post_row' | 'zoo' | 'farmstead' | 'market' | 'station' | 'forest';
export type InteriorId = 'cottage_a' | 'cottage_b' | 'cottage_c' | 'hotel_lobby' | 'post_office';

export interface DistrictDef {
  id: District;
  name: string;
  rect: Rect;
}

export interface VillageV2Draft {
  builder: MapBuilder;
  locations: LocationV2[];
  scenes: Scene[];
  itemSpawns: ItemSpawnArea[];
  decorations: DecorationDef[];
  districts: DistrictDef[];
}

export const V2_WIDTH = 128;
export const V2_HEIGHT = 60;

export const DISTRICTS: DistrictDef[] = [
  { id: 'town', name: 'Old town', rect: { x: 0, y: 0, w: 48, h: 30 } },
  { id: 'post_row', name: 'Post Row', rect: { x: 44, y: 0, w: 20, h: 9 } },
  { id: 'zoo', name: 'City Zoo & Rides', rect: { x: 48, y: 0, w: 48, h: 34 } },
  { id: 'farmstead', name: 'Meadow Farm', rect: { x: 0, y: 30, w: 36, h: 30 } },
  { id: 'market', name: 'Market Road', rect: { x: 36, y: 30, w: 24, h: 30 } },
  { id: 'station', name: 'Station & Hotel', rect: { x: 60, y: 33, w: 36, h: 27 } },
  { id: 'forest', name: 'Whisper Woods', rect: { x: 96, y: 0, w: 32, h: 56 } },
];

/** Species per enclosure; ids are `enclosure_<species>`. */
export const ZOO_SPECIES = [
  'penguin',
  'polar_bear',
  'panda',
  'monkey',
  'lion',
  'zebra',
  'giraffe',
  'elephant',
  'hippo',
  'kangaroo',
  'flamingo',
  'crocodile',
] as const;
export type ZooSpecies = (typeof ZOO_SPECIES)[number];

const INTERIORS: InteriorId[] = ['cottage_a', 'cottage_b', 'cottage_c'];

const p = (x: number, y: number) => ({ x, y });

/** v2 map: the v1 town unchanged at x0-47 y0-29 plus the new districts (docs/art/README.md, spec v2 §2). */
export function buildVillageV2(atlas: TileAtlas): VillageV2Draft {
  const m = new MapBuilder(V2_WIDTH, V2_HEIGHT, atlas);
  layoutTown(m);
  const townCount = m.locations.length;
  const v2: LocationV2[] = [];
  const add = (loc: LocationV2) => {
    m.location(loc);
    v2.push(loc);
  };
  const lamp = (x: number, y: number) => {
    m.place('lamp', x, y);
    m.lights.push({ x, y, kind: 'lamp' });
  };

  // ------------------------------------------------------------ roads
  m.paint(48, 7, 16, 2, 'path'); // post row: the bakery's road continues east
  m.paint(64, 7, 32, 2, 'path'); // zoo north promenade
  m.paint(96, 7, 8, 2, 'path'); // trail into the woods
  m.paint(0, 31, V2_WIDTH, 2, 'path'); // main east-west road
  m.paint(19, 28, 1, 3, 'path'); // town -> main road (between cottages 07 and 08)
  m.paint(44, 28, 2, 28, 'path'); // market road, town -> station
  for (let x = 0; x < V2_WIDTH; x++) for (let y = 56; y <= 58; y++) m.paint(x, y, 1, 1, 'gravel');

  // ------------------------------------------------------------ post row
  const laudeDoor = m.building('house_laude', 44, 2);
  const postDoor = m.building('post_office', 50, 2);
  const franziDoor = m.building('house_franzi', 58, 2);
  for (const d of [laudeDoor, postDoor, franziDoor]) m.paint(d.x, d.y + 1, 1, 1, 'path');
  m.place('notice_board', 56, 4);
  m.place('post_box', 49, 4);
  lamp(63, 5);
  m.place('flowerpot_pink', 57, 6);
  m.place('flowerpot_yellow', 63, 3);
  add({
    id: 'house_laude',
    name: "Laude's house",
    kind: 'house',
    area: { x: 44, y: 2, w: 5, h: 4 },
    entry: p(laudeDoor.x, laudeDoor.y + 1),
    door: laudeDoor,
    spots: [
      p(laudeDoor.x, laudeDoor.y + 1),
      p(laudeDoor.x - 1, laudeDoor.y + 1),
      p(laudeDoor.x + 1, laudeDoor.y + 1),
    ],
    ownerIds: ['laude'],
    district: 'post_row',
    interiorId: 'cottage_b',
    description: 'Grey-walled cottage with an ochre roof, a short walk east of the bakery.',
  });
  add({
    id: 'post_office',
    name: 'Post Office',
    kind: 'shop',
    area: { x: 50, y: 2, w: 8, h: 5 },
    entry: p(postDoor.x, postDoor.y + 1),
    door: postDoor,
    spots: [p(postDoor.x, postDoor.y + 1), p(postDoor.x - 1, postDoor.y + 1), p(56, 6), p(57, 7), p(51, 6)],
    perch: { x: 51, y: 2, w: 4, h: 1 },
    district: 'post_row',
    interiorId: 'post_office',
    description:
      "Laude's blue-roofed post office with a notice board out front and a crow on the roof; the Keep cupboard is inside.",
  });
  add({
    id: 'house_franzi',
    name: "Franzi's house",
    kind: 'house',
    area: { x: 58, y: 2, w: 5, h: 4 },
    entry: p(franziDoor.x, franziDoor.y + 1),
    door: franziDoor,
    spots: [
      p(franziDoor.x, franziDoor.y + 1),
      p(franziDoor.x - 1, franziDoor.y + 1),
      p(franziDoor.x + 1, franziDoor.y + 1),
    ],
    ownerIds: ['franzi'],
    district: 'post_row',
    interiorId: 'cottage_c',
    description: 'Rose-roofed cottage right next to the post office.',
  });

  // ------------------------------------------------------------ zoo
  m.paint(48, 16, 48, 2, 'path'); // middle promenade
  m.paint(62, 9, 2, 7, 'path'); // north-south link through row B
  m.paint(92, 9, 4, 7, 'path'); // rest corner
  m.paint(48, 18, 48, 13, 'sand'); // rides plaza down to the main road
  const enclosures: { species: ZooSpecies; x: number; y: number; w: number; h: number; view: 'N' | 'S' }[] = [
    { species: 'penguin', x: 64, y: 0, w: 8, h: 7, view: 'S' },
    { species: 'polar_bear', x: 72, y: 0, w: 8, h: 7, view: 'S' },
    { species: 'panda', x: 80, y: 0, w: 8, h: 7, view: 'S' },
    { species: 'monkey', x: 88, y: 0, w: 8, h: 7, view: 'S' },
    { species: 'lion', x: 48, y: 9, w: 7, h: 7, view: 'S' },
    { species: 'zebra', x: 55, y: 9, w: 7, h: 7, view: 'S' },
    { species: 'giraffe', x: 64, y: 9, w: 7, h: 7, view: 'S' },
    { species: 'elephant', x: 71, y: 9, w: 7, h: 7, view: 'S' },
    { species: 'hippo', x: 78, y: 9, w: 7, h: 7, view: 'S' },
    { species: 'kangaroo', x: 85, y: 9, w: 7, h: 7, view: 'S' },
    { species: 'flamingo', x: 80, y: 18, w: 8, h: 7, view: 'N' },
    { species: 'crocodile', x: 88, y: 18, w: 8, h: 7, view: 'N' },
  ];
  const HABITAT: Record<ZooSpecies, { ground: Terrain; pool?: boolean; props: string[] }> = {
    penguin: { ground: 'snow', pool: true, props: ['rock'] },
    polar_bear: { ground: 'snow', pool: true, props: ['rock_big'] },
    panda: { ground: 'grass', props: ['bamboo', 'bamboo', 'bamboo', 'log'] },
    monkey: { ground: 'grass', props: ['tree_palm', 'log', 'tree_palm'] },
    lion: { ground: 'savanna', props: ['rock_big', 'tree_acacia'] },
    zebra: { ground: 'savanna', props: ['tree_acacia', 'trough'] },
    giraffe: { ground: 'savanna', props: ['tree_acacia', 'tree_acacia'] },
    elephant: { ground: 'mud', pool: true, props: ['hay'] },
    hippo: { ground: 'mud', pool: true, props: ['rock'] },
    kangaroo: { ground: 'savanna', props: ['bush', 'rock'] },
    flamingo: { ground: 'sand', pool: true, props: ['reeds', 'reeds'] },
    crocodile: { ground: 'mud', pool: true, props: ['log'] },
  };
  for (const e of enclosures) {
    const hab = HABITAT[e.species];
    const inner = { x: e.x + 1, y: e.y + 1, w: e.w - 2, h: e.h - 2 };
    m.paint(e.x, e.y, e.w, e.h, hab.ground === 'grass' ? 'grass' : hab.ground);
    if (hab.pool) m.paint(inner.x + inner.w - 3, inner.y + inner.h - 2, 3, 2, 'water');
    m.fence(e.x, e.y, e.w, e.h, [], 'zfence');
    hab.props.forEach((name, i) => {
      const def = atlas.objects[name]!;
      const px = inner.x + ((i * 3) % Math.max(1, inner.w - def.w + 1));
      const py = inner.y + (i % 2) * Math.max(0, inner.h - def.h - 2);
      m.tryPlace(name, px, py, [hab.ground, 'grass']);
    });
    const cx = e.x + Math.floor(e.w / 2);
    const vy = e.view === 'S' ? e.y + e.h : e.y - 1;
    add({
      id: `enclosure_${e.species}`,
      name: `${e.species.replace('_', ' ').replace(/^./, (c) => c.toUpperCase())} enclosure`,
      kind: 'public',
      area: { x: e.x, y: e.y, w: e.w, h: e.h },
      entry: p(cx, vy),
      spots: [p(cx - 1, vy), p(cx, vy), p(cx + 1, vy)],
      pen: inner,
      district: 'zoo',
      description: `Fenced ${e.species.replace('_', ' ')} enclosure; visitors watch from the path.`,
    });
  }
  // gate and rest corner
  m.place('pillar_red', 48, 18);
  m.place('pillar_red', 48, 22);
  m.place('sign_zoo', 50, 18);
  m.place('bench', 92, 11);
  m.place('bin', 94, 13);
  m.place('balloons', 94, 9);
  add({
    id: 'zoo',
    name: 'City Zoo',
    kind: 'public',
    area: { x: 48, y: 0, w: 48, h: 34 },
    entry: p(49, 20),
    spots: [p(49, 20), p(50, 21), p(63, 12), p(92, 14), p(60, 17), p(76, 8)],
    district: 'zoo',
    description: 'Zoo with twelve enclosures, promenades, food carts and the rides; the gate faces the town.',
  });

  // rides: rollercoaster loop with station, ferris wheel, carousel, burger joint, ice cream trucks
  const loop = { x: 49, y: 22, w: 16, h: 9 };
  m.paint(loop.x + 1, loop.y + 1, loop.w - 2, loop.h - 2, 'grass');
  const track = new Set<string>();
  for (let x = loop.x; x < loop.x + loop.w; x++) {
    track.add(`${x},${loop.y}`);
    track.add(`${x},${loop.y + loop.h - 1}`);
  }
  for (let y = loop.y; y < loop.y + loop.h; y++) {
    track.add(`${loop.x},${y}`);
    track.add(`${loop.x + loop.w - 1},${y}`);
  }
  for (const key of track) {
    const [tx, ty] = key.split(',').map(Number) as [number, number];
    let mask = 0;
    if (track.has(`${tx},${ty - 1}`)) mask |= N;
    if (track.has(`${tx + 1},${ty}`)) mask |= E;
    if (track.has(`${tx},${ty + 1}`)) mask |= S;
    if (track.has(`${tx - 1},${ty}`)) mask |= W;
    m.layers.decor[ty * V2_WIDTH + tx] = `coaster_${mask}`;
    m.collision[ty * V2_WIDTH + tx] = 1;
  }
  m.place('coaster_station', 55, 20);
  for (const [x, y] of [
    [52, 27],
    [58, 25],
  ] as const)
    m.place('tree_green', x, y);
  m.place('flowers_yellow', 55, 24);
  m.place('flowers_pink', 61, 28);
  add({
    id: 'rollercoaster',
    name: 'Rollercoaster',
    kind: 'public',
    area: { x: 49, y: 20, w: 16, h: 11 },
    entry: p(56, 21),
    spots: [p(55, 21), p(56, 21), p(57, 21), p(55, 20), p(57, 20)],
    pen: loop,
    district: 'zoo',
    description:
      'Red steel rollercoaster loop; riders queue and board at the striped station on its north side.',
  });
  m.place('ferris_wheel', 67, 21);
  add({
    id: 'ferris_wheel',
    name: 'Ferris wheel',
    kind: 'public',
    area: { x: 67, y: 21, w: 6, h: 7 },
    entry: p(70, 28),
    spots: [p(69, 28), p(70, 28), p(71, 28)],
    district: 'zoo',
    description: 'Ferris wheel with eight coloured gondolas, a favourite for dates at sunset.',
  });
  m.place('carousel', 74, 22);
  add({
    id: 'carousel',
    name: 'Carousel',
    kind: 'public',
    area: { x: 74, y: 22, w: 5, h: 5 },
    entry: p(76, 27),
    spots: [p(75, 27), p(76, 27), p(77, 27)],
    district: 'zoo',
    description: 'Striped carousel under a round canopy.',
  });
  const burgerDoor = m.building('burger_joint', 80, 26);
  add({
    id: 'burger_joint',
    name: 'Burger Joint',
    kind: 'shop',
    area: { x: 80, y: 26, w: 7, h: 4 },
    entry: p(burgerDoor.x, burgerDoor.y + 1),
    door: burgerDoor,
    spots: [
      p(burgerDoor.x - 1, burgerDoor.y + 1),
      p(burgerDoor.x + 1, burgerDoor.y + 1),
      p(89, 29),
      p(90, 30),
    ],
    district: 'zoo',
    description: 'Burger joint with a yellow-and-red awning; serves burgers made from farm produce.',
  });
  m.place('umbrella_red', 89, 27);
  m.place('umbrella_teal', 92, 27);
  m.place('ice_cream_truck', 65, 30);
  m.place('ice_cream_truck', 88, 25);
  for (const [i, t] of [p(65, 30), p(88, 25)].entries())
    add({
      id: `ice_cream_truck_${i + 1}`,
      name: 'Ice cream truck',
      kind: 'shop',
      area: { x: t.x, y: t.y, w: 2, h: 1 },
      entry: p(t.x, t.y + 1),
      spots: [p(t.x, t.y + 1), p(t.x + 1, t.y + 1)],
      district: 'zoo',
      description: 'Pink ice cream truck with a cone on the roof.',
    });
  m.place('cart_popcorn', 60, 18);
  m.place('cart_lemonade', 79, 18);
  m.place('cart_cotton_candy', 66, 18);
  m.place('bench', 73, 29);
  m.place('bin', 79, 29);
  m.place('balloons', 66, 28);
  m.place('sign_rides', 74, 19);
  for (const x of [54, 70, 86]) lamp(x, 16);

  // ------------------------------------------------------------ farmstead
  m.paint(18, 33, 2, 13, 'path');
  m.paint(0, 46, 46, 1, 'path');
  m.paint(13, 53, 33, 1, 'path');
  m.place('sign_farm', 13, 29);
  m.paint(2, 35, 15, 10, 'grass');
  m.fence(1, 34, 17, 12, [p(17, 40)]);
  m.fence(20, 34, 14, 11, [p(20, 39)]);
  m.paint(2, 48, 10, 7, 'mud');
  m.fence(1, 47, 12, 9, [p(6, 47)]);
  const coop = m.place('coop', 8, 48);
  m.place('trough', 4, 36);
  m.place('trough', 22, 36);
  m.place('hay', 15, 43);
  m.place('hay', 31, 42);
  m.place('tree_green', 9, 39);
  add({
    id: 'cow_pasture',
    name: 'Cow pasture',
    kind: 'nature',
    area: { x: 1, y: 34, w: 17, h: 12 },
    entry: p(18, 40),
    spots: [p(18, 39), p(18, 41), p(16, 40)],
    pen: { x: 2, y: 35, w: 15, h: 10 },
    district: 'farmstead',
    description: 'Large fenced pasture for up to ten cows (room for more); gate on the east lane.',
  });
  add({
    id: 'sheep_pasture',
    name: 'Sheep pasture',
    kind: 'nature',
    area: { x: 20, y: 34, w: 14, h: 11 },
    entry: p(19, 39),
    spots: [p(19, 38), p(21, 39), p(19, 40)],
    pen: { x: 21, y: 35, w: 12, h: 9 },
    district: 'farmstead',
    description: 'Fenced sheep pasture; gate on the west lane.',
  });
  add({
    id: 'chicken_coop',
    name: 'Chicken coop',
    kind: 'nature',
    area: { x: 1, y: 47, w: 12, h: 9 },
    entry: p(6, 46),
    door: p(coop.x + 1, coop.y + 2),
    spots: [p(5, 46), p(6, 48), p(7, 46)],
    pen: { x: 2, y: 48, w: 10, h: 7 },
    district: 'farmstead',
    description: 'Chicken yard with a little coop; eggs are collected from the coop door.',
  });
  const farmhouseDoor = m.building('farmhouse', 14, 48);
  m.paint(farmhouseDoor.x, farmhouseDoor.y + 1, 1, 1, 'path');
  add({
    id: 'farmhouse',
    name: 'Farmhouse',
    kind: 'shop',
    area: { x: 14, y: 48, w: 6, h: 4 },
    entry: p(farmhouseDoor.x, farmhouseDoor.y + 1),
    door: farmhouseDoor,
    spots: [p(farmhouseDoor.x + 1, farmhouseDoor.y + 1), p(farmhouseDoor.x, farmhouseDoor.y + 2)],
    district: 'farmstead',
    interiorId: 'cottage_a',
    description: 'Farmhouse where the farm work is organised; milk, eggs and wool are sold from here.',
  });
  const barnDoor = m.building('barn', 21, 48);
  add({
    id: 'barn',
    name: 'Barn',
    kind: 'nature',
    area: { x: 21, y: 48, w: 7, h: 5 },
    entry: p(barnDoor.x, barnDoor.y + 1),
    door: barnDoor,
    spots: [p(barnDoor.x - 1, barnDoor.y + 1), p(barnDoor.x + 1, barnDoor.y + 1)],
    district: 'farmstead',
    description: 'Big red barn for hay, tools and animals at night.',
  });
  const butcherDoor = m.building('butcher', 30, 48);
  m.paint(butcherDoor.x, butcherDoor.y + 1, 1, 1, 'path');
  add({
    id: 'butcher',
    name: 'Butcher',
    kind: 'shop',
    area: { x: 30, y: 48, w: 5, h: 4 },
    entry: p(butcherDoor.x, butcherDoor.y + 1),
    door: butcherDoor,
    spots: [p(butcherDoor.x, butcherDoor.y + 2), p(butcherDoor.x + 1, butcherDoor.y + 2)],
    district: 'farmstead',
    description: 'Small butcher shed at the farm edge by the market road (off-screen, nothing graphic).',
  });
  m.place('churn', 20, 50);
  m.place('hay', 28, 50);
  m.place('crate', 35, 51);
  lamp(13, 50);
  lamp(29, 51);

  // ------------------------------------------------------------ market road
  m.paint(46, 48, 14, 2, 'path');
  m.place('stall_red', 40, 36);
  m.place('stall_blue', 47, 36);
  m.place('stall_red', 47, 42);
  m.place('crate', 40, 41);
  m.place('barrel', 41, 41);
  m.place('bench', 40, 44);
  for (const y of [34, 40, 50]) lamp(46, y);
  add({
    id: 'market',
    name: 'Market Road',
    kind: 'public',
    area: { x: 36, y: 33, w: 24, h: 23 },
    entry: p(45, 39),
    spots: [p(43, 38), p(46, 39), p(43, 44), p(46, 45), p(41, 39)],
    district: 'market',
    description: 'Road from the town to the station with market stalls and spare plots for new shops.',
  });

  // ------------------------------------------------------------ station and hotel
  m.paint(62, 33, 2, 18, 'path');
  m.paint(62, 44, 34, 2, 'path');
  m.paint(60, 51, 36, 5, 'paving');
  const hotelDoor = m.building('hotel', 80, 38);
  add({
    id: 'hotel',
    name: 'Hotel',
    kind: 'shop',
    area: { x: 80, y: 38, w: 11, h: 6 },
    entry: p(hotelDoor.x, hotelDoor.y + 1),
    door: hotelDoor,
    spots: [p(hotelDoor.x - 1, hotelDoor.y + 1), p(hotelDoor.x + 1, hotelDoor.y + 1), p(88, 45)],
    district: 'station',
    interiorId: 'hotel_lobby',
    description: 'Three-storey hotel for train guests; the lobby leads to six rooms.',
  });
  const stationDoor = m.building('station', 64, 46);
  for (let x = 60; x < 96; x++) m.layers.decor[55 * V2_WIDTH + x] = 'platform_line';
  add({
    id: 'station',
    name: 'Train Station',
    kind: 'public',
    area: { x: 60, y: 46, w: 36, h: 10 },
    entry: p(stationDoor.x, stationDoor.y + 1),
    door: stationDoor,
    spots: [p(66, 54), p(70, 54), p(74, 54), p(78, 54), p(82, 54), p(86, 54), p(90, 54)],
    pen: { x: 60, y: 53, w: 36, h: 3 },
    district: 'station',
    description:
      'Station building and a long platform; trains arrive from the east edge and leave to the west.',
  });
  for (const x of [62, 78, 94]) m.place('bench', x, 52);
  m.place('flowerpot_pink', 76, 50);
  m.place('flowerpot_yellow', 63, 50);
  for (const x of [77, 93]) lamp(x, 46);
  // railway: blocked gravel bed with one track across the whole map
  for (let x = 0; x < V2_WIDTH; x++) {
    m.layers.decor[57 * V2_WIDTH + x] = 'rail_h';
    for (let y = 56; y <= 58; y++) m.collision[y * V2_WIDTH + x] = 1;
  }

  // ------------------------------------------------------------ forest
  for (let y = 0; y < 56; y++)
    for (let x = 96; x < V2_WIDTH; x++) if (m.terrainAt(x, y) === 'grass') m.paint(x, y, 1, 1, 'moss');
  m.paintEllipse(113.5, 16, 9, 6, 'lake');
  m.paint(112, 19, 1, 4, 'planks');
  m.paint(102, 9, 2, 22, 'path'); // west trail down to the road
  m.paint(104, 23, 20, 2, 'path'); // south shore trail
  m.paintEllipse(110.5, 43.5, 7.5, 6, 'grass'); // grove clearing
  m.paint(110, 33, 2, 5, 'path'); // road -> grove
  m.place('sign_forest', 97, 9);
  m.place('duck_house', 117, 13);
  for (const [x, y] of [
    [105, 18],
    [121, 14],
    [107, 12],
    [119, 20],
  ] as const)
    m.place('reeds', x, y);
  m.place('lilypad', 109, 14);
  m.place('lilypad', 116, 18);
  m.place('bench', 106, 25);
  m.place('bench', 117, 25);
  m.place('tree_grand', 109, 39);
  for (const [x, y] of [
    [104, 41],
    [116, 41],
    [104, 46],
    [117, 46],
  ] as const)
    m.place('standing_stone', x, y);
  m.place('picnic_table', 106, 47);
  m.place('campfire', 113, 46);
  m.place('log', 113, 48);
  m.place('mushrooms', 108, 44);
  m.place('flowers_pink', 107, 43);
  m.place('flowers_blue', 113, 43);
  m.place('flowers_yellow', 112, 49);
  m.place('birdhouse', 122, 27);
  add({
    id: 'forest',
    name: 'Whisper Woods',
    kind: 'nature',
    area: { x: 96, y: 0, w: 32, h: 56 },
    entry: p(99, 8),
    spots: [p(98, 7), p(100, 8), p(103, 14), p(102, 28), p(110, 34)],
    pen: { x: 96, y: 0, w: 32, h: 56 },
    district: 'forest',
    description:
      'Dense mixed forest with trails, a lake and a grove; deer, rabbits, squirrels, hedgehogs, foxes and birds live here.',
  });
  add({
    id: 'forest_lake',
    name: 'Forest lake',
    kind: 'nature',
    area: { x: 103, y: 9, w: 21, h: 16 },
    entry: p(110, 23),
    spots: [p(106, 24), p(112, 22), p(112, 21), p(116, 24), p(120, 23)],
    pen: { x: 104, y: 10, w: 19, h: 14 },
    district: 'forest',
    description:
      'Still lake with reeds, lily pads, a duck house and a little jetty; walkable shore along the south trail.',
  });
  add({
    id: 'forest_grove',
    name: 'The grove',
    kind: 'nature',
    area: { x: 103, y: 37, w: 16, h: 13 },
    entry: p(110, 38),
    spots: [p(106, 46), p(108, 49), p(112, 45), p(114, 45), p(110, 47), p(105, 43)],
    district: 'forest',
    description:
      'Sunny clearing around an ancient tree ringed by standing stones; picnic table and campfire.',
  });

  // ------------------------------------------------------------ v1 houses get interiors
  m.locations.slice(0, townCount).forEach((loc) => {
    if (loc.kind !== 'house') return;
    const n = Number(loc.id.split('_')[1] ?? 0);
    (loc as LocationV2).interiorId = loc.id === 'player_home' ? 'cottage_a' : INTERIORS[n % 3]!;
  });
  m.locations.slice(0, townCount).forEach((loc) => ((loc as LocationV2).district = 'town'));

  // ------------------------------------------------------------ nature
  m.reserveLocationTiles();
  townTrees(m);
  for (let x = 48; x < 64; x += 2) m.tryPlace(x % 6 === 2 ? 'tree_autumn' : 'tree_green', x, 0);
  const r = rng(2024);
  for (let y = 0; y < 56; y += 2)
    for (let x = 96; x < V2_WIDTH; x += 2) {
      const jx = x + Math.floor(r() * 2);
      const jy = y + Math.floor(r() * 2);
      const v = r();
      const name =
        v < 0.22
          ? 'tree_pine'
          : v < 0.36
            ? 'tree_pine_b'
            : v < 0.5
              ? 'tree_oak'
              : v < 0.58
                ? 'tree_oak_autumn'
                : v < 0.7
                  ? 'tree_birch'
                  : v < 0.76
                    ? 'fern'
                    : v < 0.8
                      ? 'mushrooms'
                      : v < 0.83
                        ? 'stump'
                        : v < 0.86
                          ? 'bush_berries'
                          : null;
      if (name) m.tryPlace(name, jx, jy, ['moss']);
    }
  // hedges and trees on the edges of the new districts
  for (let x = 0; x < 96; x += 2) m.tryPlace(x % 6 === 0 ? 'tree_green' : 'bush', x, 33);
  for (let x = 36; x < 60; x += 3) m.tryPlace('tree_autumn', x, 53);
  for (let y = 34; y < 44; y += 3) m.tryPlace('tree_green', 94, y);
  m.finalizeGround(7);
  townScatter(m);
  const scatter = ['bush', 'bush_flowers', 'rock', 'flowers_pink', 'flowers_yellow', 'flowers_blue'];
  for (let k = 0; k < 140; k++) {
    const x = Math.floor(r() * 96);
    const y = 30 + Math.floor(r() * 26);
    m.tryPlace(scatter[Math.floor(r() * scatter.length)]!, x, y);
  }

  const scenes: Scene[] = [
    ...TOWN_SCENES,
    {
      id: 'overview',
      name: 'Overview',
      subtitle: 'The whole map',
      rect: { x: 0, y: 0, w: V2_WIDTH, h: V2_HEIGHT },
    },
    { id: 'post_row', name: 'Post Row', subtitle: 'Post office', rect: { x: 40, y: 0, w: 26, h: 12 } },
    { id: 'zoo', name: 'Zoo', subtitle: 'City Zoo', rect: { x: 48, y: 0, w: 48, h: 34 } },
    { id: 'rides', name: 'Rides', subtitle: 'Fun rides', rect: { x: 46, y: 16, w: 50, h: 17 } },
    { id: 'farmstead', name: 'Farmstead', subtitle: 'Meadow Farm', rect: { x: 0, y: 30, w: 36, h: 30 } },
    { id: 'station', name: 'Station', subtitle: 'Station & Hotel', rect: { x: 56, y: 33, w: 40, h: 27 } },
    { id: 'forest', name: 'Forest', subtitle: 'Whisper Woods', rect: { x: 96, y: 0, w: 32, h: 56 } },
  ];
  const itemSpawns: ItemSpawnArea[] = [
    ...TOWN_ITEM_SPAWNS,
    { itemId: 'flower', area: { x: 103, y: 37, w: 16, h: 13 }, max: 4 },
    { itemId: 'apple', area: { x: 96, y: 26, w: 32, h: 4 }, max: 2 },
    { itemId: 'seed', area: { x: 13, y: 46, w: 20, h: 8 }, max: 2 },
    { itemId: 'gem', area: { x: 104, y: 23, w: 20, h: 2 }, max: 1 },
  ];
  return {
    builder: m,
    locations: m.locations as LocationV2[],
    scenes,
    itemSpawns,
    decorations: DECORATION_DEFS,
    districts: DISTRICTS,
  };
}
