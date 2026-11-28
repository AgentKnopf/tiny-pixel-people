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
import type { InfluenceEntry } from '../../shared/influence.ts';

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
  /** Observer API state (town log, real-time anchors). */
  observer?: ObserverSaveData;
  /** Influence API day counter and log (specs/influence-api-v2.md §7). */
  influence?: InfluenceSaveData;
}

export interface TownLogEntry {
  /** Increasing id, unique within a save. */
  seq: number;
  /** Real ISO-8601 time the entry was recorded. */
  ts: string;
  /** Game minutes. */
  tick: GameMinutes;
  type: string;
  agents: string[];
  text: string;
  data?: Record<string, unknown>;
}

export interface ObserverSaveData {
  /** Town log ring buffer, oldest first. */
  log: TownLogEntry[];
  /** [epoch ms, game minutes] pairs, oldest first, used to map game times to real timestamps. */
  anchors: [number, number][];
}

export interface InfluenceSaveData {
  /** Game day `used` counts for (`dayOf(tick)`). */
  day: number;
  /** Accepted influences on `day`. */
  used: number;
  /** Next `inf_<n>` number. */
  nextId: number;
  /** Oldest first, at most `influence.logMax`. */
  entries: InfluenceEntry[];
}

export interface SaveStore {
  save(data: SaveData): Promise<void>;
  /** null if the slot does not exist. */
  load(): Promise<SaveData | null>;
  exists(): Promise<boolean>;
  /** Append one broadcast message to replay.jsonl. */
  appendReplay(line: unknown): Promise<void>;
}
