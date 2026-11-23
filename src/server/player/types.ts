/**
 * Player, economy and world-event contracts (WP8). See specs/technical-spec.md §7.11–§7.16.
 * Data types shared with the client live in src/shared/types.ts; this file holds server-side handler contracts.
 */
import type { AnimalChange } from '../sim/types.ts';
import type {
  DoorNote,
  FoodStock,
  GameMinutes,
  HotelState,
  HouseVisit,
  ItemId,
  KeepEntry,
  KeepEntryKind,
  Letter,
  LetterId,
  LocationId,
  Notice,
  VillagerProfile,
  VisitorInfo,
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

// ---------- v2 services (spec v2 §3.4, §5, §6, §8). Owned by WP8; the engine (WP2) calls them. ----------

/** Turns animal products and butcher removals into stock; handles player.buy. */
export interface FarmEconomy {
  stock(): Readonly<FoodStock>;
  onAnimalChange(change: AnimalChange, now: GameMinutes): { changed: boolean };
  /** A villager eats at a venue; never blocks (veggie burger when out of stock). */
  consume(venueId: LocationId, itemId: ItemId): void;
  buy(venueId: LocationId, itemId: ItemId, now: GameMinutes): CommandResult;
}

export interface HotelService {
  state(): Readonly<HotelState>;
  freeRooms(): number;
  checkIn(guestId: VillagerId, now: GameMinutes): string | null;
  checkOut(guestId: VillagerId): void;
}

export interface VisitorService {
  visitors(): readonly VisitorInfo[];
  /** Profiles to spawn on the platform (pre-generated; never waits on the LLM). */
  onTrainArrived(now: GameMinutes): VillagerProfile[];
  /** Visitor ids that board now. */
  onTrainDeparting(now: GameMinutes, onPlatform: readonly VillagerId[]): VillagerId[];
  info(villagerId: VillagerId): VisitorInfo | null;
}

export interface HouseVisitService {
  enter(locationId: LocationId, now: GameMinutes): CommandResult;
  exit(now: GameMinutes): CommandResult;
  /** An owner arrived home / woke up: deliver pending snoop or sleeping visits. */
  onOwnerHome(villagerId: VillagerId, now: GameMinutes): HouseVisit[];
  visits(): readonly HouseVisit[];
}

export interface KeepArchive {
  add(entry: Omit<KeepEntry, 'id'>): KeepEntry;
  /** Newest first. */
  list(opts: { query?: string; kind?: KeepEntryKind; offset?: number; limit?: number }): {
    entries: KeepEntry[];
    total: number;
  };
  /** Deterministic keyword search (Laude's prompts). */
  search(query: string, k: number): KeepEntry[];
  size(): number;
}

export type PostLogEvent =
  | { kind: 'note'; note: DoorNote }
  | { kind: 'letter'; letter: Letter }
  | { kind: 'notice'; notice: Notice }
  | { kind: 'rumor'; rumor: Rumor; hop?: Rumor['hops'][number] };

/** Letters, notices and the Keep. `log` is the omniscience hook (spec v2 §8.3). */
export interface PostOfficeService {
  readonly keep: KeepArchive;
  sendLetter(from: VillagerId, to: VillagerId, text: string, now: GameMinutes): Letter | CommandResult;
  /** Delivery round (post.deliveryTimes); returns delivered letters. */
  deliver(now: GameMinutes): Letter[];
  markRead(letterId: LetterId, now: GameMinutes): Letter | null;
  postNotice(authorId: VillagerId, text: string, now: GameMinutes): Notice | CommandResult;
  expireNotices(now: GameMinutes): Notice[];
  letters(): readonly Letter[];
  notices(): readonly Notice[];
  /** Called synchronously for every door note, letter, notice and rumor change. */
  log(event: PostLogEvent, now: GameMinutes): KeepEntry;
}
