import {
  ZOO_SPECIES,
  type District,
  type InteriorTemplate,
  type ItemSpawnArea,
  type Location,
  type LocationHours,
  type Scene,
  type WorldMap,
  type ZooSpecies,
} from '../../src/shared/types.ts';
import { rng } from './canvas.ts';
import { buildInteriors } from './interiors.ts';
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

export interface VillageV2Draft {
  builder: MapBuilder;
  locations: Location[];
  scenes: Scene[];
  itemSpawns: ItemSpawnArea[];
  decorations: DecorationDef[];
  districts: District[];
  interiors: InteriorTemplate[];
  railway: NonNullable<WorldMap['railway']>;
}

export const V2_WIDTH = 128;
export const V2_HEIGHT = 60;

/** Spec v2 §2 district rects; post_row overlaps town and zoo and is looked up first. */
export const DISTRICTS: District[] = [
  { id: 'town', name: 'Old town', rect: { x: 0, y: 0, w: 48, h: 30 } },
  { id: 'post_row', name: 'Post Row', rect: { x: 44, y: 0, w: 20, h: 9 } },
  { id: 'zoo', name: 'City Zoo & Rides', rect: { x: 48, y: 0, w: 48, h: 34 } },
  { id: 'forest', name: 'Whisper Woods', rect: { x: 96, y: 0, w: 32, h: 56 } },
  { id: 'farmstead', name: 'Meadow Farm', rect: { x: 0, y: 30, w: 36, h: 30 } },
  { id: 'market', name: 'Market Road', rect: { x: 36, y: 30, w: 24, h: 30 } },
  { id: 'station', name: 'Station & Hotel', rect: { x: 60, y: 36, w: 36, h: 24 } },
];

const ZOO_HOURS: LocationHours = { open: '08:00', close: '21:00' };
const HOUSE_INTERIORS = ['cottage_a', 'cottage_b', 'cottage_c'] as const;

const p = (x: number, y: number) => ({ x, y });

