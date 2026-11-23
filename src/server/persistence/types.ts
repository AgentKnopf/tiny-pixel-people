/**
 * Persistence contract (WP5). JSON implementation in ./json-store.ts. See specs/technical-spec.md §11.
 */
import type { MindSnapshot } from '../cognition/types.ts';
import type {
  Conversation,
  DoorNote,
  GameMinutes,
  GroundItem,
  PlayerState,
  Rumor,
  VillageEvent,
  VillagerProfile,
  VillagerState,
  Weather,
  WorldEvent,
} from '../../shared/types.ts';

export const SAVE_SCHEMA_VERSION = 1;

export interface SaveData {
  schemaVersion: number;
  /** Real ISO timestamp. */
  savedAt: string;
  time: GameMinutes;
  rngState: number;
  villagers: VillagerState[];
  minds: MindSnapshot[];
  events: VillageEvent[];
  notes: DoorNote[];
  conversations: Conversation[];
  player: PlayerState;
  rumors: Rumor[];
  weather: Weather;
  items: GroundItem[];
  worldEvents: WorldEvent[];
  /** Transient visitors currently in town. */
  strangers: VillagerProfile[];
}

export interface SaveStore {
  save(data: SaveData): Promise<void>;
  /** null if the slot does not exist. */
  load(): Promise<SaveData | null>;
  exists(): Promise<boolean>;
  /** Append one broadcast message to replay.jsonl. */
  appendReplay(line: unknown): Promise<void>;
}
