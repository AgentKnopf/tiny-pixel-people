/**
 * WebSocket protocol between server and browser client. See specs/technical-spec.md §10.
 * Every message is a JSON text frame with a `type` discriminator.
 */
import type {
  AnimalFrame,
  AnimalId,
  AnimalRemovalReason,
  AnimalSpecies,
  AnimalState,
  FoodStock,
  HotelState,
  HouseVisit,
  ItemId,
  KeepEntry,
  KeepEntryKind,
  Letter,
  LetterId,
  Notice,
  RideState,
  Romance,
  TrainState,
  VisitorInfo,
  Conversation,
  ConversationId,
  DoorNote,
  Facing,
  GameMinutes,
  LocationId,
  Memory,
  Relationship,
  VillageEvent,
  VillagerId,
  VillagerProfile,
  VillagerState,
  VillagerStatus,
  DayPlan,
  GroundItem,
  PlayerState,
  Point,
  Provenance,
  Rumor,
  Weather,
  WorldEvent,
  WorldEventKind,
  WorldMap,
  WorldSnapshot,
} from './types.ts';

/** 2 = v2 expansion (spec v2 §14); the v2 message types and fields are additive. */
export const PROTOCOL_VERSION = 2;
export const WS_PATH = '/ws';

export const SPEEDS = [0, 1, 2, 4, 8] as const;
export type Speed = (typeof SPEEDS)[number];

/** Profile fields safe to show in the client. */
export type VillagerProfilePublic = Pick<
  VillagerProfile,
  'id' | 'name' | 'age' | 'occupation' | 'bio' | 'traits' | 'homeId' | 'sprite' | 'transient' | 'visitor'
>;

export interface VillagerFrame {
  id: VillagerId;
  x: number;
  y: number;
  facing: Facing;
  status: VillagerStatus;
  activity: string;
  emoji: string;
  /** Current speech bubble text, if talking. */
  bubble?: string;
}

export interface QueueStats {
  queued: number;
  running: number;
  done: number;
  failed: number;
  avgLatencyMs: number;
  /** Totals for the stats card ("REAL MODEL CALLS"). */
  totalLatencyMs: number;
  totalTokens: number;
  lastReplyMs: number | null;
  tokensPerSecond: number | null;
  byTask?: Record<string, { done: number; failed: number; avgLatencyMs: number }>;
}

// ---------- Server -> client ----------

export interface HelloMessage {
  type: 'hello';
  protocolVersion: number;
  map: WorldMap;
  villagers: VillagerProfilePublic[];
  snapshot: WorldSnapshot;
  llm: { provider: string; model: string; embeddings: string | null };
  debug: boolean;
}

export interface TickMessage {
  type: 'tick';
  time: GameMinutes;
  speed: number;
  villagers: VillagerFrame[];
  /** v2: only animals that moved or changed status since the last tick. */
  animals?: AnimalFrame[];
}

export interface ConversationMessageMsg {
  type: 'conversation.message';
  conversationId: ConversationId;
  speakerId: VillagerId;
  listenerId: VillagerId;
  text: string;
  time: GameMinutes;
  source?: Provenance;
}

export interface ConversationEndedMsg {
  type: 'conversation.ended';
  conversationId: ConversationId;
  participants: [VillagerId, VillagerId];
  summary?: string;
}

export interface NoteUpdatedMsg {
  type: 'note.updated';
  note: DoorNote;
}

export interface EventUpdatedMsg {
  type: 'event.updated';
  event: VillageEvent;
}

export interface InspectDataMsg {
  type: 'inspect.data';
  villagerId: VillagerId;
  state: VillagerState;
  plan: DayPlan | null;
  /** Most recent 10 memories (newest first), embeddings stripped. */
  memories: Omit<Memory, 'embedding'>[];
  relationships: Record<VillagerId, Relationship>;
  currentConversation?: Conversation;
  /** v2 */
  romance?: Romance | null;
  visitor?: VisitorInfo | null;
}

export interface StatsMsg {
  type: 'stats';
  queue: QueueStats;
  llmOnline: boolean;
  simTicksPerSecond: number;
}

