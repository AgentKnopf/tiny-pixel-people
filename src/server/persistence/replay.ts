import type { ServerMessage } from '../../shared/protocol.ts';
import type { GameMinutes } from '../../shared/types.ts';
import { createLogger } from '../log.ts';
import type { SaveStore } from './types.ts';

const log = createLogger('replay');

/** Broadcast message types that are written to replay.jsonl (spec §7.13). Ticks and stats are not. */
export const REPLAY_TYPES: ReadonlySet<ServerMessage['type']> = new Set<ServerMessage['type']>([
  'conversation.message',
  'conversation.ended',
  'event.updated',
  'note.updated',
  'rumor.updated',
  'world.event',
  'weather.updated',
  'villagers.changed',
  'log',
]);

export interface ReplayLine {
  /** Real time, ISO. */
  at: string;
  /** Game time. */
  time: GameMinutes;
  msg: ServerMessage;
}

/**
 * Returns a listener for SimEngine.onMessage that appends replay-worthy messages to the store.
 * Write errors are logged, never thrown into the sim loop.
 */
export function createReplayRecorder(store: Pick<SaveStore, 'appendReplay'>, now: () => GameMinutes) {
  return (msg: ServerMessage): void => {
    if (!REPLAY_TYPES.has(msg.type)) return;
    const line: ReplayLine = { at: new Date().toISOString(), time: now(), msg };
    store
      .appendReplay(line)
      .catch((err: unknown) => log.warn(`replay write failed: ${(err as Error).message}`));
  };
}
