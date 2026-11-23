import type {
  HelloMessage,
  InspectDataMsg,
  KeepDataMsg,
  LogMsg,
  ServerMessage,
  StatsMsg,
  ToastMsg,
  VillagerFrame,
  VillagerProfilePublic,
} from '../shared/protocol.ts';
import {
  PLAYER_HOME_ID,
  PLAYER_ID,
  type AnimalFrame,
  type AnimalId,
  type AnimalState,
  type FoodStock,
  type HotelState,
  type HouseVisit,
  type Letter,
  type LetterId,
  type Notice,
  type RideState,
  type Romance,
  type TrainState,
  type VisitorInfo,
  type ConversationId,
  type DoorNote,
  type Facing,
  type GameMinutes,
  type GroundItem,
  type LocationId,
  type NoteId,
  type PlayerState,
  type Point,
  type Rumor,
  type RumorId,
  type VillageEvent,
  type VillagerId,
  type VillagerStatus,
  type Weather,
  type WorldEvent,
  type WorldMap,
} from '../shared/types.ts';
import type { Connection } from './net.ts';
import type { WorldRenderer } from './render/renderer.ts';

/** How long a speech bubble stays up (real ms). */
export const BUBBLE_MS = 5000;
/** Animal emotes ("Caw!") are short. */
export const EMOTE_MS = 2500;
/** Moves longer than this (tiles) between two updates snap instead of gliding (teleport, reload). */
const SNAP_DISTANCE = 4;
const MIN_LERP_MS = 50;
const MAX_LERP_MS = 400;
const MAX_LOG = 200;

/** A moving thing in the world (villager, player, pet) with client-side interpolation. */
export interface Entity {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Real-time ms when the glide from `from` to `to` started. */
  t0: number;
  durMs: number;
  facing: Facing;
  status: VillagerStatus;
  activity: string;
  emoji: string;
  /** Last real-time ms the entity changed position. */
  lastMovedAt: number;
  lastUpdateAt: number;
}

/** An animal: the latest server state plus an interpolated position. */
export interface AnimalView {
  state: AnimalState;
  e: Entity;
  /** Animal sheets are side views only: the last horizontal facing, kept on vertical moves. */
  side: 'left' | 'right';
}

function sideOf(facing: Facing, prev: 'left' | 'right'): 'left' | 'right' {
  return facing === 'left' || facing === 'right' ? facing : prev;
}

export interface Bubble {
  speakerId: VillagerId;
  text: string;
  startedAt: number;
  durMs: number;
}

export interface ConversationView {
  id: ConversationId;
  participants: [VillagerId, VillagerId];
}

/** Client singletons, exposed as `window.tpp` for debugging and browser tests. */
export interface ClientApp {
  store: GameStore;
  net: Connection;
  renderer: WorldRenderer;
}

export type StoreListener = (msg: ServerMessage | LocalChange) => void;

/** Client-only changes the UI may care about. */
export type LocalChange =
  | { type: 'local.select'; villagerId: VillagerId | null }
  | { type: 'local.connection'; status: ConnectionStatus; text: string };

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

function newEntity(id: string, p: Point, facing: Facing, now: number): Entity {
  return {
    id,
    fromX: p.x,
    fromY: p.y,
    toX: p.x,
    toY: p.y,
    t0: now,
    durMs: 0,
    facing,
    status: 'idle',
    activity: '',
    emoji: '',
    lastMovedAt: -Infinity,
    lastUpdateAt: now,
  };
}

/** Interpolated position of an entity at real time `now`. */
export function entityPos(e: Entity, now: number): Point {
  if (e.durMs <= 0) return { x: e.toX, y: e.toY };
  const k = Math.min(1, Math.max(0, (now - e.t0) / e.durMs));
  return { x: e.fromX + (e.toX - e.fromX) * k, y: e.fromY + (e.toY - e.fromY) * k };
}

/** Whether the entity should play its walk cycle at `now`. */
export function isMoving(e: Entity, now: number): boolean {
  return e.status === 'walking' || now - e.lastMovedAt < 250;
}

