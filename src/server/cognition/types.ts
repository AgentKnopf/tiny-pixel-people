/**
 * Contract between the simulation engine (WP2) and agent cognition (WP3).
 * See specs/technical-spec.md §7. The engine owns physics; the mind owns decisions.
 */
import type {
  AnimalId,
  AnimalSpecies,
  VisitorInfo,
  HouseVisit,
  KeepEntry,
  Letter,
  Notice,
  Provenance,
  Romance,
  Conversation,
  ConversationId,
  DayPlan,
  DoorNote,
  GameMinutes,
  Location,
  LocationId,
  ItemId,
  Memory,
  MemoryId,
  MemoryKind,
  MemoryMeta,
  PlanBlock,
  VillageEvent,
  VillagerId,
  VillagerProfile,
  VillagerState,
  Weather,
} from '../../shared/types.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import type { AppConfig } from '../config.ts';
import type { LlmQueue } from '../llm/types.ts';

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
  weather?: Readonly<Weather>;
  // ---------- v2 ----------
  /** Romance records this villager is part of. */
  romances?: readonly Romance[];
  /** Active notices if the villager is within reading distance of the notice board. */
  noticesInReach?: readonly Notice[];
  /** Letters delivered to this villager's mailbox and not read yet (read on arrival home). */
  lettersAtHome?: readonly Letter[];
  /** Keyword search over the Keep (Laude's prompts, spec v2 §8.3). */
  searchKeep?: (query: string, k: number) => readonly KeepEntry[];
  /** Set for train visitors: departure time (the plan is cut on the leaving day), origin and reason. */
  visitor?: Readonly<VisitorInfo>;
  /** Animals within 4 tiles (forest observations, spec v2 §3.5). */
  animalsNearby?: readonly { id: AnimalId; species: AnimalSpecies; distance: number }[];
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
  /** Player said/asked/gave something to this villager (inspector). The engine broadcasts the reply bubble. */
  replyToPlayer(view: WorldView, input: PlayerInteraction): Promise<PlayerReply>;
  /** Propose a village event soon (toolbar "Town event"); the result arrives via world.upsertEvent. */
  requestEventProposal(): void;
  /** True once the plan for `day` is final (LLM plan in or fallback chosen); the engine's wake-up hold waits on it. */
  isPlanSettled?(day: number): boolean;
  // ---------- v2 (spec v2 §6–§8) ----------
  /** The player walked in while this villager is home and awake (`visit.greet`, with fallback). */
  greetVisitor?(view: WorldView, visit: HouseVisit): Promise<{ reply: string; source: Provenance }>;
  /**
   * Called after PostOfficeService marked a letter to this villager read and wrote the read memory.
   * Writes no read memory itself; for a player letter it queues one `letter.reply` (deduplicated per letter).
   */
  onLetterRead?(view: WorldView, letter: Letter): void;
}

export interface PlayerInteraction {
  text: string;
  mode: 'say' | 'ask' | 'gift';
  /** mode 'gift' */
  itemId?: ItemId;
  /** mode 'gift': item matches profile.likes (computed by WP8). */
  liked?: boolean;
}

export interface PlayerReply {
  reply: string;
  /** mode 'ask': outcome of task.decide. Accepted tasks are also added to the plan via world.setPlan. */
  task?: { taskId: string; accepted: boolean; activity: string; locationId: LocationId; start: number };
}

export interface LearnedFact {
  from: VillagerId;
  to: VillagerId;
  originId: MemoryId;
  /** The fact as learned. */
  text: string;
  /** The sentence in which it was said, if known. */
  said?: string;
  conversationId?: ConversationId;
  at: GameMinutes;
}

/**
 * Runs the dialogue of a conversation the engine has started (both villagers already stopped).
 * The runner appends to `conversation.messages`; the engine diffs them each tick and broadcasts
 * conversation.message + bubbles, so the runner must not emit conversation.message itself.
 */
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

/**
 * Write access to the world for one mind; every method acts on behalf of that mind's villager.
 * Minds change shared state only through this interface (never via `emit`).
 */
export interface MindWorld {
  setPlan(plan: DayPlan | null): void;
  /** CURRENT THOUGHT in the inspector. */
  setThought(text: string): void;
  /** Clamps affinity to -10..10 and sets lastTalkedAt = now. */
  adjustRelationship(otherId: VillagerId, delta: number, summary?: string): void;
  /** Create or update a door note; the engine broadcasts note.updated. */
  upsertNote(note: DoorNote): void;
  /** Create or update a village event; the engine broadcasts event.updated and tracks attendance. */
  upsertEvent(event: VillageEvent): void;
  events(): readonly VillageEvent[];
  notes(): readonly DoorNote[];
  /** A fact passed to this villager (the runner calls it on the listener's world); feeds RumorTracker.recordHop (WP8). */
  recordLearned?(fact: LearnedFact): void;
  /** A plan block tagged taskId finished; WP8 pays economy.taskReward. */
  taskCompleted?(taskId: string, block: PlanBlock): void;
  // ---------- v2 (spec v2 §7–§8) ----------
  /** Create or update a romance record involving this villager; the engine stores, broadcasts and saves it. */
  upsertRomance?(romance: Romance): void;
  romances?(): readonly Romance[];
  /** Post a letter from this villager (letter.reply / letter.write); delivered at the next round. */
  sendLetter?(to: VillagerId, text: string, opts?: { replyTo?: string; source?: Provenance }): Letter | null;
  /**
   * Add an observation to ANOTHER villager's memory stream. Only for the post office log
   * (Laude's instant knowledge, spec v2 §8.3); everything else goes through perception.
   */
  observeFor?(villagerId: VillagerId, obs: Observation): void;
}

/** Services the engine hands to each mind. */
export interface MindDeps {
  config: AppConfig;
  queue: LlmQueue;
  now: () => GameMinutes;
  /** Broadcast-only messages (log, toast). Not for notes, events or conversation messages. */
  emit: (msg: ServerMessage) => void;
  /** Bound to this mind's villager. */
  world: MindWorld;
  /** Seeded RNG in [0, 1) shared with the engine, for deterministic tests. */
  random: () => number;
  /** Restored state when loading a save. */
  snapshot?: MindSnapshot;
}

/** WP3 exports `createMind: CreateMind` from ./mind.ts. */
export type CreateMind = (profile: VillagerProfile, deps: MindDeps) => VillagerMind;

/** Services for the conversation runner (shared by all conversations). */
export interface ConversationRunnerDeps {
  config: AppConfig;
  queue: LlmQueue;
  now: () => GameMinutes;
  emit: (msg: ServerMessage) => void;
}

/** WP3 exports `createConversationRunner: CreateConversationRunner` from ./conversation.ts. */
export type CreateConversationRunner = (deps: ConversationRunnerDeps) => ConversationRunner;
