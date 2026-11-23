import type { GroundItem, InventoryEntry, ItemDef, ItemId, PlayerState } from '../../shared/types.ts';
import type { Ctx } from './context.ts';
import { randomTileIn, sameTile } from './geometry.ts';

export function countOf(inv: readonly InventoryEntry[], itemId: ItemId): number {
  return inv.find((e) => e.itemId === itemId)?.count ?? 0;
}

export function addToBackpack(player: PlayerState, itemId: ItemId, n = 1): void {
  const entry = player.inventory.find((e) => e.itemId === itemId);
  if (entry) entry.count += n;
  else player.inventory.push({ itemId, count: n });
}

/** Returns false (and changes nothing) if the backpack holds fewer than `n`. */
export function removeFromBackpack(player: PlayerState, itemId: ItemId, n = 1): boolean {
  const i = player.inventory.findIndex((e) => e.itemId === itemId);
  const entry = player.inventory[i];
  if (!entry || entry.count < n) return false;
  entry.count -= n;
  if (entry.count === 0) player.inventory.splice(i, 1);
  return true;
}

/** Forageable items lying on the map (spec §7.14): spawning, respawning, pickup. */
export class ItemField {
  items: GroundItem[] = [];
  private lastRespawnAt: number;

  constructor(
    private readonly ctx: Ctx,
    restored?: GroundItem[],
  ) {
    this.lastRespawnAt = ctx.host.now();
    if (restored) this.items = restored.map((i) => ({ ...i, pos: { ...i.pos } }));
    else this.topUp(false);
  }

  def(itemId: ItemId): ItemDef | undefined {
    return this.ctx.catalogs.items.find((i) => i.id === itemId);
  }

  update(): void {
    const now = this.ctx.host.now();
    if (now - this.lastRespawnAt >= this.ctx.cfg.economy.itemRespawnGameMinutes) {
      this.lastRespawnAt = now;
      this.topUp(true);
    }
  }

  /** Fill every spawn area of the map up to its `max`. */
  topUp(broadcast: boolean): void {
    const { map, random } = this.ctx.host;
    let added = 0;
    for (const spawn of map.itemSpawns) {
      if (!this.def(spawn.itemId)) continue;
      const inArea = this.items.filter(
        (i) =>
          i.itemId === spawn.itemId &&
          i.pos.x >= spawn.area.x &&
          i.pos.x < spawn.area.x + spawn.area.w &&
          i.pos.y >= spawn.area.y &&
          i.pos.y < spawn.area.y + spawn.area.h,
      ).length;
      for (let n = inArea; n < spawn.max; n++) {
        const pos = randomTileIn(
          map,
          spawn.area,
          () => random(),
          (p) => this.items.some((i) => sameTile(i.pos, p)),
        );
        if (!pos) break;
        this.items.push({ id: this.ctx.id('item'), itemId: spawn.itemId, pos });
        added++;
      }
    }
    if (added > 0 && broadcast) this.broadcast();
  }

  /** Remove and return the items on the tile at `pos`. */
  takeAt(pos: { x: number; y: number }): GroundItem[] {
    const taken = this.items.filter((i) => sameTile(i.pos, pos));
    if (taken.length > 0) this.items = this.items.filter((i) => !taken.includes(i));
    return taken;
  }

  take(groundItemId: string): GroundItem | undefined {
    const item = this.items.find((i) => i.id === groundItemId);
    if (item) this.items = this.items.filter((i) => i !== item);
    return item;
  }

  broadcast(): void {
    this.ctx.emit({ type: 'items.updated', items: this.items.map((i) => ({ ...i, pos: { ...i.pos } })) });
  }
}