function moveEntity(e: Entity, to: Point, facing: Facing | undefined, now: number): void {
  const cur = entityPos(e, now);
  const dist = Math.hypot(to.x - cur.x, to.y - cur.y);
  const sinceLast = now - e.lastUpdateAt;
  e.lastUpdateAt = now;
  if (facing) e.facing = facing;
  if (dist < 1e-4) {
    e.fromX = e.toX = to.x;
    e.fromY = e.toY = to.y;
    e.durMs = 0;
    return;
  }
  e.lastMovedAt = now;
  if (!facing) e.facing = facingFromDelta(to.x - cur.x, to.y - cur.y, e.facing);
  if (dist > SNAP_DISTANCE) {
    e.fromX = e.toX = to.x;
    e.fromY = e.toY = to.y;
    e.durMs = 0;
    return;
  }
  e.fromX = cur.x;
  e.fromY = cur.y;
  e.toX = to.x;
  e.toY = to.y;
  e.t0 = now;
  e.durMs = Math.min(MAX_LERP_MS, Math.max(MIN_LERP_MS, sinceLast));
}

export function facingFromDelta(dx: number, dy: number, fallback: Facing): Facing {
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return fallback;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

/**
 * Client-side mirror of the server world, fed by `ServerMessage`s.
 * Holds everything the renderer and UI panels read; `now` is real time in ms (performance.now()).
 */
export class GameStore {
  map: WorldMap | null = null;
  profiles = new Map<VillagerId, VillagerProfilePublic>();
  villagers = new Map<VillagerId, Entity>();
  player: PlayerState | null = null;
  playerEntity: Entity | null = null;
  petEntity: Entity | null = null;
  time: GameMinutes = 0;
  /** Real ms when `time` was last set by the server, for smooth clock extrapolation. */
  timeAt = 0;
  speed = 1;
  weather: Weather = { state: 'clear', since: 0, until: null };
  notes = new Map<NoteId, DoorNote>();
  events = new Map<string, VillageEvent>();
  rumors = new Map<RumorId, Rumor>();
  items: GroundItem[] = [];
  worldEvents = new Map<string, WorldEvent>();
  conversations = new Map<ConversationId, ConversationView>();
  bubbles = new Map<VillagerId, Bubble>();
  stats: StatsMsg | null = null;
  llm: HelloMessage['llm'] | null = null;
  debug = false;
  protocolVersion = 0;
  inspect: InspectDataMsg | null = null;
  selectedId: VillagerId | null = null;
  connection: ConnectionStatus = 'connecting';
  toasts: ToastMsg[] = [];
  log: LogMsg[] = [];
  lastError: string | null = null;
  // v2
  animals = new Map<AnimalId, AnimalView>();
  rides = new Map<LocationId, RideState>();
  train: TrainState | null = null;
  hotel: HotelState | null = null;
  visitors = new Map<VillagerId, VisitorInfo>();
  romances = new Map<string, Romance>();
  houseVisits = new Map<string, HouseVisit>();
  stock: FoodStock = {};
  letters = new Map<LetterId, Letter>();
  notices = new Map<string, Notice>();
  keepSize = 0;
  /** Last `keep.data` page, with `keep.added` entries prepended (newest first). */
  keep: KeepDataMsg | null = null;

  private listeners = new Set<StoreListener>();

  subscribe(fn: StoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(msg: ServerMessage | LocalChange): void {
    for (const fn of this.listeners) fn(msg);
  }

  setConnection(status: ConnectionStatus, text: string): void {
    this.connection = status;
    this.emit({ type: 'local.connection', status, text });
  }

  select(id: VillagerId | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    if (id === null || this.inspect?.villagerId !== id) this.inspect = null;
    this.emit({ type: 'local.select', villagerId: id });
  }

  apply(msg: ServerMessage, now: number): void {
    switch (msg.type) {
      case 'hello':
        this.applyHello(msg, now);
        break;
      case 'tick':
        this.setTime(msg.time, now);
        this.speed = msg.speed;
        for (const f of msg.villagers) this.applyFrame(f, now);
        if (msg.animals) for (const f of msg.animals) this.applyAnimalFrame(f, now);
        break;
      case 'animals.changed':
        for (const a of msg.added) this.upsertAnimal(a, now);
        for (const a of msg.updated) this.upsertAnimal(a, now);
        for (const r of msg.removed) {
          this.animals.delete(r.id);
          this.bubbles.delete(r.id);
        }
        break;
      case 'animal.emote':
        if (this.animals.has(msg.animalId)) this.say(msg.animalId, msg.emote, now, EMOTE_MS);
        break;
      case 'ride.updated':
        this.rides.set(msg.ride.locationId, msg.ride);
        break;
      case 'train.updated':
        this.train = msg.train;
        break;
      case 'hotel.updated':
        this.hotel = msg.hotel;
        break;
      case 'visitor.updated':
        this.visitors.set(msg.visitor.villagerId, msg.visitor);
        break;
      case 'romance.updated':
        this.romances.set(msg.romance.id, msg.romance);
        break;
      case 'visit.updated':
        this.houseVisits.set(msg.visit.id, msg.visit);
        break;
      case 'stock.updated':
        this.stock = msg.stock;
        break;
      case 'letter.updated':
        this.letters.set(msg.letter.id, msg.letter);
        break;
      case 'notice.updated':
        if (msg.removed) this.notices.delete(msg.notice.id);
        else this.notices.set(msg.notice.id, msg.notice);
        break;
      case 'keep.added':
        this.keepSize++;
        if (this.keep && !this.keep.entries.some((k) => k.id === msg.entry.id)) {
          this.keep = {
            ...this.keep,
            entries: [msg.entry, ...this.keep.entries],
            total: this.keep.total + 1,
          };
        }
        break;
      case 'keep.data':
        this.keep = msg;
        this.keepSize = Math.max(this.keepSize, msg.total);
        break;
      case 'conversation.message':
        this.conversations.set(msg.conversationId, {
          id: msg.conversationId,
          participants: [msg.speakerId, msg.listenerId],
        });
        this.say(msg.speakerId, msg.text, now);
        break;
      case 'conversation.ended':
        this.conversations.delete(msg.conversationId);
        break;
      case 'note.updated':
        this.notes.set(msg.note.id, msg.note);
        break;
      case 'event.updated':
        this.events.set(msg.event.id, msg.event);
        break;
      case 'inspect.data':
        if (msg.villagerId === this.selectedId) this.inspect = msg;
        break;
      case 'stats':
        this.stats = msg;
        break;
      case 'player.updated':
        this.applyPlayer(msg.player, now);
        break;
      case 'rumor.updated':
        this.rumors.set(msg.rumor.id, msg.rumor);
        break;
      case 'world.event':
        this.worldEvents.set(msg.event.id, msg.event);
        break;
      case 'weather.updated':
        this.weather = msg.weather;
        break;
      case 'items.updated':
        this.items = msg.items;
        break;
      case 'toast':
        this.toasts.push(msg);
        if (this.toasts.length > 20) this.toasts.shift();
        break;
      case 'villagers.changed':
        for (const p of msg.added) this.profiles.set(p.id, p);
        for (const id of msg.removed) {
          this.profiles.delete(id);
          this.villagers.delete(id);
          this.visitors.delete(id);
          this.bubbles.delete(id);
          if (this.selectedId === id) this.select(null);
        }
        break;
      case 'log':
        this.log.push(msg);
        if (this.log.length > MAX_LOG) this.log.shift();
        break;
      case 'error':
        this.lastError = msg.message;
        break;
    }
    this.emit(msg);
  }

  private applyHello(msg: HelloMessage, now: number): void {
    const s = msg.snapshot;
    this.protocolVersion = msg.protocolVersion;
    this.map = msg.map;
    this.llm = msg.llm;
    this.debug = msg.debug;
    this.profiles = new Map(msg.villagers.map((p) => [p.id, p]));
    this.setTime(s.time, now);
    this.speed = s.speed;
    this.weather = s.weather;
    this.notes = new Map(s.notes.map((n) => [n.id, n]));
    this.events = new Map(s.events.map((e) => [e.id, e]));
    this.rumors = new Map(s.rumors.map((r) => [r.id, r]));
    this.items = s.items;
    this.worldEvents = new Map(s.worldEvents.map((e) => [e.id, e]));
    this.conversations = new Map(
      s.activeConversations.map((c) => [c.id, { id: c.id, participants: c.participants }]),
    );
    this.villagers.clear();
    this.bubbles.clear();
    for (const v of s.villagers) {
      const e = newEntity(v.id, v.pos, v.facing, now);
      e.status = v.status;
      e.activity = v.activity.text;
      e.emoji = v.activity.emoji;
      this.villagers.set(v.id, e);
    }
    this.playerEntity = null;
    this.petEntity = null;
    this.applyPlayer(s.player, now);
    this.animals.clear();
    for (const a of s.animals ?? []) this.upsertAnimal(a, now);
    this.rides = new Map((s.rides ?? []).map((r) => [r.locationId, r]));
    this.train = s.train ?? null;
    this.hotel = s.hotel ?? null;
    this.visitors = new Map((s.visitors ?? []).map((v) => [v.villagerId, v]));
    this.romances = new Map((s.romances ?? []).map((r) => [r.id, r]));
    this.houseVisits = new Map((s.houseVisits ?? []).map((v) => [v.id, v]));
    this.stock = s.stock ?? {};
    this.letters = new Map((s.letters ?? []).map((l) => [l.id, l]));
    this.notices = new Map((s.notices ?? []).map((n) => [n.id, n]));
    this.keepSize = s.keepSize ?? 0;
    this.keep = null;
    if (this.selectedId && !this.villagers.has(this.selectedId) && !this.profiles.has(this.selectedId)) {
      this.select(null);
    }
  }

  private applyPlayer(p: PlayerState, now: number): void {
    this.player = p;
    if (!this.playerEntity) this.playerEntity = newEntity(PLAYER_ID, p.pos, p.facing, now);
    else moveEntity(this.playerEntity, p.pos, p.facing, now);
    this.playerEntity.status = p.path.length > 0 ? 'walking' : 'idle';
    const pet = p.pet;
    if (!this.petEntity) this.petEntity = newEntity('pet', pet.pos, pet.facing, now);
    else moveEntity(this.petEntity, pet.pos, pet.facing, now);
  }

  private applyFrame(f: VillagerFrame, now: number): void {
    if (f.id === PLAYER_ID) {
      if (!this.playerEntity) this.playerEntity = newEntity(f.id, f, f.facing, now);
      else moveEntity(this.playerEntity, f, f.facing, now);
      this.playerEntity.status = f.status;
      if (f.bubble) this.say(f.id, f.bubble, now);
      return;
    }
    let e = this.villagers.get(f.id);
    if (!e) {
      e = newEntity(f.id, f, f.facing, now);
      this.villagers.set(f.id, e);
    } else {
      moveEntity(e, f, f.facing, now);
    }
    e.status = f.status;
    e.activity = f.activity;
    e.emoji = f.emoji;
    if (f.bubble) this.say(f.id, f.bubble, now);
  }

  private upsertAnimal(a: AnimalState, now: number): void {
    const cur = this.animals.get(a.id);
    if (!cur) {
      const e = newEntity(a.id, a.pos, a.facing, now);
      e.status = a.status === 'walking' ? 'walking' : 'idle';
      const side = sideOf(a.facing, a.id.length % 2 === 0 ? 'right' : 'left');
      this.animals.set(a.id, { state: { ...a }, e, side });
      return;
    }
    moveEntity(cur.e, a.pos, a.facing, now);
    cur.state = { ...a };
    cur.side = sideOf(a.facing, cur.side);
  }

  private applyAnimalFrame(f: AnimalFrame, now: number): void {
    const a = this.animals.get(f.id);
    if (!a) return;
    moveEntity(a.e, f, f.facing, now);
    a.e.status = f.status === 'walking' ? 'walking' : 'idle';
    a.state.pos = { x: f.x, y: f.y };
    a.state.facing = f.facing;
    a.state.status = f.status;
    a.side = sideOf(f.facing, a.side);
  }

  /** Show a speech bubble over `speakerId`; repeating the current text does not restart it. */
  say(speakerId: string, text: string, now: number, durMs = BUBBLE_MS): void {
    const cur = this.bubbles.get(speakerId);
    if (cur && cur.text === text && now - cur.startedAt < cur.durMs) return;
    this.bubbles.set(speakerId, { speakerId, text, startedAt: now, durMs });
  }

  /** Bubbles still visible at `now` (expired ones are dropped). */
  activeBubbles(now: number): Bubble[] {
    const out: Bubble[] = [];
    for (const [id, b] of this.bubbles) {
      if (now - b.startedAt >= b.durMs) this.bubbles.delete(id);
      else out.push(b);
    }
    return out;
  }

  private setTime(t: GameMinutes, now: number): void {
    const dt = now - this.timeAt;
    const dm = t - this.time;
    if (this.timeAt > 0 && dt > 0 && dm >= 0 && dm < 120) {
      this.minutesPerMs = this.minutesPerMs * 0.7 + (dm / dt) * 0.3;
    }
    this.time = t;
    this.timeAt = now;
  }

  /** Observed game minutes per real ms (smoothed over ticks), for clock extrapolation. */
  minutesPerMs = 0;

  /** Game time extrapolated from the last server time, capped at one second of drift. */
  gameTimeAt(now: number): GameMinutes {
    if (this.speed === 0) return this.time;
    const dt = Math.min(1000, Math.max(0, now - this.timeAt));
    return this.time + dt * this.minutesPerMs;
  }

  displayName(id: string): string {
    if (id === PLAYER_ID) return this.player?.name ?? 'You';
    return this.profiles.get(id)?.name ?? id;
  }

  notesForHouse(houseId: LocationId): DoorNote[] {
    const out: DoorNote[] = [];
    for (const n of this.notes.values()) if (n.houseId === houseId) out.push(n);
    return out.sort((a, b) => a.postedAt - b.postedAt);
  }

  /** Where a villager's letters are delivered: the hotel for visitors, otherwise their home. */
  mailboxOf(id: VillagerId): LocationId | null {
    if (id === PLAYER_ID) return this.player?.homeId || PLAYER_HOME_ID;
    if (this.visitors.has(id) || this.profiles.get(id)?.visitor) return 'hotel';
    return this.profiles.get(id)?.homeId ?? null;
  }

  /** Letters waiting at each mailbox (delivered, not yet read), by location id. */
  lettersByMailbox(): Map<LocationId, Letter[]> {
    const out = new Map<LocationId, Letter[]>();
    for (const l of this.letters.values()) {
      if (l.status !== 'delivered') continue;
      const box = this.mailboxOf(l.to);
      if (!box) continue;
      let list = out.get(box);
      if (!list) out.set(box, (list = []));
      list.push(l);
    }
    return out;
  }

  /** Letters posted but not yet delivered (they wait at the post office). */
  undeliveredLetters(): Letter[] {
    return [...this.letters.values()].filter((l) => l.status === 'posted');
  }

  /** Position (tiles) of any entity id: villager, player or 'pet'. */
  positionOf(id: string, now: number): Point | null {
    if (id === PLAYER_ID) return this.playerEntity ? entityPos(this.playerEntity, now) : null;
    if (id === 'pet') return this.petEntity ? entityPos(this.petEntity, now) : null;
    const e = this.villagers.get(id) ?? this.animals.get(id)?.e;
    return e ? entityPos(e, now) : null;
  }
}
