/**
 * Shared domain types used by server and client. See specs/technical-spec.md §5–§7.
 * Changing these is a cross-work-package change: open a small dedicated PR.
 */

/** Minutes since day 0, 00:00 (game time). */
export type GameMinutes = number;
export type VillagerId = string;
export type LocationId = string;
export type MemoryId = string;
export type ConversationId = string;
export type EventId = string;
export type NoteId = string;
export type RumorId = string;
export type ItemId = string;

/** Id of the human player wherever a VillagerId is accepted (heardFrom, toldTo, relationships, messages). */
export const PLAYER_ID = 'player';
export const PLAYER_HOME_ID = 'player_home';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Facing = 'up' | 'down' | 'left' | 'right';

// ---------- World ----------

export type LocationKind = 'house' | 'shop' | 'public' | 'nature';

export interface Location {
  id: LocationId;
  name: string;
  kind: LocationKind;
  /** Area in tiles. */
  area: Rect;
  /** Tile villagers path to when they go here. */
  entry: Point;
  /** Door tile (houses); clickable for door notes. */
  door?: Point;
  ownerIds?: VillagerId[];
  /** Tiles to stand on while doing an activity here. */
  spots?: Point[];
  /** Decoration slots (player_home only). */
  decorSlots?: Point[];
  description?: string;
}

/** Named camera preset (Map modal / Home button). */
export interface Scene {
  id: 'plaza' | 'farm' | 'shop_street' | 'park' | 'home' | (string & {});
  name: string;
  subtitle: string;
  rect: Rect;
}

export interface ItemSpawnArea {
  itemId: ItemId;
  area: Rect;
  max: number;
}

export interface TilesetRef {
  /** Asset key, e.g. "tiles/village.png" (served from /assets). */
  image: string;
  tileSize: number;
  columns: number;
  /** Index of the first tile in this tileset within layer arrays. */
  firstIndex: number;
}

export interface WorldMap {
  width: number;
  height: number;
  tileSize: number;
  tilesets: TilesetRef[];
  /** Row-major tile-index arrays (length width*height); -1 = empty. */
  layers: {
    ground: number[];
    decor: number[];
    overhead: number[];
  };
  /** Row-major, 1 = blocked. */
  collision: (0 | 1)[];
  locations: Location[];
  scenes: Scene[];
  itemSpawns: ItemSpawnArea[];
}

// ---------- Villagers ----------

export interface VillagerProfile {
  id: VillagerId;
  name: string;
  age: number;
  occupation: string;
  /** 2–3 sentences. */
  bio: string;
  traits: string[];
  homeId: LocationId;
  /** Sprite sheet key, e.g. "characters/ada.png". */
  sprite: string;
  /** "HH:MM" */
  wakeTime: string;
  /** "HH:MM" */
  sleepTime: string;
  initialRelationships?: Record<VillagerId, number>;
  seedMemories?: string[];
  /** Item ids or keywords this villager likes as gifts. */
  likes?: string[];
  /** Strangers: leave at the end of the day. */
  transient?: boolean;
}

/** 0–100, 100 = fully satisfied. */
export interface Needs {
  hunger: number;
  energy: number;
  social: number;
  fun: number;
}

export type VillagerStatus = 'sleeping' | 'walking' | 'idle' | 'acting' | 'talking' | 'attending';

export interface Activity {
  text: string;
  emoji: string;
  locationId: LocationId | null;
  since: GameMinutes;
}

export interface PlanBlock {
  /** Minute of day (0–1439). */
  start: number;
  end: number;
  locationId: LocationId;
  activity: string;
  emoji?: string;
  eventId?: EventId;
  /** Set when the block fulfils a player request ("Ask to do it"). */
  taskId?: string;
  done?: boolean;
}

export interface DayPlan {
  day: number;
  summary: string;
  blocks: PlanBlock[];
  revision: number;
  source: 'llm' | 'fallback';
  createdAt: GameMinutes;
}

export interface Relationship {
  /** -10..10 */
  affinity: number;
  lastTalkedAt?: GameMinutes;
  summary?: string;
}

export interface VillagerState {
  id: VillagerId;
  /** Tile coordinates (float while walking). */
  pos: Point;
  facing: Facing;
  path: Point[];
  locationId: LocationId | null;
  status: VillagerStatus;
  activity: Activity;
  /** Latest thought / bubble text, shown as CURRENT THOUGHT. */
  thought: string;
  needs: Needs;
  plan: DayPlan | null;
  relationships: Record<VillagerId, Relationship>;
  conversationId?: ConversationId;
}

// ---------- Memory ----------

