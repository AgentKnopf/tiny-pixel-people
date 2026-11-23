import { dayOf, minuteOfDay, parseClock } from '../../shared/time.ts';
import type { AnimalChange } from '../sim/types.ts';
import type {
  AnimalSpecies,
  FoodStock,
  GameMinutes,
  ItemId,
  Location,
  LocationId,
  PlayerState,
} from '../../shared/types.ts';
import type { Ctx } from './context.ts';
import { distance, inRect } from './geometry.ts';
import { addToBackpack } from './inventory.ts';
import type { CommandResult, FarmEconomy } from './types.ts';

export const STOCK_CAP = 30;
export const SHOP_ID = 'shop';
export const FARM_SHOP_ID = 'farmhouse';
export const BURGER_JOINT_ID = 'burger_joint';
export const CHEESE_TIME = '18:00';
/** The player must stand inside the venue or this close to its entry to buy (tiles). */
export const BUY_DISTANCE = 3;

export const FOOD_PRICES: Readonly<Record<ItemId, number>> = {
  burger: 5,
  ice_cream: 3,
  milk: 2,
  egg: 1,
  cheese: 4,
  wool: 3,
};

/** Items sold by amount rather than one at a time: "some milk", not "a milk". */
const MASS_ITEMS: ReadonlySet<ItemId> = new Set(['milk', 'wool', 'cheese']);

/** "a burger", "an ice cream", "some milk". */
export function withArticle(itemId: ItemId, name: string): string {
  const noun = name.toLowerCase();
  if (MASS_ITEMS.has(itemId)) return `some ${noun}`;
  return `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`;
}

/** Burgers that reach the Burger Joint when an animal leaves for the butcher. */
export const BUTCHER_YIELD: Readonly<Partial<Record<AnimalSpecies, number>>> = {
  cow: 4,
  sheep: 2,
  chicken: 2,
};

const SHOP_ITEMS = ['milk', 'egg', 'wool', 'cheese'];

export function isIceCreamTruck(id: LocationId): boolean {
  return id.startsWith('ice_cream_truck');
}

/** Stock bucket a venue sells from; null when the venue sells nothing (or sells without stock). */
function stockKey(venueId: LocationId): LocationId | null {
  if (venueId === SHOP_ID || venueId === FARM_SHOP_ID) return SHOP_ID;
  if (venueId === BURGER_JOINT_ID) return BURGER_JOINT_ID;
  return null;
}

/** What a venue sells. */
export function venueItems(venueId: LocationId): readonly ItemId[] {
  if (isIceCreamTruck(venueId)) return ['ice_cream'];
  const key = stockKey(venueId);
  if (key === SHOP_ID) return SHOP_ITEMS;
  if (key === BURGER_JOINT_ID) return ['burger'];
  return [];
}

/** `hours` on the location, else zoo hours for zoo places and rides, else always open. */
export function isOpen(
  loc: Location,
  now: GameMinutes,
  zoo: { openTime: string; closeTime: string },
): boolean {
  const hours =
    loc.hours ??
    (loc.kind === 'zoo' || loc.kind === 'ride' ? { open: zoo.openTime, close: zoo.closeTime } : undefined);
  if (!hours) return true;
  const m = minuteOfDay(now);
  const open = parseClock(hours.open);
  const close = parseClock(hours.close);
  return open <= close ? m >= open && m < close : m >= open || m < close;
}

export function nearLocation(loc: Location, pos: { x: number; y: number }, max = BUY_DISTANCE): boolean {
  return inRect(loc.area, pos) || distance(loc.entry, pos) <= max;
}