/** v2 map: the v1 town unchanged at x0-47 y0-29 plus the new districts (docs/art/README.md, spec v2 §2). */
export function buildVillageV2(atlas: TileAtlas): VillageV2Draft {
  const m = new MapBuilder(V2_WIDTH, V2_HEIGHT, atlas);
  layoutTown(m);
  const townCount = m.locations.length;
  const add = (loc: Location) => m.location(loc);
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
  m.place('notice_board', 56, 5);
  m.place('post_box', 49, 4);
  lamp(63, 5);
  m.place('flowerpot_yellow', 63, 3);
  const houseSpots = (d: { x: number; y: number }) => [
    p(d.x, d.y + 1),
    p(d.x - 1, d.y + 1),
    p(d.x + 1, d.y + 1),
  ];
  add({
    id: 'house_laude',
    name: "Laude's house",
    kind: 'house',
    area: { x: 44, y: 2, w: 5, h: 4 },
    entry: p(laudeDoor.x, laudeDoor.y + 1),
    door: laudeDoor,
    spots: houseSpots(laudeDoor),
    district: 'post_row',
    interiorId: 'cottage_b',
    description: 'Grey-walled cottage with an ochre roof on the bakery road.',
  });
  add({
    id: 'post_office',
    name: 'Post Office',
    kind: 'post',
    area: { x: 50, y: 2, w: 7, h: 4 },
    entry: p(postDoor.x, postDoor.y + 1),
    door: postDoor,
    spots: [
      p(postDoor.x, postDoor.y + 1),
      p(postDoor.x - 1, postDoor.y + 1),
      p(postDoor.x + 1, postDoor.y + 1),
    ],
    perch: [p(51, 2), p(52, 2), p(54, 2), p(55, 2)],
    hours: { open: '08:00', close: '18:00' },
    district: 'post_row',
    interiorId: 'post_office',
    description:
      "Laude's blue-roofed post office; the crow Quill lives on the roof and the Keep cupboard is inside.",
  });
  add({
    id: 'notice_board',
    name: 'Notice board',
    kind: 'public',
    area: { x: 56, y: 5, w: 2, h: 2 },
    entry: p(55, 6),
    spots: [p(55, 6), p(56, 7), p(57, 7)],
    district: 'post_row',
    description: 'Roofed cork board in front of the post office where anyone can pin a notice.',
  });
  add({
    id: 'house_franzi',
    name: "Franzi's house",
    kind: 'house',
    area: { x: 58, y: 2, w: 5, h: 4 },
    entry: p(franziDoor.x, franziDoor.y + 1),
    door: franziDoor,
    spots: houseSpots(franziDoor),
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
  if (enclosures.length !== ZOO_SPECIES.length) throw new Error('one enclosure per zoo species');
  for (const e of enclosures) {
    const hab = HABITAT[e.species];
    const inner = { x: e.x + 1, y: e.y + 1, w: e.w - 2, h: e.h - 2 };
    m.paint(e.x, e.y, e.w, e.h, hab.ground);
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
    const label = e.species.replace('_', ' ');
    add({
      id: `zoo_${e.species}`,
      name: `${label.replace(/^./, (c) => c.toUpperCase())} enclosure`,
      kind: 'zoo',
      area: { x: e.x, y: e.y, w: e.w, h: e.h },
      entry: p(cx, vy),
      spots: [p(cx - 1, vy), p(cx, vy), p(cx + 1, vy)],
      species: e.species,
      pen: inner,
      hours: ZOO_HOURS,
      district: 'zoo',
      description: `Fenced ${label} enclosure; visitors watch from the path.`,
    });
  }
  m.place('zoo_gate', 64, 6);
  add({
    id: 'zoo_gate',
    name: 'Zoo gate',
    kind: 'zoo',
    area: { x: 64, y: 6, w: 1, h: 3 },
    entry: p(64, 8),
    spots: [p(63, 7), p(65, 7), p(63, 8), p(65, 8)],
    hours: ZOO_HOURS,
    district: 'zoo',
    description: 'Striped gate arch over the promenade where the zoo begins.',
  });
  // west gate from the town road at y 20, rest corner
  m.place('pillar_red', 48, 18);
  m.place('pillar_red', 48, 22);
  m.place('sign_zoo', 50, 18);
  m.place('bench', 92, 11);
  m.place('bin', 94, 13);
  m.place('balloons', 94, 9);

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
  m.place('tree_green', 52, 27);
  m.place('tree_green', 58, 25);
  m.place('flowers_yellow', 55, 24);
  m.place('flowers_pink', 61, 28);
  add({
    id: 'rollercoaster',
    name: 'Rollercoaster',
    kind: 'ride',
    area: { x: 49, y: 20, w: 16, h: 11 },
    entry: p(56, 21),
    spots: [p(55, 21), p(56, 21), p(57, 21), p(55, 20), p(57, 20), p(54, 21), p(58, 21), p(53, 21)],
    ride: { capacity: 8, durationMin: 10, playerCost: 4, funGain: 35 },
    hours: ZOO_HOURS,
    district: 'zoo',
    description:
      'Red steel rollercoaster loop; riders queue and board at the striped station on its north side.',
  });
  m.place('ferris_wheel', 67, 21);
  add({
    id: 'ferris_wheel',
    name: 'Ferris wheel',
    kind: 'ride',
    area: { x: 67, y: 21, w: 6, h: 7 },
    entry: p(70, 28),
    spots: [p(69, 28), p(70, 28), p(71, 28), p(68, 28), p(72, 28)],
    ride: { capacity: 8, durationMin: 15, playerCost: 3, funGain: 25 },
    hours: ZOO_HOURS,
    district: 'zoo',
    description: 'Ferris wheel with eight coloured gondolas, a favourite for dates at sunset.',
  });
  m.place('carousel', 74, 22);
  add({
    id: 'carousel',
    name: 'Carousel',
    kind: 'ride',
    area: { x: 74, y: 22, w: 5, h: 5 },
    entry: p(76, 27),
    spots: [p(75, 27), p(76, 27), p(77, 27), p(74, 27), p(78, 27)],
    ride: { capacity: 6, durationMin: 8, playerCost: 2, funGain: 20 },
    hours: ZOO_HOURS,
    district: 'zoo',
    description: 'Striped carousel under a round canopy.',
  });
  const burgerDoor = m.building('burger_joint', 80, 26);
  add({
    id: 'burger_joint',
    name: 'Burger Joint',
    kind: 'food',
    area: { x: 80, y: 26, w: 7, h: 4 },
    entry: p(burgerDoor.x, burgerDoor.y + 1),
    door: burgerDoor,
    spots: [
      p(burgerDoor.x - 1, burgerDoor.y + 1),
      p(burgerDoor.x + 1, burgerDoor.y + 1),
      p(89, 29),
      p(92, 29),
    ],
    hours: { open: '11:00', close: '21:00' },
    district: 'zoo',
    description: 'Burger joint with a yellow-and-red awning and parasol tables; burgers come from the farm.',
  });
  m.place('umbrella_red', 89, 27);
  m.place('umbrella_teal', 92, 27);
  const trucks = [p(65, 30), p(88, 25)];
  trucks.forEach((t, i) => {
    m.place('ice_cream_truck', t.x, t.y);
    add({
      id: `ice_cream_truck_${i + 1}`,
      name: 'Ice cream truck',
      kind: 'food',
      area: { x: t.x, y: t.y, w: 2, h: 1 },
      entry: p(t.x, t.y + 1),
      spots: [p(t.x, t.y + 1), p(t.x + 1, t.y + 1)],
      hours: { open: '10:00', close: '19:00' },
      district: 'zoo',
      description: 'Pink ice cream truck with a cone on the roof.',
    });
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
  m.paint(16, 33, 1, 13, 'path'); // farm lane between the pastures
  m.paint(0, 46, 46, 1, 'path');
  m.paint(13, 53, 33, 1, 'path');
  m.paint(33, 37, 11, 1, 'path'); // butcher -> market road
  m.place('sign_farm', 13, 29);
  m.fence(0, 34, 16, 12, [p(15, 40)]);
  m.fence(17, 34, 14, 11, [p(17, 39)]);
  m.paint(2, 48, 10, 7, 'mud');
  m.fence(1, 47, 12, 9, [p(6, 47)]);
  const coop = m.place('coop', 8, 48);
  m.place('trough', 4, 36);
  m.place('trough', 20, 36);
  m.place('hay', 13, 43);
  m.place('hay', 28, 42);
  m.place('tree_green', 8, 39);
  add({
    id: 'cow_pasture',
    name: 'Cow pasture',
    kind: 'farm',
    area: { x: 0, y: 34, w: 16, h: 12 },
    entry: p(16, 40),
    spots: [p(16, 41), p(16, 42), p(16, 43)],
    species: 'cow',
    pen: { x: 1, y: 35, w: 14, h: 10 },
    district: 'farmstead',
    description: 'Large fenced cow pasture with room for more than ten cows; gate on the farm lane.',
  });
  add({
    id: 'sheep_pasture',
    name: 'Sheep pasture',
    kind: 'farm',
    area: { x: 17, y: 34, w: 14, h: 11 },
    entry: p(16, 39),
    spots: [p(16, 38), p(16, 37), p(16, 36)],
    species: 'sheep',
    pen: { x: 18, y: 35, w: 12, h: 9 },
    district: 'farmstead',
    description: 'Fenced sheep pasture; gate on the farm lane.',
  });
  add({
    id: 'chicken_coop',
    name: 'Chicken coop',
    kind: 'farm',
    area: { x: 1, y: 47, w: 12, h: 9 },
    entry: p(6, 46),
    door: p(coop.x + 1, coop.y + 2),
    spots: [p(5, 46), p(7, 46), p(8, 46)],
    species: 'chicken',
    pen: { x: 2, y: 48, w: 10, h: 7 },
    district: 'farmstead',
    description: 'Muddy chicken yard with a little coop; eggs are collected at the coop.',
  });
  const farmhouseDoor = m.building('farmhouse', 14, 48);
  m.paint(farmhouseDoor.x, farmhouseDoor.y + 1, 1, 1, 'path');
  add({
    id: 'farmhouse',
    name: 'Farmhouse',
    kind: 'farm',
    area: { x: 14, y: 48, w: 6, h: 4 },
    entry: p(farmhouseDoor.x, farmhouseDoor.y + 1),
    door: farmhouseDoor,
    spots: [p(farmhouseDoor.x + 1, farmhouseDoor.y + 1), p(farmhouseDoor.x, farmhouseDoor.y + 2)],
    district: 'farmstead',
    description: 'Farm office and farm shop counter (a workplace, not a home).',
  });
  const barnDoor = m.building('barn', 21, 48);
  add({
    id: 'barn',
    name: 'Barn',
    kind: 'farm',
    area: { x: 21, y: 48, w: 7, h: 5 },
    entry: p(barnDoor.x, barnDoor.y + 1),
    door: barnDoor,
    spots: [p(barnDoor.x - 1, barnDoor.y + 1), p(barnDoor.x + 1, barnDoor.y + 1)],
    district: 'farmstead',
    description: "Big red barn: the farmer's workplace, where the cheese is made.",
  });
  const butcherDoor = m.building('butcher', 31, 33);
  add({
    id: 'butcher',
    name: 'Butcher',
    kind: 'farm',
    area: { x: 31, y: 33, w: 5, h: 4 },
    entry: p(butcherDoor.x, butcherDoor.y + 1),
    door: butcherDoor,
    spots: [p(butcherDoor.x + 1, butcherDoor.y + 1), p(butcherDoor.x + 2, butcherDoor.y + 1)],
    district: 'farmstead',
    description: 'Small shed by the east-west road where animals leave the farm (off-screen).',
  });
  m.place('churn', 20, 50);
  m.place('hay', 28, 50);
  m.place('hay', 31, 50);
  m.place('crate', 32, 50);
  lamp(13, 50);
  lamp(29, 51);

  // ------------------------------------------------------------ market road
  m.paint(46, 48, 14, 2, 'path');
  m.place('stall_red', 39, 39);
  m.place('stall_blue', 47, 36);
  m.place('stall_red', 47, 42);
  m.place('crate', 40, 42);
  m.place('barrel', 41, 42);
  m.place('bench', 40, 45);
  for (const y of [34, 40, 50]) lamp(46, y);
  add({
    id: 'market',
    name: 'Market Road',
    kind: 'public',
    area: { x: 36, y: 33, w: 24, h: 23 },
    entry: p(45, 39),
    spots: [p(43, 38), p(46, 39), p(43, 44), p(46, 45), p(41, 40), p(48, 38)],
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
    kind: 'hotel',
    area: { x: 80, y: 38, w: 11, h: 6 },
    entry: p(hotelDoor.x, hotelDoor.y + 1),
    door: hotelDoor,
    spots: [p(hotelDoor.x - 1, hotelDoor.y + 1), p(hotelDoor.x + 1, hotelDoor.y + 1), p(88, 45)],
    district: 'station',
    interiorId: 'hotel_lobby',
    description: 'Three-storey hotel for train guests; the lobby leads to six rooms.',
  });
  const stationDoor = m.building('station', 64, 46);
  const platform = { x: 60, y: 53, w: 36, h: 3 };
  for (let x = platform.x; x < platform.x + platform.w; x++)
    m.layers.decor[55 * V2_WIDTH + x] = 'platform_line';
  add({
    id: 'station',
    name: 'Train Station',
    kind: 'station',
    area: { x: 60, y: 46, w: 36, h: 10 },
    entry: p(stationDoor.x, stationDoor.y + 1),
    door: stationDoor,
    spots: [p(66, 54), p(70, 54), p(74, 54), p(78, 54), p(82, 54), p(86, 54), p(90, 54), p(69, 53)],
    district: 'station',
    description:
      'Station building and a long platform; trains arrive from the east edge and leave to the west.',
  });
  for (const x of [62, 78, 94]) m.place('bench', x, 52);
  m.place('flowerpot_pink', 76, 50);
  m.place('flowerpot_yellow', 63, 50);
  for (const x of [77, 93]) lamp(x, 46);
  // railway: blocked gravel bed with one track across the map, open at the level crossings
  const crossings = [44, 45, 110, 111];
  for (let x = 0; x < V2_WIDTH; x++) {
    m.layers.decor[57 * V2_WIDTH + x] = 'rail_h';
    for (let y = 56; y <= 58; y++) m.collision[y * V2_WIDTH + x] = crossings.includes(x) ? 0 : 1;
  }
  for (const x of crossings) for (let y = 56; y <= 58; y++) m.paint(x, y, 1, 1, 'path');
  const railway: VillageV2Draft['railway'] = { rows: [56, 58], platform };
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
    loc.district = 'town';
    if (loc.kind !== 'house' || loc.id === 'player_home') return;
    const n = Number(loc.id.split('_')[1] ?? 0);
    loc.interiorId = HOUSE_INTERIORS[n % HOUSE_INTERIORS.length]!;
  });

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
    { id: 'market', name: 'Market', subtitle: 'Market Road', rect: { x: 36, y: 30, w: 24, h: 30 } },
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
    locations: m.locations,
    scenes,
    itemSpawns,
    decorations: DECORATION_DEFS,
    districts: DISTRICTS,
    interiors: buildInteriors(atlas),
    railway,
  };
}
