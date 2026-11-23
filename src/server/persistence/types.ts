/**
 * Persistence contract (WP5). JSON implementation in ./json-store.ts. See specs/technical-spec.md §11.
 */
import type { MindSnapshot } from '../cognition/types.ts';
import type {
  AnimalState,
  FarmState,
  FoodStock,
  HotelState,
  HouseVisit,
  KeepEntry,
  Letter,
  Notice,
  Romance,
  TrainState,
  VisitorInfo,
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

/** 2 = v2 expansion; v1 saves are upgraded by MIGRATIONS[1]. */
export const SAVE_SCHEMA_VERSION = 2;

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
  // ---------- v2 (spec v2 §15); optional so v1-shaped data still type-checks ----------
  /** Farm and zoo animals (ambient animals are reseeded, not saved). */
  animals?: AnimalState[];
  farm?: FarmState;
  train?: TrainState | null;
  visitors?: VisitorInfo[];
  hotel?: HotelState | null;
  romances?: Romance[];
  houseVisits?: HouseVisit[];
  stock?: FoodStock;
  letters?: Letter[];
  notices?: Notice[];
  keep?: KeepEntry[];
}

export interface SaveStore {
  save(data: SaveData): Promise<void>;
  /** null if the slot does not exist. */
  load(): Promise<SaveData | null>;
  exists(): Promise<boolean>;
  /** Append one broadcast message to replay.jsonl. */
  appendReplay(line: unknown): Promise<void>;
}
