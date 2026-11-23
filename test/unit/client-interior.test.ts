import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WorldMap } from '../../src/shared/types.ts';
import {
  interiorBlocked,
  interiorFor,
  interiorLayout,
  objectAt,
  objectRects,
  residentSpots,
  toInterior,
} from '../../src/client/render/interior.ts';
import { hitTest } from '../../src/client/render/hit.ts';

const map = JSON.parse(readFileSync('data/map/village.json', 'utf8')) as WorldMap;

describe('interior view', () => {
  it('finds the template of houses, the hotel and the post office', () => {
    expect(interiorFor(map, 'house_01')?.id).toBe('cottage_b');
    expect(interiorFor(map, 'hotel')?.id).toBe('hotel_lobby');
    expect(interiorFor(map, 'post_office')?.id).toBe('post_office');
    expect(interiorFor(map, 'player_home')).toBeNull();
  });

  it('centres the interior with a crisp zoom and maps clicks back to interior px', () => {
    const tpl = interiorFor(map, 'post_office')!;
    const l = interiorLayout(tpl, 16, 2880, 1800);
    expect(Number.isInteger(l.zoom)).toBe(true);
    expect(l.w).toBe(tpl.width * 16 * l.zoom);
    expect(l.x).toBe(Math.round((2880 - l.w) / 2));
    expect(l.w).toBeLessThanOrEqual(2880 * 0.7);
    expect(toInterior(l, { x: l.x - 1, y: l.y })).toBeNull();
    expect(toInterior(l, { x: l.x + 16 * l.zoom * 3, y: l.y + 16 * l.zoom * 2 })).toEqual({ x: 48, y: 32 });
  });

  it('finds the keep cupboard over its whole 2×2 sprite and the walls', () => {
    const tpl = interiorFor(map, 'post_office')!;
    const tiles = JSON.parse(readFileSync('assets/tiles/village.json', 'utf8')) as {
      tiles: Record<string, number>;
    };
    const names = new Map(Object.entries(tiles.tiles).map(([k, v]) => [v, k]));
    expect(objectRects(tpl, names).get('keep_cupboard')).toEqual({ x: 11, y: 1, w: 2, h: 2 });
    for (const t of [
      { x: 11, y: 1 },
      { x: 12, y: 1 },
      { x: 11, y: 2 },
      { x: 12, y: 2 },
    ])
      expect(objectAt(tpl, t, names)).toBe('keep_cupboard');
    expect(objectAt(tpl, { x: 11, y: 3 }, names)).toBeNull();
    expect(objectAt(tpl, { x: 5, y: 5 }, names)).toBeNull();
    // Without tile names: the pos tile and the one above.
    expect(objectAt(tpl, { x: 11, y: 2 })).toBe('keep_cupboard');
    expect(interiorBlocked(tpl, { x: -1, y: 0 })).toBe(true);
    expect(interiorBlocked(tpl, tpl.entry)).toBe(false);
  });

  it('puts residents on the spots, extras by the entry', () => {
    const tpl = interiorFor(map, 'house_01')!;
    const ids = ['v5', 'v1', 'v3', 'v2', 'v4', 'v6'];
    const spots = residentSpots(tpl, ids);
    expect(spots.get('v1')).toEqual(tpl.spots[0]);
    expect(spots.get('v4')).toEqual(tpl.spots[3]);
    expect(spots.get('v5')).toEqual({ x: tpl.entry.x - 1, y: tpl.entry.y });
    expect(spots.get('v6')).toEqual({ x: tpl.entry.x + 1, y: tpl.entry.y });
  });
});

describe('notice board click', () => {
  it('hits the board area', () => {
    const board = map.locations.find((l) => l.id === 'notice_board')!;
    const p = { x: (board.area.x + 0.5) * 16, y: (board.area.y + 0.5) * 16 };
    expect(hitTest(map, p, [], null)).toEqual({ kind: 'notice' });
  });
});
