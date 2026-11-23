/**
 * Contract between the simulation engine (WP2) and agent cognition (WP3).
 * See specs/technical-spec.md §7. The engine owns physics; the mind owns decisions.
 */
import type {
  Conversation,
  DoorNote,
  GameMinutes,
  Location,
  LocationId,
  Memory,
  MemoryKind,
  MemoryMeta,
  VillageEvent,
  VillagerId,
  VillagerProfile,
  VillagerState,
} from '../../shared/types.ts';

export interface NearbyVillager {
  id: VillagerId;
  name: string;
  activity: string;
  /** Tiles. */
  distance: number;
  status: VillagerState['status'];
}

/** Read-only view of the world handed to a mind each sim step. */
export interface WorldView {
  now: GameMinutes;
  self: Readonly<VillagerState>;
  profile: Readonly<VillagerProfile>;
  nearby: NearbyVillager[];
  location: Readonly<Location> | null;
  locations: readonly Location[];
  /** Notes on this villager's own door. */
  notesAtHome: readonly DoorNote[];
  /** Known/public events. */
  events: readonly VillageEvent[];
  villagerNames: Readonly<Record<VillagerId, string>>;
}

export type Intent =
  | { type: 'goto'; locationId: LocationId; activity: string; emoji?: string }
  | { type: 'act'; activity: string; emoji?: string }
  | { type: 'sleep' }
  | { type: 'talk'; targetId: VillagerId }
  | { type: 'wait' };

export interface Observation {
  at: GameMinutes;
  kind: MemoryKind;
  text: string;
  importance?: number;
  meta?: MemoryMeta;
}

export interface MindBookkeeping {
  importanceSinceReflection: number;
  lastReflectionAt: GameMinutes | null;
  lastPlanAt: GameMinutes | null;
}

export interface MindSnapshot {
  villagerId: VillagerId;
  memories: Memory[];
  bookkeeping: MindBookkeeping;
}

export interface VillagerMind {
  readonly id: VillagerId;
  /** Sync and cheap, called every sim step; may enqueue LLM jobs. Never awaits. */
  update(view: WorldView): Intent;
  observe(obs: Observation): void;
  onArrive(view: WorldView, locationId: LocationId): void;
  wantsToTalkTo(view: WorldView, otherId: VillagerId): boolean;
  serialize(): MindSnapshot;
}

/** Runs the dialogue of a conversation the engine has started (both villagers already stopped). */
export interface ConversationRunner {
  run(conversation: Conversation, minds: [VillagerMind, VillagerMind]): Promise<Conversation>;
}

export interface RetrieveOptions {
  k?: number;
  kinds?: MemoryKind[];
  includeArchived?: boolean;
}

/** Memory stream contract (WP3). */
export interface MemoryStream {
  add(obs: Observation): Memory;
  all(): readonly Memory[];
  recent(n: number): Memory[];
  retrieve(query: string, now: GameMinutes, opts?: RetrieveOptions): Promise<Memory[]>;
}
