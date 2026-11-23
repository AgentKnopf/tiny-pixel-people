/**
 * WebSocket protocol between server and browser client. See specs/technical-spec.md §10.
 * Every message is a JSON text frame with a `type` discriminator.
 */
import type {
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
  Rumor,
  Weather,
  WorldEvent,
  WorldEventKind,
  WorldMap,
  WorldSnapshot,
} from './types.ts';

export const PROTOCOL_VERSION = 1;
export const WS_PATH = '/ws';

export const SPEEDS = [0, 1, 2, 4, 8] as const;
export type Speed = (typeof SPEEDS)[number];

/** Profile fields safe to show in the client. */
export type VillagerProfilePublic = Pick<
  VillagerProfile,
  'id' | 'name' | 'age' | 'occupation' | 'bio' | 'traits' | 'homeId' | 'sprite' | 'transient'
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
}

export interface ConversationMessageMsg {
  type: 'conversation.message';
  conversationId: ConversationId;
  speakerId: VillagerId;
  listenerId: VillagerId;
  text: string;
  time: GameMinutes;
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

/** Sent while the clock holds at day start waiting for day plans ('wakingUp'), and once when it resumes ('running'). */
export interface SimStatusMsg {
  type: 'sim.status';
  phase: 'wakingUp' | 'running';
  plansReady: number;
  villagers: number;
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
  | DebugJumpCmd;

export const NOTE_MAX_LENGTH = 500;
export const SAY_MAX_LENGTH = 300;
