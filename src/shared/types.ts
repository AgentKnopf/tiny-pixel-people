/**
 * Shared domain types used by server and client. See specs/technical-spec.md §5–§7 and
 * specs/technical-spec-v2.md (v2 additions; every v2 field on a v1 type is optional).
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

export type LocationKind =
  | 'house'
  | 'shop'
  | 'public'
  | 'nature'
  // v2
  | 'zoo'
  | 'ride'
  | 'food'
  | 'farm'
  | 'station'
  | 'hotel'
  | 'post';

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
  // v2 (spec v2 §2.1)
  district?: DistrictId;
  hours?: LocationHours;
  ride?: RideSpec;
  /** Enclosure / pasture: which animal lives here. */
  species?: AnimalSpecies;
  /** Fenced area animals stay inside (enclosures, pastures, forest habitats). */
  pen?: Rect;
  /** Roof tiles the crow perches on (post_office). */
  perch?: Point[];
  /** InteriorTemplate id; the player can enter. */
  interiorId?: string;
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
  // v2 (spec v2 §2)
  districts?: District[];
  interiors?: InteriorTemplate[];
  railway?: { rows: [number, number]; platform: Rect };
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
  /** Train visitor (transient, stays at the hotel 1–3 days). */
  visitor?: boolean;
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

/** Whether a result came from a parsed LLM answer or from a fallback (including LLM answers that failed to parse). */
export type Provenance = 'llm' | 'fallback';

export interface DayPlan {
  day: number;
  summary: string;
  blocks: PlanBlock[];
  revision: number;
  source: Provenance;
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
  // v2 (spec v2 §8)
  letterId?: LetterId;
  /** Post office log entry (Laude's instant knowledge). */
  keepId?: string;
  noticeId?: string;
  /** Set on memories added by the influence API; shown to the observer, never put in a prompt. */
  influenceId?: string;
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
  /** Shared by reference (e.g. with save snapshots): replace it, never write into it. */
  embedding?: readonly number[];
  keywords: string[];
  meta: MemoryMeta;
}

// ---------- Social ----------

export interface ConversationMessage {
  speakerId: VillagerId;
  text: string;
  at: GameMinutes;
  source?: Provenance;
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
  /** How the proposal was made. */
  source?: Provenance;
  /** v2: 'date' events are private, outside maxProposalsPerDay (spec v2 §7). */
  kind?: 'event' | 'date';
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
  /** Set together with `reply`. */
  replySource?: Provenance;
  status: DoorNoteStatus;
  /** Influence notes: the cleaned signature villagers see; `authorId` stays PLAYER_ID. */
  signature?: string;
  /** Influence notes: villagers see "someone anonymous" or the signature, never the author. */
  anonymous?: boolean;
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
  /** v2: set while the player is inside an interior. */
  inside?: PlayerInside | null;
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

export type WorldEventKind =
  | 'rain'
  | 'party'
  | 'stranger'
  | 'birthday'
  | 'townEvent'
  // v2
  | 'train'
  | 'date'
  | 'couple'
  | 'farm';

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
  // v2 (spec v2 §14)
  animals?: AnimalState[];
  rides?: RideState[];
  train?: TrainState | null;
  visitors?: VisitorInfo[];
  hotel?: HotelState | null;
  romances?: Romance[];
  houseVisits?: HouseVisit[];
  stock?: FoodStock;
  letters?: Letter[];
  notices?: Notice[];
  keepSize?: number;
}
// ---------- v2: districts, interiors (spec v2 §2) ----------

export type DistrictId = 'town' | 'post_row' | 'zoo' | 'forest' | 'farmstead' | 'market' | 'station';

export interface District {
  id: DistrictId;
  name: string;
  rect: Rect;
}

export interface LocationHours {
  /** "HH:MM" */
  open: string;
  /** "HH:MM" */
  close: string;
}

export interface RideSpec {
  capacity: number;
  durationMin: number;
  playerCost: number;
  funGain: number;
}

export interface InteriorObject {
  /** e.g. "keep_cupboard" */
  id: string;
  pos: Point;
}

/** A small separate tile map shown when the player is inside a building. Not part of the world grid. */
export interface InteriorTemplate {
  id: string;
  name: string;
  width: number;
  height: number;
  tilesets?: TilesetRef[];
  layers: {
    ground: number[];
    decor: number[];
    overhead: number[];
  };
  collision: (0 | 1)[];
  /** Where the player appears, just inside the door. */
  entry: Point;
  /** Door tile inside; stepping on it (or player.exit) leaves. */
  exit: Point;
  /** Where residents who are home are drawn (bed, table, chair). */
  spots: Point[];
  objects?: InteriorObject[];
}

// ---------- v2: animals (spec v2 §3) ----------

export type AnimalId = string;

export const FARM_SPECIES = ['cow', 'sheep', 'chicken'] as const;
export type FarmSpecies = (typeof FARM_SPECIES)[number];

export const ZOO_SPECIES = [
  'lion',
  'elephant',
  'giraffe',
  'zebra',
  'penguin',
  'monkey',
  'panda',
  'flamingo',
  'kangaroo',
  'polar_bear',
  'hippo',
  'crocodile',
] as const;
export type ZooSpecies = (typeof ZOO_SPECIES)[number];

export const FOREST_SPECIES = ['deer', 'rabbit', 'squirrel', 'hedgehog', 'fox', 'bird', 'duck'] as const;
export type ForestSpecies = (typeof FOREST_SPECIES)[number];

export type AnimalSpecies = FarmSpecies | ZooSpecies | ForestSpecies | 'crow';

/** Hard cap of living farm animals per species; config can lower it, never raise it. */
export const FARM_CAP_PER_SPECIES = 10;