export interface PlayerUpdatedMsg {
  type: 'player.updated';
  player: PlayerState;
}

export interface RumorUpdatedMsg {
  type: 'rumor.updated';
  rumor: Rumor;
}

export interface WorldEventMsg {
  type: 'world.event';
  event: WorldEvent;
}

export interface WeatherUpdatedMsg {
  type: 'weather.updated';
  weather: Weather;
}

export interface ItemsUpdatedMsg {
  type: 'items.updated';
  items: GroundItem[];
}

export interface ToastMsg {
  type: 'toast';
  icon: string;
  text: string;
}

/** New villager (stranger arrives) or removal (stranger leaves). */
export interface VillagersChangedMsg {
  type: 'villagers.changed';
  added: VillagerProfilePublic[];
  removed: VillagerId[];
}

export interface LogMsg {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  text: string;
  time: GameMinutes;
}

/**
 * Day-start plan status. 'wakingUp': the clock holds at 06:00 waiting for day plans (wakeUpMode
 * 'hold'). 'planning': the clock runs while some villagers' plans are still on the way (wakeUpMode
 * 'soft'). Both repeat while they last; 'running' is sent once when all plans are settled or the
 * hold ends. `villagers` counts residents only (visitors left out).
 */
export interface SimStatusMsg {
  type: 'sim.status';
  phase: 'wakingUp' | 'planning' | 'running';
  plansReady: number;
  villagers: number;
}

// ---------- v2 server -> client (spec v2 §14) ----------

export interface AnimalsChangedMsg {
  type: 'animals.changed';
  added: AnimalState[];
  removed: { id: AnimalId; species: AnimalSpecies; reason: AnimalRemovalReason }[];
  updated: AnimalState[];
}

export interface AnimalEmoteMsg {
  type: 'animal.emote';
  animalId: AnimalId;
  emote: string;
}

export interface RideUpdatedMsg {
  type: 'ride.updated';
  ride: RideState;
}

export interface TrainUpdatedMsg {
  type: 'train.updated';
  train: TrainState;
}

export interface HotelUpdatedMsg {
  type: 'hotel.updated';
  hotel: HotelState;
}

export interface VisitorUpdatedMsg {
  type: 'visitor.updated';
  visitor: VisitorInfo;
}

export interface RomanceUpdatedMsg {
  type: 'romance.updated';
  romance: Romance;
}

export interface VisitUpdatedMsg {
  type: 'visit.updated';
  visit: HouseVisit;
}

export interface StockUpdatedMsg {
  type: 'stock.updated';
  stock: FoodStock;
}

export interface LetterUpdatedMsg {
  type: 'letter.updated';
  letter: Letter;
}

export interface NoticeUpdatedMsg {
  type: 'notice.updated';
  notice: Notice;
  removed?: boolean;
}

export interface KeepAddedMsg {
  type: 'keep.added';
  entry: KeepEntry;
}

/** Direct reply to keep.open. */
export interface KeepDataMsg {
  type: 'keep.data';
  entries: KeepEntry[];
  total: number;
  offset: number;
  requestId?: string;
}
export interface ErrorMsg {
  type: 'error';
  message: string;
  requestId?: string;
}

export type ServerMessage =
  | HelloMessage
  | TickMessage
  | ConversationMessageMsg
  | ConversationEndedMsg
  | NoteUpdatedMsg
  | EventUpdatedMsg
  | InspectDataMsg
  | StatsMsg
  | PlayerUpdatedMsg
  | RumorUpdatedMsg
  | WorldEventMsg
  | WeatherUpdatedMsg
  | ItemsUpdatedMsg
  | ToastMsg
  | VillagersChangedMsg
  | LogMsg
  | SimStatusMsg
  | AnimalsChangedMsg
  | AnimalEmoteMsg
  | RideUpdatedMsg
  | TrainUpdatedMsg
  | HotelUpdatedMsg
  | VisitorUpdatedMsg
  | RomanceUpdatedMsg
  | VisitUpdatedMsg
  | StockUpdatedMsg
  | LetterUpdatedMsg
  | NoticeUpdatedMsg
  | KeepAddedMsg
  | KeepDataMsg
  | ErrorMsg;

