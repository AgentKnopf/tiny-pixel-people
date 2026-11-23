/**
 * Simulation engine contract (WP2). Used by net/ (WS server), persistence and the test harness.
 * See specs/technical-spec.md §4.
 */
import type { ClientMessage, ServerMessage } from '../../shared/protocol.ts';
import type { GameMinutes, WorldMap, WorldSnapshot, VillagerProfile } from '../../shared/types.ts';

export interface AdvanceOptions {
  /** Await the LLM queue between steps (virtual clock + mock provider). */
  drainLlm?: boolean;
  /** Game minutes per step (default 1). */
  step?: number;
}

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
}