export type AnimalGroup = 'farm' | 'zoo' | 'ambient';
export type AnimalSex = 'female' | 'male';
export type AnimalStage = 'baby' | 'adult' | 'elder';
export type AnimalStatus = 'idle' | 'walking' | 'eating' | 'sleeping' | 'flying' | 'leaving';
export type AnimalRemovalReason = 'butcher' | 'oldAge';

export interface AnimalState {
  id: AnimalId;
  species: AnimalSpecies;
  group: AnimalGroup;
  name?: string;
  /** Farm animals only. */
  sex?: AnimalSex;
  bornAt?: GameMinutes;
  stage?: AnimalStage;
  /** Farm animals: drawn once at birth (game days). */
  lifespanDays?: number;
  /** Location whose `pen` (or `perch`) the animal lives in. */
  homeId: LocationId;
  pos: Point;
  facing: Facing;
  status: AnimalStatus;
  lastProducedAt?: GameMinutes;
  /** Farm females: time of their last birth (the per-mother 2-day gap, spec v2 §3.2). */
  lastBirthAt?: GameMinutes;
}

export interface AnimalFrame {
  id: AnimalId;
  x: number;
  y: number;
  facing: Facing;
  status: AnimalStatus;
}

export interface FarmState {
  /** false => the engine seeds zoo and farm animals on restore. */
  seeded: boolean;
  nextSeq: number;
  lastLifecycleDay: number | null;
  lastButcherDay: number | null;
}

/** Item counts per venue, e.g. { shop: { milk: 3 }, burger_joint: { burger: 4 } }. */
export type FoodStock = Record<LocationId, Record<ItemId, number>>;

// ---------- v2: rides, train, visitors, hotel (spec v2 §4–§5) ----------

export interface RideState {
  locationId: LocationId;
  status: 'idle' | 'running' | 'closed';
  riders: VillagerId[];
  queue: VillagerId[];
  cycleEndsAt: GameMinutes | null;
}

export type TrainStatus = 'away' | 'arriving' | 'boarding' | 'departing';

export interface TrainState {
  status: TrainStatus;
  /** Next (or current) arrival at the platform. */
  arrivesAt: GameMinutes;
  departsAt: GameMinutes;
  arriving: VillagerId[];
  departing: VillagerId[];
}

export interface VisitorInfo {
  villagerId: VillagerId;
  arrivedAt: GameMinutes;
  /** Scheduled train departure. */
  departsAt: GameMinutes;
  roomId: string | null;
  origin: string;
  reason?: string;
  status: 'arriving' | 'checkedIn' | 'leaving';
  /** How the profile was made. */
  source: Provenance;
}

export interface HotelRoom {
  id: string;
  guestId: VillagerId | null;
  since: GameMinutes | null;
}

export interface HotelState {
  locationId: LocationId;
  rooms: HotelRoom[];
}

// ---------- v2: romance (spec v2 §7) ----------

export type RomanceStage = 'crush' | 'dating' | 'couple' | 'ended';

export interface DateRecord {
  eventId: EventId;
  locationId: LocationId;
  at: GameMinutes;
  askedBy: VillagerId;
  status: 'planned' | 'done' | 'missed' | 'declined';
  source: Provenance;
}

export interface Romance {
  id: string;
  /** Sorted pair of villager ids. */
  pair: [VillagerId, VillagerId];
  stage: RomanceStage;
  since: GameMinutes;
  /** Who has a crush on the other (one or both of `pair`). */
  crushFrom: VillagerId[];
  /** Slow-burn pair (spec v2 §7.1). */
  shy?: boolean;
  dates: DateRecord[];
  updatedAt: GameMinutes;
}

// ---------- v2: interiors and house visits (spec v2 §6) ----------

export interface PlayerInside {
  locationId: LocationId;
  /** Interior coordinates. */
  pos: Point;
}

export type HouseVisitKind = 'visit' | 'sleeping' | 'snoop';

export interface HouseVisit {
  id: string;
  houseId: LocationId;
  ownerIds: VillagerId[];
  at: GameMinutes;
  kind: HouseVisitKind;
  greetedBy?: VillagerId;
  greeting?: string;
  greetingSource?: Provenance;
  /** When the owner learned about it (snoop / sleeping). */
  noticedAt?: GameMinutes | null;
  witnesses: VillagerId[];
}

// ---------- v2: post office (spec v2 §8) ----------

export type LetterId = string;
export type LetterStatus = 'posted' | 'delivered' | 'read' | 'replied' | 'returned';

export interface Letter {
  id: LetterId;
  /** PLAYER_ID or a villager id. */
  from: VillagerId;
  to: VillagerId;
  text: string;
  postedAt: GameMinutes;
  deliveredAt?: GameMinutes;
  readAt?: GameMinutes;
  /** Id of the letter this one answers. */
  replyTo?: LetterId;
  status: LetterStatus;
  /** Villager-written letters. */
  source?: Provenance;
}

export interface Notice {
  id: string;
  authorId: VillagerId;
  text: string;
  postedAt: GameMinutes;
  expiresAt: GameMinutes;
  eventId?: EventId;
  /** Laude's log memory id; readers use `originId ?? id` for gossip tracing. */
  originId?: MemoryId;
}

export type KeepEntryKind = 'note' | 'letter' | 'notice' | 'rumor' | 'reply';

export interface KeepEntry {
  id: string;
  kind: KeepEntryKind;
  at: GameMinutes;
  /** Id of the note, letter, notice or rumor. */
  refId: string;
  authorId: VillagerId;
  recipientId?: VillagerId;
  text: string;
}
