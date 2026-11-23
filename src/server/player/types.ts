/**
 * Player, economy and world-event contracts (WP8). See specs/technical-spec.md §7.11–§7.16.
 * Data types shared with the client live in src/shared/types.ts; this file holds server-side handler contracts.
 */
import type {
  DecorationItem,
  ItemDef,
  PlayerState,
  Rumor,
  VillagerId,
  WorldEvent,
  WorldEventKind,
} from '../../shared/types.ts';

export type { DecorationItem, ItemDef, PlayerState, Rumor, WorldEvent, WorldEventKind };

export interface Catalogs {
  items: ItemDef[];
  decorations: DecorationItem[];
}

/** Result of a player command: ok, or a user-facing reason shown as a toast. */
export type CommandResult = { ok: true } | { ok: false; reason: string };

/** Server-side player/economy service. The engine (WP2) routes player.* / decor.* / pet.* / world.* commands here. */
export interface PlayerService {
  readonly state: Readonly<PlayerState>;
  addGold(amount: number, reason: string): void;
  pickup(itemId: string): void;
  gift(villagerId: VillagerId, itemId: string): CommandResult;
  toggleDecoration(itemId: string): CommandResult;
}

export interface RumorTracker {
  start(text: string, startedBy: VillagerId, originMemoryId: string, at: number): Rumor;
  /** Called when a conversation summary reports a learned fact with this originId. */
  recordHop(originMemoryId: string, hop: Rumor['hops'][number]): Rumor | null;
  all(): readonly Rumor[];
}

export interface WorldEventService {
  trigger(kind: WorldEventKind, opts?: { villagerId?: VillagerId }): CommandResult;
  active(): readonly WorldEvent[];
}
