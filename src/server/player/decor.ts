import type { DecorationItem, PlayerState, VillagerId } from '../../shared/types.ts';
import type { Ctx } from './context.ts';
import { distanceToRect } from './geometry.ts';
import type { CommandResult } from './types.ts';

/** Villagers within this many tiles of the cottage notice its decorations. */
export const DECOR_NOTICE_DISTANCE = 4;

/** Home decorating (spec §7.16): buy once, then place / put away for free. */
export class DecorController {
  private readonly seen = new Map<VillagerId, Set<string>>();
  /** Placed when the world was loaded; treated as already known so a restore does not re-announce them. */
  private readonly known: readonly string[];

  constructor(
    private readonly ctx: Ctx,
    private readonly player: PlayerState,
    private readonly onGoldChange: (delta: number, reason: string) => void,
  ) {
    this.known = [...player.placedDecorations];
  }

  def(id: string): DecorationItem | undefined {
    return this.ctx.catalogs.decorations.find((d) => d.id === id);
  }

  isPlaced(id: string): boolean {
    return this.player.placedDecorations.includes(id);
  }

  toggle(itemId: string): CommandResult {
    const item = this.def(itemId);
    if (!item) return { ok: false, reason: `Unknown decoration "${itemId}"` };
    const p = this.player;
    if (this.isPlaced(itemId)) {
      p.placedDecorations = p.placedDecorations.filter((d) => d !== itemId);
      this.ctx.toast(item.emoji, `${item.name} put away`);
      this.changed();
      return { ok: true };
    }
    if (!p.ownedDecorations.includes(itemId)) {
      if (p.gold < item.cost) {
        return {
          ok: false,
          reason: `Not enough gold for the ${item.name} (needs ${item.cost}, you have ${p.gold})`,
        };
      }
      p.ownedDecorations.push(itemId);
      this.onGoldChange(-item.cost, `bought ${item.name}`);
    }
    // One decoration per slot: placing an item puts away whatever sat there.
    p.placedDecorations = p.placedDecorations.filter((d) => this.def(d)?.slot !== item.slot);
    p.placedDecorations.push(itemId);
    this.ctx.toast(item.emoji, `${item.name} placed at your cottage ✓`);
    this.ctx.log(`${p.name} placed a ${item.name.toLowerCase()} at their cottage`);
    this.changed();
    return { ok: true };
  }

  private changed(): void {
    this.ctx.emit({ type: 'player.updated', player: structuredClone(this.player) });
  }

  /** Awake villagers passing the cottage observe decorations they have not seen yet. */
  update(): void {
    const home = this.ctx.home();
    if (!home || this.player.placedDecorations.length === 0) return;
    for (const v of this.ctx.awake()) {
      if (distanceToRect(home.area, v.pos) > DECOR_NOTICE_DISTANCE) continue;
      let seen = this.seen.get(v.id);
      if (!seen) this.seen.set(v.id, (seen = new Set(this.known)));
      const fresh = this.player.placedDecorations.filter((d) => !seen.has(d));
      if (fresh.length === 0) continue;
      for (const d of fresh) seen.add(d);
      const names = fresh.map((d) => this.def(d)?.name.toLowerCase() ?? d);
      this.ctx.host.addMemory(v.id, {
        at: this.ctx.host.now(),
        kind: 'observation',
        text: `${this.player.name}'s cottage has new ${joinNames(names)}`,
        importance: 3,
      });
    }
  }
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