/** Farm products and butcher yields become stock per venue (spec v2 §3.4). */
export class Farm implements FarmEconomy {
  private readonly food: FoodStock;
  private lastCheeseDay: number | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly player: PlayerState,
    private readonly spend: (amount: number, reason: string) => void,
    restored?: FoodStock,
  ) {
    this.food = restored ? structuredClone(restored) : {};
    this.food[SHOP_ID] ??= {};
    this.food[BURGER_JOINT_ID] ??= {};
    // A save made after today's cheese run must not run it again.
    const now = ctx.host.now();
    if (minuteOfDay(now) >= parseClock(CHEESE_TIME)) this.lastCheeseDay = dayOf(now);
  }

  stock(): Readonly<FoodStock> {
    return this.food;
  }

  count(venueId: LocationId, itemId: ItemId): number {
    if (isIceCreamTruck(venueId) && itemId === 'ice_cream') return Infinity;
    const key = stockKey(venueId);
    return key ? (this.food[key]?.[itemId] ?? 0) : 0;
  }

  /** The butcher toast is AnimalSim's (`change.toasts`); this only moves stock. */
  onAnimalChange(change: AnimalChange, _now: GameMinutes): { changed: boolean } {
    let changed = false;
    for (const p of change.produced) {
      if (SHOP_ITEMS.includes(p.itemId)) changed = this.add(SHOP_ID, p.itemId, p.count) || changed;
    }
    for (const r of change.removed) {
      if (r.reason !== 'butcher') continue;
      const burgers = BUTCHER_YIELD[r.species] ?? 0;
      if (burgers <= 0) continue;
      changed = this.add(BURGER_JOINT_ID, 'burger', burgers) || changed;
    }
    return { changed };
  }

  /** Once a day at 18:00 the barn turns 2 milk into 1 cheese. Returns true when stock changed. */
  update(now: GameMinutes): boolean {
    const day = dayOf(now);
    if (this.lastCheeseDay === day || minuteOfDay(now) < parseClock(CHEESE_TIME)) return false;
    this.lastCheeseDay = day;
    const shop = this.food[SHOP_ID]!;
    if ((shop.milk ?? 0) < 2) return false;
    shop.milk = (shop.milk ?? 0) - 2;
    this.add(SHOP_ID, 'cheese', 1);
    return true;
  }

  /** A villager eats; never blocks. Burgers fall back to a veggie burger when sold out. */
  consume(venueId: LocationId, itemId: ItemId): void {
    this.take(venueId, itemId);
  }

  /** Like `consume`, but tells the caller whether the item came from stock. */
  take(venueId: LocationId, itemId: ItemId): boolean {
    if (isIceCreamTruck(venueId)) return itemId === 'ice_cream';
    const key = stockKey(venueId);
    const bucket = key ? this.food[key] : undefined;
    if (!bucket || (bucket[itemId] ?? 0) < 1) return false;
    bucket[itemId] = (bucket[itemId] ?? 0) - 1;
    if (bucket[itemId] === 0) delete bucket[itemId];
    return true;
  }

  buy(venueId: LocationId, itemId: ItemId, now: GameMinutes): CommandResult {
    const loc = this.ctx.location(venueId);
    if (!loc) return { ok: false, reason: `Unknown place "${venueId}"` };
    const def = this.ctx.catalogs.items.find((i) => i.id === itemId);
    const price = FOOD_PRICES[itemId];
    if (!def || price === undefined || !venueItems(venueId).includes(itemId))
      return { ok: false, reason: `${loc.name} doesn't sell that` };
    if (!isOpen(loc, now, this.ctx.zoo)) return { ok: false, reason: `${loc.name} is closed right now` };
    if (!nearLocation(loc, this.player.pos)) return { ok: false, reason: `Walk to ${loc.name} first` };
    if (this.count(venueId, itemId) < 1) return { ok: false, reason: `${def.name} is sold out` };
    if (this.player.gold < price)
      return { ok: false, reason: `You need ${price} gold for ${withArticle(itemId, def.name)}` };
    this.take(venueId, itemId);
    this.spend(-price, `bought ${def.name.toLowerCase()}`);
    addToBackpack(this.player, itemId);
    const what = withArticle(itemId, def.name);
    this.ctx.toast(def.emoji, `You bought ${what} for ${price} gold`);
    this.ctx.log(`${this.player.name} bought ${what} at ${loc.name}`);
    return { ok: true };
  }

  /** Adds up to the cap; the excess is sold off with no effect. */
  private add(venueId: LocationId, itemId: ItemId, n: number): boolean {
    const bucket = (this.food[venueId] ??= {});
    const before = bucket[itemId] ?? 0;
    const after = Math.min(STOCK_CAP, before + Math.max(0, Math.floor(n)));
    if (after === before) return false;
    bucket[itemId] = after;
    return true;
  }
}
