import type { Location } from '../../../src/shared/types.ts';
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
