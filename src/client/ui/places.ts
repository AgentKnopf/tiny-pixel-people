import { minuteOfDay, parseClock } from '../../shared/time.ts';
import type { ItemId, Location, LocationId, Point } from '../../shared/types.ts';
import type { UiStore } from './store.ts';

/** Player prices in gold (spec v2 §3.4). The server is authoritative and rejects bad buys. */
export const FOOD_PRICES: Record<string, number> = {
  burger: 5,
  ice_cream: 3,
  milk: 2,
  egg: 1,
  cheese: 4,
  wool: 3,
};

const FARM_GOODS: ItemId[] = ['milk', 'egg', 'cheese', 'wool'];

/** What each venue sells. Ice cream trucks have unlimited stock. */
export function venueItems(loc: Location): ItemId[] {
  if (loc.id === 'burger_joint') return ['burger'];
  if (loc.id.startsWith('ice_cream_truck')) return ['ice_cream'];
  if (loc.id === 'shop' || loc.id === 'farmhouse') return FARM_GOODS;
  return [];
}

export function unlimitedStock(loc: Location, itemId: ItemId): boolean {
  return itemId === 'ice_cream' && loc.id.startsWith('ice_cream_truck');
}

/** Stock lookup; the farm shop counter sells the village shop's farm goods. */
export function stockOf(store: UiStore, loc: Location, itemId: ItemId): number {
  if (unlimitedStock(loc, itemId)) return Infinity;
  const venue = loc.id === 'farmhouse' ? (store.stock.farmhouse ?? store.stock.shop) : store.stock[loc.id];
  return venue?.[itemId] ?? 0;
}

/** Whether a location with `hours` is open at game time `t` (no hours: always open). */
export function isOpen(loc: Location, t: number): boolean {
  if (!loc.hours) return true;
  const m = minuteOfDay(t);
  const open = parseClock(loc.hours.open);
  const close = parseClock(loc.hours.close);
  return open <= close ? m >= open && m < close : m >= open || m < close;
}

/** Chebyshev distance from a tile to a location's area (0 = inside it). */
export function distanceToArea(loc: Location, p: Point): number {
  const { x, y, w, h } = loc.area;
  const dx = p.x < x ? x - p.x : p.x >= x + w ? p.x - (x + w - 1) : 0;
  const dy = p.y < y ? y - p.y : p.y >= y + h ? p.y - (y + h - 1) : 0;
  return Math.max(dx, dy);
}

export function distance(a: Point, b: Point): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export const POST_OFFICE_ID: LocationId = 'post_office';
export const NOTICE_BOARD_ID: LocationId = 'notice_board';

/** Inside the post office, or within 2 tiles of its door (the post box). */
export function canSendLetters(store: UiStore): boolean {
  if (store.player?.inside?.locationId === POST_OFFICE_ID) return true;
  if (store.player?.inside) return false;
  const po = store.location(POST_OFFICE_ID);
  const p = store.playerTile();
  if (!po || !p) return false;
  return distance(p, po.door ?? po.entry) <= 2;
}

/** Within 3 tiles of the notice board (outdoors). */
export function nearNoticeBoard(store: UiStore): boolean {
  if (store.player?.inside) return false;
  const board = store.location(NOTICE_BOARD_ID);
  const p = store.playerTile();
  return !!board && !!p && distanceToArea(board, p) <= 3;
}

export function insidePostOffice(store: UiStore): boolean {
  return store.player?.inside?.locationId === POST_OFFICE_ID;
}

/** Locations the player can walk into (spec v2 §6). */
export function canEnter(loc: Location | undefined): boolean {
  return !!loc && (!!loc.interiorId || loc.kind === 'hotel' || loc.kind === 'post');
}
