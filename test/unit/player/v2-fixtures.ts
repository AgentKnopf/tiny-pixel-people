import type { InteriorTemplate, Location } from '../../../src/shared/types.ts';
import type { FakeHost } from './fake-host.ts';

/** v2 venues on the 30x20 fake map (spec v2 §2.1 ids). */
export const V2_LOCATIONS: Location[] = [
  {
    id: 'burger_joint',
    name: 'Burger Joint',
    kind: 'food',
    area: { x: 18, y: 14, w: 3, h: 2 },
    entry: { x: 19, y: 16 },
    hours: { open: '11:00', close: '21:00' },
  },
  {
    id: 'ice_cream_truck_1',
    name: 'Ice cream truck',
    kind: 'food',
    area: { x: 10, y: 14, w: 2, h: 1 },
    entry: { x: 10, y: 15 },
    hours: { open: '10:00', close: '19:00' },
  },
  {
    id: 'farmhouse',
    name: 'Farmhouse',
    kind: 'farm',
    area: { x: 2, y: 8, w: 3, h: 2 },
    entry: { x: 3, y: 10 },
  },
  {
    id: 'rollercoaster',
    name: 'Rollercoaster',
    kind: 'ride',
    area: { x: 20, y: 8, w: 6, h: 4 },
    entry: { x: 22, y: 12 },
    ride: { capacity: 8, durationMin: 10, playerCost: 4, funGain: 35 },
  },
  {
    id: 'station',
    name: 'Station',
    kind: 'station',
    area: { x: 2, y: 12, w: 8, h: 1 },
    entry: { x: 5, y: 12 },
  },
  {
    id: 'hotel',
    name: 'Hotel',
    kind: 'hotel',
    area: { x: 11, y: 16, w: 4, h: 3 },
    entry: { x: 12, y: 15 },
    door: { x: 12, y: 16 },
    interiorId: 'hotel_lobby',
  },
];

export function addV2Locations(host: FakeHost): void {
  for (const l of V2_LOCATIONS) {
    if (!host.map.locations.some((m) => m.id === l.id)) host.map.locations.push(structuredClone(l));
  }
}

/** A 6x4 room: walls around, door (exit) at the bottom middle. */
export function room(id: string, objects: InteriorTemplate['objects'] = []): InteriorTemplate {
  const width = 6;
  const height = 4;
  const exit = { x: 3, y: 3 };
  const collision = Array.from({ length: width * height }, (_, i) => {
    const x = i % width;
    const y = Math.floor(i / width);
    const wall = x === 0 || y === 0 || x === width - 1 || y === height - 1;
    return wall && !(x === exit.x && y === exit.y) ? 1 : 0;
  }) as (0 | 1)[];
  return {
    id,
    name: id,
    width,
    height,
    layers: { ground: [], decor: [], overhead: [] },
    collision,
    entry: { x: 3, y: 2 },
    exit,
    spots: [{ x: 1, y: 1 }],
    objects,
  };
}

export const POST_LOCATIONS: Location[] = [
  {
    id: 'post_office',
    name: 'Post office',
    kind: 'post',
    area: { x: 22, y: 2, w: 5, h: 2 },
    entry: { x: 24, y: 5 },
    door: { x: 24, y: 4 },
    interiorId: 'post_office',
    hours: { open: '08:00', close: '18:00' },
  },
  {
    id: 'notice_board',
    name: 'Notice board',
    kind: 'public',
    area: { x: 27, y: 5, w: 1, h: 1 },
    entry: { x: 27, y: 6 },
  },
];

/** v2 venues plus interiors: Ada's house, the hotel lobby and the post office (with the Keep). */
export function addInteriors(host: FakeHost): void {
  addV2Locations(host);
  for (const l of POST_LOCATIONS) {
    if (!host.map.locations.some((m) => m.id === l.id)) host.map.locations.push(structuredClone(l));
  }
  host.map.locations.find((l) => l.id === 'house_ada')!.interiorId = 'house_small';
  host.map.locations.find((l) => l.id === 'house_ben')!.interiorId = 'house_small';
  host.map.interiors = [
    room('house_small'),
    room('hotel_lobby'),
    room('post_office', [{ id: 'keep_cupboard', pos: { x: 1, y: 1 } }]),
  ];
}