// ---------- Client -> server ----------

interface Base {
  requestId?: string;
}

export interface InspectCmd extends Base {
  type: 'inspect';
  villagerId: VillagerId | null;
}

export interface SpeedCmd extends Base {
  type: 'speed';
  speed: Speed;
}

export interface NotePostCmd extends Base {
  type: 'note.post';
  houseId: LocationId;
  text: string;
}

export interface SaveCmd extends Base {
  type: 'save';
}

export interface DebugInjectCmd extends Base {
  type: 'debug.inject';
  villagerId: VillagerId;
  text: string;
  importance?: number;
}

export interface DebugJumpCmd extends Base {
  type: 'debug.jump';
  toTime: GameMinutes;
}

export interface PlayerMoveCmd extends Base {
  type: 'player.move';
  to: Point;
}

export interface PlayerSayCmd extends Base {
  type: 'player.say';
  villagerId: VillagerId;
  text: string;
  /** 'ask' = "Ask to do it" (may become a task). */
  mode: 'say' | 'ask';
}

export interface PlayerRumorCmd extends Base {
  type: 'player.rumor';
  villagerId: VillagerId;
  text: string;
}

export interface PlayerPairTalkCmd extends Base {
  type: 'player.pairTalk';
  aId: VillagerId;
  bId: VillagerId;
}

export interface PlayerGiftCmd extends Base {
  type: 'player.gift';
  villagerId: VillagerId;
  itemId: string;
}

export interface WorldTriggerCmd extends Base {
  type: 'world.trigger';
  kind: WorldEventKind;
  /** Birthday: whose birthday (default: random or inspected villager). */
  villagerId?: VillagerId;
}

export interface DecorToggleCmd extends Base {
  type: 'decor.toggle';
  itemId: string;
}

export interface PetCmd extends Base {
  type: 'pet.command';
  action: 'follow' | 'stay' | 'pet' | 'rename';
  name?: string;
}

// ---------- v2 client -> server (spec v2 §14) ----------

export interface PlayerEnterCmd extends Base {
  type: 'player.enter';
  locationId: LocationId;
}

export interface PlayerExitCmd extends Base {
  type: 'player.exit';
}

export interface PlayerRideCmd extends Base {
  type: 'player.ride';
  locationId: LocationId;
}

export interface PlayerBuyCmd extends Base {
  type: 'player.buy';
  locationId: LocationId;
  itemId: ItemId;
}

export interface LetterSendCmd extends Base {
  type: 'letter.send';
  to: VillagerId;
  text: string;
}

export interface LetterReadCmd extends Base {
  type: 'letter.read';
  letterId: LetterId;
}

export interface NoticePostCmd extends Base {
  type: 'notice.post';
  text: string;
}

export interface KeepOpenCmd extends Base {
  type: 'keep.open';
  query?: string;
  kind?: KeepEntryKind;
  offset?: number;
  /** ≤ KEEP_PAGE_MAX */
  limit?: number;
}
export type ClientMessage =
  | InspectCmd
  | SpeedCmd
  | NotePostCmd
  | SaveCmd
  | PlayerMoveCmd
  | PlayerSayCmd
  | PlayerRumorCmd
  | PlayerPairTalkCmd
  | PlayerGiftCmd
  | WorldTriggerCmd
  | DecorToggleCmd
  | PetCmd
  | DebugInjectCmd
  | DebugJumpCmd
  | PlayerEnterCmd
  | PlayerExitCmd
  | PlayerRideCmd
  | PlayerBuyCmd
  | LetterSendCmd
  | LetterReadCmd
  | NoticePostCmd
  | KeepOpenCmd;

export const NOTE_MAX_LENGTH = 500;
export const SAY_MAX_LENGTH = 300;
export const NOTICE_MAX_LENGTH = 200;
export const KEEP_PAGE_MAX = 50;
