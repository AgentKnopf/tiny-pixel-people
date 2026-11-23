/**
 * Simulation engine contract (WP2). Used by net/ (WS server), persistence and the test harness.
 * See specs/technical-spec.md §4. WP2 exports `createSimEngine: CreateSimEngine` from ./engine.ts.
 */
import type { ClientMessage, ServerMessage } from '../../shared/protocol.ts';
import type {
  Conversation,
  GameMinutes,
  Memory,
  VillagerId,
  VillagerProfile,
  WorldMap,
  WorldSnapshot,
} from '../../shared/types.ts';
import type { CreateConversationRunner, CreateMind } from '../cognition/types.ts';
import type { AppConfig } from '../config.ts';
import type { Providers } from '../llm/types.ts';
import type { SaveData } from '../persistence/types.ts';

export interface AdvanceOptions {
  /** Await the LLM queue between steps (virtual clock + mock provider). */
  drainLlm?: boolean;
  /** Game minutes per step (default 1). */
  step?: number;
}

export interface SimEngineOptions {
  config: AppConfig;
  /** The engine builds its own LlmQueue (WP1) from these. */
  providers: Providers;
  /** Default: data/map/village.json. */
  map?: WorldMap;
  /** Default: first `config.sim.villagers` entries of data/villagers.json. */
  profiles?: VillagerProfile[];
  /** Default: day 0 + config.sim.startTime. Ignored when `restore` is given. */
  startAt?: GameMinutes;
  /** Resume from a save (WP5). */
  restore?: SaveData;
  /** Default: WP3's `createMind` from cognition/mind.ts. WP2 tests may pass a stub mind. */
  createMind?: CreateMind;
  /** Default: WP3's `createConversationRunner` from cognition/conversation.ts. */
  createConversationRunner?: CreateConversationRunner;
}

export type CreateSimEngine = (opts: SimEngineOptions) => SimEngine;

export interface SimEngine {
  readonly map: WorldMap;
  readonly profiles: readonly VillagerProfile[];
  now(): GameMinutes;
  snapshot(): WorldSnapshot;
  /** Real-time mode: start/stop the interval tick loop. */
  start(): void;
  stop(): void;
  setSpeed(speed: number): void;
  /** Virtual-clock mode for tests and headless runs. */
  advance(gameMinutes: number, opts?: AdvanceOptions): Promise<void>;
  /** Handle a validated client command; returns direct replies for that client. */
  handleCommand(cmd: ClientMessage): ServerMessage[];
  /** Subscribe to broadcast messages (ticks, conversation, notes, events, logs). */
  onMessage(listener: (msg: ServerMessage) => void): () => void;
  /** Full memory stream of one villager (tests, inspector). Empty array for unknown ids. */
  memories(villagerId: VillagerId): readonly Memory[];
  /** Conversation history, oldest first (backs GET /api/conversations). */
  conversations(): readonly Conversation[];
  /** Everything needed to resume this world (WP5 JsonSaveStore.save). */
  toSaveData(): SaveData;
}
