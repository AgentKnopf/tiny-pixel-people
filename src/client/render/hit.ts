import type { AnimalId, LocationId, Point, VillagerId, WorldMap } from '../../shared/types.ts';
import { FRAME_H, FRAME_W, spriteTopLeft } from './sprites.ts';

export type HitResult =
  | { kind: 'villager'; id: VillagerId }
  | { kind: 'animal'; id: AnimalId }
  | { kind: 'player' }
  | { kind: 'door'; houseId: LocationId }
  | { kind: 'ground'; tile: Point; blocked: boolean }
  | { kind: 'none' };

/** An animal's click box in art px; `y` orders overlapping animals (larger is on top). */
export interface HitBoxEntity {
  id: string;
  box: { x: number; y: number; w: number; h: number };
  y: number;
}

export interface HitEntity {
  id: string;
  /** Tile position (float). */
  pos: Point;
}

/** Villager sprite hit box in art px: the visible body, a little narrower than the frame. */
export function spriteHitBox(pos: Point, tileSize: number): { x: number; y: number; w: number; h: number } {
  const tl = spriteTopLeft(pos, tileSize);
  return { x: tl.x + 2, y: tl.y + 4, w: FRAME_W - 4, h: FRAME_H - 4 };
}

/** Door click target in tiles: the door tile and the tile above it. */
export function doorHitBox(door: Point): { x: number; y: number; w: number; h: number } {
  return { x: door.x, y: door.y - 1, w: 1, h: 2 };
}

function inBox(p: Point, b: { x: number; y: number; w: number; h: number }): boolean {
  return p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;
}

/**
 * What is under the art-pixel point `p`. Villagers win over animals, animals over doors and doors
 * over ground; among villagers (or animals) the one drawn on top (largest y) wins.
 */
export function hitTest(
  map: WorldMap,
  p: Point,
  villagers: HitEntity[],
  player: HitEntity | null,
  animals: HitBoxEntity[] = [],
): HitResult {
  const ts = map.tileSize;
  const sorted = [...villagers].sort((a, b) => b.pos.y - a.pos.y);
  for (const v of sorted) if (inBox(p, spriteHitBox(v.pos, ts))) return { kind: 'villager', id: v.id };
  const byY = [...animals].sort((a, b) => b.y - a.y);
  for (const a of byY) if (inBox(p, a.box)) return { kind: 'animal', id: a.id };
  const tile = { x: Math.floor(p.x / ts), y: Math.floor(p.y / ts) };
  for (const loc of map.locations) {
    if (loc.door && inBox(tile, doorHitBox(loc.door))) return { kind: 'door', houseId: loc.id };
  }
  if (player && inBox(p, spriteHitBox(player.pos, ts))) return { kind: 'player' };
  if (tile.x < 0 || tile.y < 0 || tile.x >= map.width || tile.y >= map.height) return { kind: 'none' };
  return { kind: 'ground', tile, blocked: map.collision[tile.y * map.width + tile.x] === 1 };
}