export type MemoryKind =
  'observation' | 'conversation' | 'heard' | 'reflection' | 'plan' | 'note' | 'event' | 'summary';

export interface MemoryMeta {
  heardFrom?: VillagerId;
  /** Root fact id for gossip tracing (own id for first-hand memories). */
  originId?: MemoryId;
  toldTo?: VillagerId[];
  conversationId?: ConversationId;
  noteId?: NoteId;
  eventId?: EventId;
  /** Reflection citations. */
  sourceIds?: MemoryId[];
  archived?: boolean;
}

export interface Memory {
  id: MemoryId;
  villagerId: VillagerId;
  createdAt: GameMinutes;
  lastAccessedAt: GameMinutes;
  kind: MemoryKind;
  text: string;
  /** 1–10 */
  importance: number;
  embedding?: number[];
  keywords: string[];
  meta: MemoryMeta;
}

// ---------- Social ----------

export interface ConversationMessage {
  speakerId: VillagerId;
  text: string;
  at: GameMinutes;
}

export interface Conversation {
  id: ConversationId;
  participants: [VillagerId, VillagerId];
  locationId: LocationId | null;
  startedAt: GameMinutes;
  endedAt?: GameMinutes;
  messages: ConversationMessage[];
  status: 'active' | 'ended' | 'aborted';
}

export type VillageEventStatus = 'proposed' | 'scheduled' | 'happening' | 'done' | 'cancelled';

export interface VillageEvent {
  id: EventId;
  title: string;
  description: string;
  hostId: VillagerId;
  locationId: LocationId;
  start: GameMinutes;
  end: GameMinutes;
  invitees: VillagerId[];
  accepted: VillagerId[];
  declined: VillagerId[];
  attendees: VillagerId[];
  status: VillageEventStatus;
}

export type DoorNoteStatus = 'unread' | 'read' | 'replied';

export interface DoorNote {
  id: NoteId;
  houseId: LocationId;
  ownerId: VillagerId;
  /** PLAYER_ID for notes from the player; a villager id for mailbox notes to the player. */
  authorId: VillagerId;
  text: string;
  postedAt: GameMinutes;
  readAt?: GameMinutes;
  reply?: string;
  repliedAt?: GameMinutes;
  status: DoorNoteStatus;
}

// ---------- Player, economy, world events ----------

export interface InventoryEntry {
  itemId: ItemId;
  count: number;
}

export interface ItemDef {
  id: ItemId;
  name: string;
  emoji: string;
  sprite: string;
}

export interface GroundItem {
  id: string;
  itemId: ItemId;
  pos: Point;
}

export interface DecorationItem {
  id: string;
  name: string;
  emoji: string;
  cost: number;
  sprite: string;
  /** Index into player_home decorSlots. */
  slot: number;
}

export interface PetState {
  name: string;
  species: string;
  pos: Point;
  facing: Facing;
  mode: 'follow' | 'stay';
}

export interface PlayerState {
  id: typeof PLAYER_ID;
  name: string;
  pos: Point;
  facing: Facing;
  path: Point[];
  homeId: LocationId;
  gold: number;
  inventory: InventoryEntry[];
  /** Decoration ids bought at least once. */
  ownedDecorations: string[];
  /** Decoration ids currently placed. */
  placedDecorations: string[];
  pet: PetState;
}

export interface RumorHop {
  from: VillagerId;
  to: VillagerId;
  at: GameMinutes;
  text: string;
  conversationId?: ConversationId;
}

export interface Rumor {
  id: RumorId;
  originMemoryId: MemoryId;
  text: string;
  startedBy: VillagerId;
  startedAt: GameMinutes;
  knownBy: VillagerId[];
  hops: RumorHop[];
}

export type WorldEventKind = 'rain' | 'party' | 'stranger' | 'birthday' | 'townEvent';

export interface WorldEvent {
  id: string;
  kind: WorldEventKind;
  startedAt: GameMinutes;
  endsAt: GameMinutes | null;
  /** e.g. { villageEventId }, { strangerId }, { villagerId } */
  data: Record<string, unknown>;
}

export interface Weather {
  state: 'clear' | 'rain';
  since: GameMinutes;
  until: GameMinutes | null;
}

// ---------- Snapshots ----------

export interface WorldSnapshot {
  time: GameMinutes;
  speed: number;
  villagers: VillagerState[];
  events: VillageEvent[];
  notes: DoorNote[];
  activeConversations: Conversation[];
  player: PlayerState;
  rumors: Rumor[];
  weather: Weather;
  items: GroundItem[];
  worldEvents: WorldEvent[];
}
