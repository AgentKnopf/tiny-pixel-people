import {
  NOTE_MAX_LENGTH,
  type ClientMessage,
  type ServerMessage,
  type SimStatusMsg,
  type VillagerFrame,
  type VillagerProfilePublic,
} from '../../shared/protocol.ts';
import { MINUTES_PER_DAY, dayOf, formatClock, minuteOfDay, parseClock } from '../../shared/time.ts';
import {
  PLAYER_ID,
  type AnimalSpecies,
  type Conversation,
  type DoorNote,
  type GameMinutes,
  type HouseVisit,
  type Location,
  type Memory,
  type Notice,
  type PlayerState,
  type Provenance,
  type Point,
  type VillageEvent,
  type VillagerId,
  type VillagerProfile,
  type VillagerState,
  type VisitorInfo,
  type WorldMap,
  type WorldSnapshot,
} from '../../shared/types.ts';
import type {
  ConversationRunner,
  Intent,
  MindWorld,
  NearbyVillager,
  Observation,
  PlayerReply,
  VillagerMind,
  WorldView,
} from '../cognition/types.ts';
import { createConversationRunner } from '../cognition/conversation.ts';
import { loadTracker } from '../cognition/llm.ts';
import { createMind, Mind } from '../cognition/mind.ts';
import type { AppConfig } from '../config.ts';
import { createLlmQueue, type PriorityLlmQueue } from '../llm/queue.ts';
import { createLogger } from '../log.ts';
import { Autosaver, JsonSaveStore, createReplayRecorder } from '../persistence/index.ts';
import { SAVE_SCHEMA_VERSION, type SaveData } from '../persistence/types.ts';
import {
  createPlayerWorld,
  type CommandResult,
  type PlayerHost,
  type PlayerReplyRequest,
  type PlayerWorld,
} from '../player/index.ts';
import { LAUDE_ID, NOTICE_BOARD_ID } from '../player/post-office.ts';
import { POST_OFFICE_ID } from '../player/house-visits.ts';
import { playerConversationId } from '../player/player.ts';
import { createAnimalSim, type AnimalStepResult, type DeterministicAnimalSim } from './animals.ts';
import { SimBus } from './bus.ts';
import { SimClock } from './clock.ts';
import { advanceAlongPath, distance, facingFor, tileOf } from './movement.ts';
import { CONVERSATION_SOCIAL_BONUS, initialNeeds, updateNeeds } from './needs.ts';
import { isWalkable, PathFinder } from './pathfinding.ts';
import { currentBlock, isAwakeAt } from './plan.ts';
import { Rng } from './rng.ts';
import { createStubConversationRunner } from './stub-mind.ts';
import { TownLog } from './town-log.ts';
import { recordTownLog } from './town-recorder.ts';
import { Rides } from './rides.ts';
import { Train } from './train.ts';
import type { AdvanceOptions, SimEngine, SimEngineOptions } from './types.ts';
import {
  distanceToArea,
  isAt,
  loadMap,
  loadProfiles,
  locationAt,
  locationById,
  nearestWalkable,
} from './world.ts';

const log = createLogger('sim');

/** Villager walking speed in tiles per game minute. */
export const WALK_TILES_PER_GAME_MINUTE = 1.5;
/** Villagers this close (tiles) may start a conversation (spots on the square are ~3 tiles apart). */
export const CHAT_RADIUS = 3;
/** The initiator walks up to this distance before the dialogue starts. */
export const CONVERSATION_DISTANCE = 1.5;
export const PERCEPTION_RADIUS = 4;
export const NEARBY_RADIUS = 6;
export const OBSERVATION_COOLDOWN_MINUTES = 30;
export const VILLAGER_CONVERSATION_COOLDOWN = 30;
export const MAX_CONVERSATION_GAME_MINUTES = 60;
/** Player chats wait at most this long for the villager's reply before giving up. */
export const PLAYER_CHAT_TIMEOUT_MINUTES = 90;
/** A villager stays with the player this long after its last reply before resuming its plan. */
export const PLAYER_CHAT_HOLD_MINUTES = 5;
const SOCIAL_TRAITS = /outgoing|friendly|cheerful|social|warm|generous|chatty|organi[sz]ed|lively/i;
const PLAYER_REPLY_FALLBACK = "Sorry, I'm a bit distracted right now.";
export const MAX_VILLAGERS = 20;
/** The crow caws when the player comes this close (tiles). */
export const CROW_CAW_RADIUS = 3;
export const ANIMALS_NEARBY_RADIUS = 4;
/** Villagers this close (tiles) to the notice board read it (spec v2 §8.2). */
export const NOTICE_READ_RADIUS = 3;
/** An owner greeting the player stops for at most this long (spec v2 §6). */
export const GREETING_HOLD_MINUTES = 10;
/** What villagers do at a ride after their cycle, or after giving up on the queue (spec v2 §4). */
export const RIDE_FALLBACK_ACTIVITY = 'watching the rides';
export const AFTER_RIDE_ACTIVITY = 'chatting about the ride';
const RIDE_EMOJI: Record<string, string> = { rollercoaster: '🎢', ferris_wheel: '🎡', carousel: '🎠' };
/** Bubbles stay visible for this many real milliseconds. */
export const BUBBLE_MS = 5000;
const STATS_INTERVAL_MS = 2000;
/** The clock waits here each morning until the villagers' plans for the day are settled. */
export const WAKE_UP_MINUTE = 6 * 60;
/** Virtual-clock mode gives up waiting after this many drain rounds. */
const WAKE_UP_MAX_ROUNDS = 5;
/** Real-time grace before an idle LLM queue counts as "every plan request has finished". */
const WAKE_UP_IDLE_GRACE_MS = 1500;
/** WP3's nightly usage line; also printed to the server terminal. */
const LLM_USE_PREFIX = 'LLM use so far';

const FULL_FRAME_EVERY_TICKS = 50;

export type CommandHandler = (cmd: ClientMessage, host: SimHost) => ServerMessage[] | void;

interface Target {
  locationId: string | null;
  spot: Point;
  activity: string;
  emoji: string;
  sleep: boolean;
}

interface Runtime {
  profile: VillagerProfile;
  state: VillagerState;
  mind: VillagerMind;
  target: Target | null;
  arrived: boolean;
  lastConversationEnd: GameMinutes;
  bubble: { text: string; untilMs: number; untilGame: GameMinutes } | null;
  seen: Map<string, { activity: string; at: GameMinutes }>;
  approach: { conversationId: string; partnerId: VillagerId } | null;
  /** Ride this villager already rode during the current visit (one cycle per visit). */
  rodeAt?: string | null;
  /** Finished a cycle during the current ride block; stays at `to` until the plan moves on. */
  doneRide?: { rideId: string; to: string } | null;
}

interface ActiveConversation {
  conversation: Conversation;
  sent: number;
  started: boolean;
  withPlayer: boolean;
  /** Player chats: the id clients see (`player:<villagerId>`), shared with WP8's player lines. */
  publicId?: string;
  pendingReplies?: number;
  holdUntil?: GameMinutes;
}

/** Engine API for server modules that extend the sim (WP8 player/economy/world events, persistence). */
export interface SimHost {
  readonly map: WorldMap;
  readonly config: AppConfig;
  readonly bus: SimBus;
  readonly queue: PriorityLlmQueue;
  readonly playerWorld: PlayerWorld;
  readonly restoredFrom: SaveData | null;
  now(): GameMinutes;
  random(): number;
  profile(id: VillagerId): VillagerProfile | undefined;
  villager(id: VillagerId): VillagerState | undefined;
  mind(id: VillagerId): VillagerMind | undefined;
  villagerIds(): VillagerId[];
  view(id: VillagerId): WorldView | null;
  observe(id: VillagerId, obs: Observation): void;
  broadcast(msg: ServerMessage): void;
  toast(icon: string, text: string): void;
  log(level: 'info' | 'warn' | 'error', text: string): void;
  adjustRelationship(a: VillagerId, b: VillagerId, delta: number, summary?: string): void;
  events(): readonly VillageEvent[];
  upsertEvent(event: VillageEvent): void;
  notes(): readonly DoorNote[];
  upsertNote(note: DoorNote): void;
  /** Spawn a (transient) villager at `at` (default: east road edge). False when the 20-villager cap is hit. */
  addVillager(profile: VillagerProfile, at?: Point): boolean;
  removeVillager(id: VillagerId): void;
  /** Start a conversation now; `force` ignores cooldowns and willingness (Have them talk). */
  startConversation(a: VillagerId, b: VillagerId, force?: boolean): string | null;
  /** Replace a built-in command handler or add one (player.gift, world.trigger, decor.toggle, save…). */
  registerCommand(type: ClientMessage['type'], handler: CommandHandler): void;
  /** Keep the engine (and advance({drainLlm})) aware of async work started outside the queue. */
  track(p: Promise<unknown>): void;
  setLlmOnline(online: boolean): void;
}

const clampAffinity = (v: number) => Math.max(-10, Math.min(10, v));

function visitorField(info: VisitorInfo | null): { visitor?: VisitorInfo } {
  return info ? { visitor: structuredClone(info) } : {};
}

export function toPublicProfile(p: VillagerProfile): VillagerProfilePublic {
  const out: VillagerProfilePublic = {
    id: p.id,
    name: p.name,
    age: p.age,
    occupation: p.occupation,
    bio: p.bio,
    traits: p.traits,
    homeId: p.homeId,
    sprite: p.sprite,
  };
  if (p.transient) out.transient = true;
  if (p.visitor) out.visitor = true;
  return out;
}

export class Engine implements SimEngine, SimHost {
  readonly map: WorldMap;
  readonly config: AppConfig;
  readonly bus = new SimBus();
  readonly queue: PriorityLlmQueue;
  readonly playerWorld: PlayerWorld;
  readonly restoredFrom: SaveData | null;
  readonly store: JsonSaveStore;
  /** Town event log and game-to-real time anchors (observer API). */
  readonly townLog: TownLog;
  readonly animals: DeterministicAnimalSim;
  /** null when `train.enabled` is false or the map has no station. */
  readonly train: Train | null;
  readonly rides: Rides;

  private readonly clock: SimClock;
  private readonly rng: Rng;
  private readonly paths: PathFinder;
  private readonly autosaver: Autosaver;
  private readonly runtimes = new Map<VillagerId, Runtime>();
  private readonly createMindFn: NonNullable<SimEngineOptions['createMind']>;
  private readonly runner: ConversationRunner;
  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly pending = new Set<Promise<unknown>>();

  private eventList: VillageEvent[] = [];
  private noteList: DoorNote[] = [];
  private history: Conversation[] = [];
  private readonly active = new Map<string, ActiveConversation>();
  private eventPresence = new Map<string, Map<string, number>>();

  private seq = 0;
  private lastMinute: number;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastRealMs = 0;
  private lastStatsMs = 0;
  private ticksSinceStats = 0;
  private tickCount = 0;
  private lastFrames = new Map<VillagerId, string>();
  private stepping = false;
  private wokeDay = -1;
  private idleProbe: { done: boolean } | null = null;
  private wakeHold: { day: number; startedMs: number; ready: number; rounds: number } | null = null;
  private playerNearCrow = false;
  private deferred: ServerMessage[] = [];

  constructor(opts: SimEngineOptions) {
    const cfg = opts.config;
    this.config = cfg;
    this.map = opts.map ?? loadMap();
    const restore = opts.restore ?? null;
    this.restoredFrom = restore;
    const startAt = restore?.time ?? opts.startAt ?? parseClock(cfg.sim.startTime);
    this.clock = new SimClock(startAt, {
      dayLengthMinutes: cfg.sim.dayLengthMinutes,
      speed: cfg.sim.speed,
      nightSpeedMultiplier: cfg.sim.nightSpeedMultiplier,
    });
    this.lastMinute = Math.floor(startAt);
    this.townLog = new TownLog({
      size: cfg.observer?.logSize ?? 5000,
      now: () => this.clock.time,
      realMsPerGameMinute: (cfg.sim.dayLengthMinutes * 60_000) / MINUTES_PER_DAY,
      restore: restore?.observer,
    });
    this.rng = new Rng(cfg.sim.seed);
    if (restore) this.rng.state = restore.rngState;
    this.paths = new PathFinder(this.map);
    this.queue = createLlmQueue(cfg.llm, opts.providers, {
      now: () => this.now(),
      embedConcurrency: cfg.embeddings.concurrency,
    });
    this.createMindFn = opts.createMind ?? createMind;
    const runnerDeps = {
      config: cfg,
      queue: this.queue,
      now: () => this.now(),
      emit: (m: ServerMessage) => this.broadcast(m),
    };
    const stubRunner = createStubConversationRunner(
      (id) => this.nameOf(id),
      () => this.now(),
    );
    if (opts.createConversationRunner) this.runner = opts.createConversationRunner(runnerDeps);
    else {
      // WP3's runner only talks for its own minds; custom minds (tests, headless tools) get small talk.
      const llmRunner = createConversationRunner(runnerDeps);
      this.runner = {
        run: (c, minds) =>
          minds[0] instanceof Mind && minds[1] instanceof Mind
            ? llmRunner.run(c, minds)
            : stubRunner.run(c, minds),
      };
    }
    this.store = new JsonSaveStore({ dir: cfg.persistence.dir, slot: cfg.persistence.slot });
    this.autosaver = new Autosaver({
      store: this.store,
      intervalGameMinutes: cfg.persistence.autosaveGameMinutes,
      collect: () => this.toSaveData(),
    });
    this.onMessage(createReplayRecorder(this.store, () => this.now()));
    this.playerWorld = createPlayerWorld({
      host: this.createPlayerHost(),
      config: {
        player: cfg.player,
        economy: cfg.economy,
        world: cfg.world,
        maxVillagers: MAX_VILLAGERS,
        zoo: cfg.zoo,
        train: cfg.train,
        visitors: cfg.visitors,
        hotel: cfg.hotel,
        interiors: cfg.interiors,
        post: cfg.post,
      },
      ...(restore ? { restore } : {}),
    });
    if (restore) {
      this.eventList = structuredClone(restore.events);
      this.noteList = structuredClone(restore.notes);
      this.history = structuredClone(restore.conversations).map((c) =>
        c.status === 'active' ? { ...c, status: 'aborted' as const, endedAt: restore.time } : c,
      );
    }

    const profiles = opts.profiles ?? loadProfiles(this.map, undefined, cfg.sim.villagers);
    const all = restore
      ? [...profiles, ...restore.strangers.filter((s) => !profiles.some((p) => p.id === s.id))]
      : profiles;
    for (const p of all.slice(0, MAX_VILLAGERS)) {
      const saved = restore?.villagers.find((v) => v.id === p.id);
      const snapshot = restore?.minds.find((m) => m.villagerId === p.id);
      this.addRuntime(p, saved ? this.restoreState(saved) : this.initialState(p), snapshot);
    }
    this.moveIn(restore, profiles);
    const farmer = [...this.runtimes.values()].find((r) => /farmer/i.test(r.profile.occupation));
    this.animals = createAnimalSim({
      config: cfg,
      map: this.map,
      now: startAt,
      ...(restore ? { restore: { animals: restore.animals, farm: restore.farm } } : {}),
      ...(farmer ? { farmerName: farmer.profile.name.split(' ')[0]! } : {}),
      findPath: (from, to) => this.paths.find(from, to),
      burgerStock: () => this.playerWorld.farm.stock()['burger_joint']?.['burger'] ?? 0,
    });
    const hasStation = this.map.locations.some((l) => l.kind === 'station');
    this.train = cfg.train.enabled && hasStation ? new Train(cfg.train, startAt, restore?.train) : null;
    this.rides = new Rides(this.map.locations, cfg.zoo, startAt);
    this.registerBuiltins();
    recordTownLog(this, this.townLog);
    this.townLog.anchor(true);
  }

  // ---------- SimEngine ----------

  get profiles(): readonly VillagerProfile[] {
    return [...this.runtimes.values()].map((r) => r.profile);
  }

  get player(): Readonly<PlayerState> {
    return this.playerWorld.state;
  }

  get speed(): number {
    return this.clock.speed;
  }

  /** True while the clock holds at 06:00 for the day plans. */
  get wakingUp(): boolean {
    return this.wakeHold !== null;
  }

  now(): GameMinutes {
    return this.clock.time;
  }

  snapshot(): WorldSnapshot {
    return {
      ...structuredClone({
        time: this.clock.time,
        speed: this.clock.speed,
        villagers: [...this.runtimes.values()].map((r) => r.state),
        events: this.eventList,
        notes: this.noteList,
        activeConversations: [...this.active.values()].map((a) => a.conversation),
        animals: [...this.animals.all()],
      }),
      rides: [...this.rides.all()],
      train: this.train?.state() ?? null,
      ...this.playerWorld.snapshot(),
    };
  }

  start(): void {
    if (this.interval) return;
    this.townLog.anchor(true);
    this.lastRealMs = performance.now();
    this.lastStatsMs = this.lastRealMs;
    this.interval = setInterval(() => this.realTick(), this.config.sim.tickMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.townLog.anchor(true);
  }

  setSpeed(speed: number): void {
    this.townLog.anchor(true);
    this.clock.speed = Math.max(0, speed);
    this.emitTick(true);
  }

  async advance(gameMinutes: number, opts: AdvanceOptions = {}): Promise<void> {
    const step = opts.step && opts.step > 0 ? opts.step : 1;
    let left = gameMinutes;
    while (left > 1e-9) {
      const dt = Math.min(step, left);
      if (this.holdForWakeUp(this.clock.time + dt)) {
        this.step(0);
        this.emitTick(false);
        const hold = this.wakeHold;
        if (hold && ++hold.rounds > WAKE_UP_MAX_ROUNDS) this.endWakeUp(hold.day, true);
        // Without drainLlm a hung provider must not block advance(); the hold then ends by rounds or timeout.
        if (opts.drainLlm) {
          await this.queue.drain();
          if (this.pending.size > 0) await Promise.race([Promise.allSettled([...this.pending]), settle()]);
        }
        await settle();
        continue;
      }
      left -= dt;
      this.step(dt);
      this.emitTick(false);
      if (opts.drainLlm) {
        await this.queue.drain();
        if (this.pending.size > 0) await Promise.race([Promise.allSettled([...this.pending]), settle()]);
      }
      await settle();
    }
  }

  handleCommand(cmd: ClientMessage): ServerMessage[] {
    try {
      const owned = this.playerWorld.handleCommand(cmd);
      if (owned) return owned;
    } catch (err) {
      log.error(`command ${cmd.type} failed`, err);
      return [this.error(`Command failed: ${(err as Error).message}`, cmd.requestId)];
    }
    const handler = this.handlers.get(cmd.type);
    if (!handler) return [this.error(`"${cmd.type}" is not available yet`, cmd.requestId)];
    try {
      return handler(cmd, this) ?? [];
    } catch (err) {
      log.error(`command ${cmd.type} failed`, err);
      return [this.error(`Command failed: ${(err as Error).message}`, cmd.requestId)];
    }
  }

  onMessage(listener: (msg: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  memories(villagerId: VillagerId): readonly Memory[] {
    return this.runtimes.get(villagerId)?.mind.serialize().memories ?? [];
  }

  conversations(): readonly Conversation[] {
    return [...this.history, ...[...this.active.values()].map((a) => a.conversation)].sort(
      (a, b) => a.startedAt - b.startedAt,
    );
  }

  toSaveData(): SaveData {
    const now = this.now();
    const runtimes = [...this.runtimes.values()];
    return structuredClone({
      schemaVersion: SAVE_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      time: now,
      rngState: this.rng.state,
      villagers: runtimes.map((r) => r.state),
      minds: runtimes.map((r) => r.mind.serialize()),
      events: this.eventList,
      notes: this.noteList,
      conversations: this.conversations().filter((c) => c.startedAt >= now - 2 * MINUTES_PER_DAY),
      ...this.playerWorld.serialize(),
      ...this.animals.serialize(),
      train: this.train?.state() ?? null,
      observer: this.townLog.serialize(),
    });
  }

  /** Save the slot now (save command, shutdown). */
  saveNow(): Promise<void> {
    const p = this.autosaver.saveNow();
    this.track(p);
    return p;
  }

  // ---------- SimHost ----------

  random(): number {
    return this.rng.next();
  }

  profile(id: VillagerId): VillagerProfile | undefined {
    return this.runtimes.get(id)?.profile;
  }

  villager(id: VillagerId): VillagerState | undefined {
    return this.runtimes.get(id)?.state;
  }

  mind(id: VillagerId): VillagerMind | undefined {
    return this.runtimes.get(id)?.mind;
  }

  villagerIds(): VillagerId[] {
    return [...this.runtimes.keys()];
  }

  view(id: VillagerId): WorldView | null {
    const rt = this.runtimes.get(id);
    return rt ? this.buildView(rt) : null;
  }

  observe(id: VillagerId, obs: Observation): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    try {
      rt.mind.observe(obs);
    } catch (err) {
      log.error(`observe failed for ${id}`, err);
    }
  }

  broadcast(msg: ServerMessage): void {
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch (err) {
        log.error('message listener failed', err);
      }
    }
  }

  toast(icon: string, text: string): void {
    this.broadcast({ type: 'toast', icon, text });
  }

  log(level: 'info' | 'warn' | 'error', text: string): void {
    this.broadcast({ type: 'log', level, text, time: this.now() });
  }

  adjustRelationship(a: VillagerId, b: VillagerId, delta: number, summary?: string, talked = true): void {
    const rt = this.runtimes.get(a);
    if (!rt) return;
    const rel = (rt.state.relationships[b] ??= { affinity: 0 });
    rel.affinity = clampAffinity(rel.affinity + delta);
    if (talked) rel.lastTalkedAt = this.now();
    if (summary !== undefined) rel.summary = summary;
  }

  events(): readonly VillageEvent[] {
    return this.eventList;
  }

  upsertEvent(event: VillageEvent): void {
    const i = this.eventList.findIndex((e) => e.id === event.id);
    if (i >= 0) this.eventList[i] = event;
    else {
      this.eventList.push(event);
      this.log(
        'info',
        `${this.nameOf(event.hostId)} planned "${event.title}" at ${formatClock(event.start)}`,
      );
    }
    this.broadcast({ type: 'event.updated', event: structuredClone(event) });
  }

  notes(): readonly DoorNote[] {
    return this.noteList;
  }

  upsertNote(note: DoorNote): void {
    const i = this.noteList.findIndex((n) => n.id === note.id);
    const prev = i >= 0 ? this.noteList[i] : undefined;
    if (i >= 0) this.noteList[i] = note;
    else this.noteList.push(note);
    this.broadcast({ type: 'note.updated', note: structuredClone(note) });
    // The Keep logs every note created, read or replied to (spec v2 §8.3), not every rewrite.
    if (!prev || prev.status !== note.status || prev.reply !== note.reply) {
      try {
        this.playerWorld.onNoteChanged(note);
      } catch (err) {
        log.error('onNoteChanged failed', err);
      }
    }
  }

  addVillager(profile: VillagerProfile, at?: Point): boolean {
    if (this.runtimes.size >= MAX_VILLAGERS || this.runtimes.has(profile.id)) return false;
    const spawn = at ?? nearestWalkable(this.map, { x: this.map.width - 1, y: 7 }, 6) ?? { x: 0, y: 0 };
    const state = this.initialState(profile);
    state.pos = { ...spawn };
    state.status = 'idle';
    state.activity = { text: 'arriving in town', emoji: '🧳', locationId: null, since: this.now() };
    this.addRuntime(profile, state);
    this.broadcast({ type: 'villagers.changed', added: [toPublicProfile(profile)], removed: [] });
    return true;
  }

  removeVillager(id: VillagerId): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    for (const a of [...this.active.values()]) {
      if (a.conversation.participants.includes(id)) this.endConversation(a, 'aborted');
    }
    this.runtimes.delete(id);
    this.lastFrames.delete(id);
    this.broadcast({ type: 'villagers.changed', added: [], removed: [id] });
  }

  startConversation(aId: VillagerId, bId: VillagerId, force = false): string | null {
    const a = this.runtimes.get(aId);
    const b = this.runtimes.get(bId);
    if (!a || !b || a === b) return null;
    for (const rt of [a, b]) {
      if (rt.state.status === 'sleeping' || rt.state.conversationId) return null;
      if (this.rides.isRiding(rt.profile.id)) return null;
    }
    if (!force && this.activeVillagerConversations() >= Math.max(1, this.config.llm.concurrency)) return null;
    const now = this.now();
    const conversation: Conversation = {
      id: `c${++this.seq}`,
      participants: [aId, bId],
      locationId: a.state.locationId ?? b.state.locationId,
      startedAt: now,
      messages: [],
      status: 'active',
    };
    const entry: ActiveConversation = { conversation, sent: 0, started: false, withPlayer: false };
    this.active.set(conversation.id, entry);
    for (const [rt, other] of [
      [a, b],
      [b, a],
    ] as const) {
      rt.state.conversationId = conversation.id;
      rt.state.status = 'talking';
      rt.state.activity = {
        text: `chatting with ${other.profile.name}`,
        emoji: '💬',
        locationId: rt.state.locationId,
        since: now,
      };
      rt.target = null;
      rt.arrived = false;
      this.rides.leave(rt.profile.id);
    }
    b.state.path = [];
    if (distance(a.state.pos, b.state.pos) > CONVERSATION_DISTANCE) {
      const near = this.tileNextTo(b.state.pos, a.state.pos);
      const path = near ? this.paths.find(a.state.pos, near) : null;
      if (path && path.length > 0) {
        a.state.path = path;
        a.approach = { conversationId: conversation.id, partnerId: bId };
      } else {
        a.state.path = [];
      }
    } else {
      a.state.path = [];
    }
    this.bus.emit('conversation.started', { conversation });
    if (!a.approach) this.runConversation(entry);
    return conversation.id;
  }

  registerCommand(type: ClientMessage['type'], handler: CommandHandler): void {
    this.handlers.set(type, handler);
  }

  track(p: Promise<unknown>): void {
    this.pending.add(p);
    const done = () => this.pending.delete(p);
    p.then(done, done);
  }

  setLlmOnline(online: boolean): void {
    this.queue.setOnline(online);
  }

  // ---------- setup ----------

  private initialState(p: VillagerProfile): VillagerState {
    const home = locationById(this.map.locations, p.homeId);
    const spot = this.pickSpot(home, p.id) ?? home?.entry ?? { x: 1, y: 1 };
    const awake = isAwakeAt(p, this.now());
    const relationships: VillagerState['relationships'] = {};
    for (const [other, affinity] of Object.entries(p.initialRelationships ?? {})) {
      relationships[other] = { affinity: clampAffinity(affinity) };
    }
    return {
      id: p.id,
      pos: { ...spot },
      facing: 'down',
      path: [],
      locationId: p.homeId,
      status: awake ? 'idle' : 'sleeping',
      activity: awake
        ? { text: 'starting the day', emoji: '☀️', locationId: p.homeId, since: this.now() }
        : { text: 'sleeping', emoji: '💤', locationId: p.homeId, since: this.now() },
      thought: '',
      needs: initialNeeds(),
      plan: null,
      relationships,
    };
  }

  private restoreState(saved: VillagerState): VillagerState {
    const s = structuredClone(saved);
    s.path = [];
    delete s.conversationId;
    if (s.status === 'talking' || s.status === 'walking') s.status = 'idle';
    return s;
  }

  private addRuntime(
    profile: VillagerProfile,
    state: VillagerState,
    snapshot?: SaveData['minds'][number],
  ): void {
    const rt: Runtime = {
      profile,
      state,
      mind: null as unknown as VillagerMind,
      target: null,
      arrived: false,
      lastConversationEnd: -Infinity,
      bubble: null,
      seen: new Map(),
      approach: null,
    };
    if (state.locationId === profile.homeId && state.path.length === 0) {
      const home = locationById(this.map.locations, profile.homeId);
      rt.target = {
        locationId: profile.homeId,
        spot: { ...state.pos },
        activity: state.activity.text,
        emoji: state.activity.emoji,
        sleep: state.status === 'sleeping',
      };
      rt.arrived = !!home;
    }
    this.runtimes.set(profile.id, rt);
    rt.mind = this.createMindFn(profile, {
      config: this.config,
      queue: this.queue,
      now: () => this.now(),
      emit: (m) => {
        if (m.type === 'log' && m.text.startsWith(LLM_USE_PREFIX)) log.info(m.text);
        this.broadcast(m);
      },
      world: this.mindWorld(profile.id),
      random: () => this.rng.next(),
      ...(snapshot ? { snapshot } : {}),
    });
  }

  private mindWorld(id: VillagerId): MindWorld {
    return {
      setPlan: (plan) => {
        const rt = this.runtimes.get(id);
        if (!rt) return;
        rt.state.plan = plan;
        this.bus.emit('plan.changed', { villagerId: id, plan });
      },
      setThought: (text) => {
        const rt = this.runtimes.get(id);
        if (rt) rt.state.thought = text;
      },
      adjustRelationship: (otherId, delta, summary) => this.adjustRelationship(id, otherId, delta, summary),
      upsertNote: (note) => {
        const prev = this.noteList.find((n) => n.id === note.id);
        this.upsertNote(note);
        if (prev?.status === 'unread' && note.status !== 'unread' && note.ownerId === id)
          this.noteRead(id, note);
      },
      upsertEvent: (event) => this.upsertEvent(event),
      events: () => this.eventList,
      notes: () => this.noteList,
      recordLearned: (fact) => {
        try {
          this.playerWorld.onLearned(fact);
        } catch (err) {
          log.error('onLearned failed', err);
        }
        this.bus.emit('learned', { fact });
      },
      sendLetter: (to, text, opts) => {
        try {
          return this.playerWorld.postLetter(id, to, text, opts);
        } catch (err) {
          log.error('postLetter failed', err);
          return null;
        }
      },
      observeFor: (villagerId, obs) => this.observe(villagerId, obs),
      taskCompleted: (taskId, block) => {
        try {
          this.playerWorld.onTaskCompleted(id, taskId, block);
        } catch (err) {
          log.error('onTaskCompleted failed', err);
        }
        this.bus.emit('task.completed', { villagerId: id, taskId, block });
      },
    };
  }

  private noteRead(ownerId: VillagerId, note: DoorNote): void {
    const mem = [...this.memories(ownerId)].reverse().find((m) => m.meta.noteId === note.id);
    const originId = mem ? (mem.meta.originId ?? mem.id) : `note_${note.id}`;
    try {
      this.playerWorld.onNoteRead(note, originId);
    } catch (err) {
      log.error('onNoteRead failed', err);
    }
  }

  private createPlayerHost(): PlayerHost {
    const queue = this.queue;
    return {
      map: this.map,
      now: () => this.now(),
      random: () => this.rng.next(),
      findPath: (from, to) => this.paths.find(from, to),
      villagers: () => [...this.runtimes.values()].map((r) => r.state),
      setPlan: (id, plan) => {
        const rt = this.runtimes.get(id);
        if (!rt) return;
        rt.state.plan = plan;
        this.bus.emit('plan.changed', { villagerId: id, plan });
      },
      profile: (id) => this.profile(id),
      addMemory: (id, obs) => this.observe(id, obs),
      adjustAffinity: (id, otherId, delta) => this.adjustRelationship(id, otherId, delta, undefined, false),
      emit: (msg) => this.broadcast(msg),
      requestPlayerReply: (req) => this.requestPlayerReply(req),
      startConversation: (a, b) => this.pairTalk(a, b),
      proposeTownEvent: () => this.proposeTownEvent(),
      villageEvents: () => this.eventList,
      addVillageEvent: (event) => this.upsertEvent(event),
      spawnVillager: (profile, at) => {
        if (!this.addVillager(profile, at))
          log.warn(`could not add ${profile.id}: village full or duplicate`);
      },
      removeVillager: (id) => this.removeVillager(id),
      requestGreeting: (id, visit) => this.requestGreeting(id, visit),
      letterRead: (id, letter) => {
        const rt = this.runtimes.get(id);
        if (!rt?.mind.onLetterRead) return;
        try {
          rt.mind.onLetterRead(this.buildView(rt), letter);
        } catch (err) {
          log.error(`onLetterRead failed for ${id}`, err);
        }
      },
      caw: (reason) => this.animals.caw(reason),
      llm: queue,
      loadLevel: () => loadTracker(queue).level(this.now()),
      joinRide: (rideId) =>
        this.rides.join(PLAYER_ID, rideId)
          ? { ok: true }
          : { ok: false, reason: 'That ride is closed right now' },
      triggerTrain: () => {
        if (!this.train) return { ok: false, reason: 'There is no train service' };
        if (this.train.state(this.now()).status !== 'away')
          return { ok: false, reason: 'The train is already here' };
        this.train.triggerNow(this.now());
        return { ok: true };
      },
    };
  }

  // ---------- loop ----------

  private realTick(): void {
    const nowMs = performance.now();
    const realMs = Math.min(1000, Math.max(0, nowMs - this.lastRealMs));
    this.lastRealMs = nowMs;
    let dt = this.clock.gameMinutesFor(realMs, this.everyoneAsleep());
    try {
      if (dt <= 0) this.step(0);
      while (dt > 1e-9) {
        const chunk = Math.min(1, dt);
        if (this.holdForWakeUp(this.clock.time + chunk)) {
          this.step(0);
          break;
        }
        dt -= chunk;
        this.step(chunk);
      }
    } catch (err) {
      log.error('sim step failed', err);
    }
    this.emitTick(false);
    this.ticksSinceStats++;
    if (nowMs - this.lastStatsMs >= STATS_INTERVAL_MS) {
      const tps = (this.ticksSinceStats * 1000) / (nowMs - this.lastStatsMs);
      this.lastStatsMs = nowMs;
      this.ticksSinceStats = 0;
      this.broadcast({
        type: 'stats',
        queue: this.queue.stats(),
        llmOnline: this.queue.isOnline() ?? true,
        simTicksPerSecond: Math.round(tps * 10) / 10,
      });
      // Repeated so clients that connect mid-hold see the overlay.
      if (this.wakeHold) this.broadcastSimStatus('wakingUp', this.wakeHold.ready);
    }
  }

  private planSettled(rt: Runtime, day: number): boolean {
    if (rt.mind.isPlanSettled) return rt.mind.isPlanSettled(day);
    // Minds without an LLM plan (stubs, tests) never keep the village waiting.
    if (!(rt.mind instanceof Mind)) return true;
    const plan = rt.state.plan;
    return !!plan && plan.day === day && plan.source === 'llm';
  }

  /** Every mind reports plan settlement itself, so an idle queue proves nothing (embeds, retries). */
  private plansSelfReported(): boolean {
    for (const rt of this.runtimes.values()) {
      if (!rt.profile.transient && !rt.mind.isPlanSettled) return false;
    }
    return true;
  }

  private wakeUpCounts(day: number): { ready: number; total: number } {
    const all = [...this.runtimes.values()].filter((rt) => !rt.profile.transient);
    return { ready: all.filter((rt) => this.planSettled(rt, day)).length, total: all.length };
  }

  /**
   * True while the clock must not move to `target`: the first time each day reaches 06:00, it waits
   * until every villager's plan for the day is settled, the LLM is offline, or the real-time cap expires.
   */
  private holdForWakeUp(target: GameMinutes): boolean {
    const day = dayOf(target);
    if (day <= this.wokeDay || minuteOfDay(target) < WAKE_UP_MINUTE) return false;
    const timeout = this.config.sim.wakeUpTimeoutSec;
    if (timeout <= 0 || this.queue.isOnline() === false) {
      this.endWakeUp(day, false);
      return false;
    }
    let { ready, total } = this.wakeUpCounts(day);
    if (ready >= total) {
      this.endWakeUp(day, false);
      return false;
    }
    const nowMs = performance.now();
    if (!this.wakeHold || this.wakeHold.day !== day) {
      this.wakeHold = { day, startedMs: nowMs, ready: -1, rounds: 0 };
      this.townLog.anchor(true);
      this.log('info', 'Villagers are waking up…');
      // Minds start their day plans from update(); on a fresh world nobody has thought yet.
      for (const rt of [...this.runtimes.values()]) this.think(rt);
      ({ ready, total } = this.wakeUpCounts(day));
      if (ready >= total) {
        this.endWakeUp(day, false);
        return false;
      }
    }
    const waited = nowMs - this.wakeHold.startedMs;
    if (waited >= timeout * 1000) {
      this.endWakeUp(day, true);
      return false;
    }
    // Minds that cannot report settlement: once nothing is in flight they keep their fallback plans.
    const idle = this.plansSelfReported() ? false : this.llmIdle();
    if (idle && (this.wakeHold.rounds > 0 || waited >= WAKE_UP_IDLE_GRACE_MS)) {
      this.endWakeUp(day, false);
      return false;
    }
    if (ready !== this.wakeHold.ready) {
      this.wakeHold.ready = ready;
      this.broadcastSimStatus('wakingUp', ready, total);
    }
    return true;
  }

  /**
   * Chat lane empty and the whole queue (embeddings included) reached idle since the previous call.
   * `drain()` is the only public view of the embeddings lane, so idleness is observed one tick late.
   */
  private llmIdle(): boolean {
    const probe = this.idleProbe;
    const reached = !!probe && probe.done;
    if (!probe || probe.done) {
      const next = { done: false };
      this.idleProbe = next;
      void this.queue.drain().then(() => {
        next.done = true;
      });
    }
    const q = this.queue.stats();
    return reached && q.queued === 0 && q.running === 0 && this.pending.size === 0;
  }

  private endWakeUp(day: number, timedOut: boolean): void {
    this.wokeDay = Math.max(this.wokeDay, day);
    if (!this.wakeHold) return;
    this.wakeHold = null;
    this.townLog.anchor(true);
    const { ready, total } = this.wakeUpCounts(day);
    if (timedOut) log.warn(`wake-up: only ${ready}/${total} plans ready, starting the day anyway`);
    this.broadcastSimStatus('running', ready, total);
  }

  private broadcastSimStatus(phase: SimStatusMsg['phase'], plansReady: number, villagers?: number): void {
    const msg: SimStatusMsg = {
      type: 'sim.status',
      phase,
      plansReady: Math.max(0, plansReady),
      villagers: villagers ?? [...this.runtimes.values()].filter((rt) => !rt.profile.transient).length,
    };
    this.broadcast(msg);
  }

  private everyoneAsleep(): boolean {
    let any = false;
    for (const rt of this.runtimes.values()) {
      if (rt.profile.transient) continue;
      any = true;
      if (rt.state.status !== 'sleeping') return false;
    }
    return any;
  }

  /** One simulation step of `dt` game minutes (0 = paused: only conversation output is flushed). */
  private step(dt: number): void {
    if (this.stepping) return;
    this.stepping = true;
    try {
      if (this.deferred.length > 0) for (const m of this.deferred.splice(0)) this.broadcast(m);
      if (dt > 0) {
        const prevDay = dayOf(this.clock.time);
        this.clock.time += dt;
        this.townLog.anchor();
        const day = dayOf(this.clock.time);
        if (day !== prevDay) this.onNewDay(day);
        this.updateNeedsAndBlocks(dt);
        // Before movement: a rider who arrives this step waits in the queue until the next one.
        this.stepRides();
        for (const rt of [...this.runtimes.values()]) this.think(rt);
        for (const rt of [...this.runtimes.values()]) this.moveVillager(rt, dt);
        this.stepAnimals();
        this.stepTrain();
        const minute = Math.floor(this.clock.time);
        if (minute > this.lastMinute) {
          this.lastMinute = minute;
          this.perceive();
          this.scheduleConversations();
        }
        this.updateEvents(dt);
      }
      try {
        this.playerWorld.update(dt);
      } catch (err) {
        log.error('player world update failed', err);
      }
      if (dt > 0) {
        this.bus.emit('step', { time: this.clock.time, dt });
        this.autosaver.tick(this.clock.time);
      }
      this.updateConversations();
    } finally {
      this.stepping = false;
    }
  }

  // ---------- v2 deterministic subsystems ----------

  private stepAnimals(): void {
    const now = this.clock.time;
    const occupants: Point[] = [...this.runtimes.values()].map((r) => r.state.pos);
    const player = this.player;
    if (!player.inside) occupants.push(player.pos);
    let change: AnimalStepResult;
    try {
      change = this.animals.step(now, occupants);
    } catch (err) {
      log.error('animal step failed', err);
      return;
    }
    const crowId = this.animals.crowId();
    const crow = crowId ? this.animals.all().find((a) => a.id === crowId) : undefined;
    const near = !!crow && !player.inside && distance(player.pos, crow.pos) <= CROW_CAW_RADIUS;
    if (near && !this.playerNearCrow) this.animals.caw('player');
    this.playerNearCrow = near;
    if (change.added.length > 0 || change.removed.length > 0 || change.updated.length > 0) {
      this.broadcast({
        type: 'animals.changed',
        added: change.added,
        removed: change.removed,
        updated: change.updated,
      });
    }
    for (const e of change.emotes)
      this.broadcast({ type: 'animal.emote', animalId: e.animalId, emote: e.emote });
    for (const t of change.toasts) {
      const [icon = '🐾', ...rest] = t.split(' ');
      this.toast(icon, rest.join(' '));
    }
    if (change.farmerNotes.length > 0) {
      const farmer = [...this.runtimes.values()].find((r) => /farmer/i.test(r.profile.occupation));
      for (const text of change.farmerNotes) {
        if (farmer) this.observe(farmer.profile.id, { at: now, kind: 'observation', text, importance: 4 });
      }
    }
    try {
      this.playerWorld.onAnimalChange(change);
    } catch (err) {
      log.error('onAnimalChange failed', err);
    }
    this.bus.emit('animals.step', { time: now, change });
  }

  private stepTrain(): void {
    if (!this.train) return;
    const now = this.clock.time;
    const changed = this.train.step(now);
    for (const event of this.train.takeEvents()) {
      try {
        if (event.kind === 'arrived') this.trainArrived(now);
        else if (event.kind === 'departing') this.trainDeparting(now);
      } catch (err) {
        log.error(`train ${event.kind} failed`, err);
      }
      this.bus.emit('train', event);
    }
    // setPassengers in the event handlers marks the train dirty; the second step picks that up.
    const passengers = this.train.step(now);
    if (changed || passengers) this.broadcast({ type: 'train.updated', train: this.train.state(now) });
  }

  private platformTiles(): Point[] {
    const rect =
      this.map.railway?.platform ?? this.map.locations.find((l) => l.kind === 'station')?.area ?? null;
    if (!rect) return [];
    const out: Point[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++)
      for (let x = rect.x; x < rect.x + rect.w; x++) if (isWalkable(this.map, x, y)) out.push({ x, y });
    return out;
  }

  private onPlatform(pos: Point): boolean {
    const rect = this.map.railway?.platform ?? this.map.locations.find((l) => l.kind === 'station')?.area;
    if (!rect) return false;
    const t = tileOf(pos);
    return t.x >= rect.x && t.x < rect.x + rect.w && t.y >= rect.y && t.y < rect.y + rect.h;
  }

  private trainArrived(now: GameMinutes): void {
    const profiles = this.playerWorld.onTrainArrived(now);
    const tiles = this.platformTiles();
    const added: VillagerId[] = [];
    profiles.forEach((p, i) => {
      const at =
        tiles.length > 0 ? tiles[Math.floor(((i + 0.5) * tiles.length) / profiles.length)]! : undefined;
      if (this.addVillager(p, at)) added.push(p.id);
      else log.warn(`could not add visitor ${p.id}: village full or duplicate`);
    });
    this.train!.setPassengers({ arriving: added });
  }

  private trainDeparting(now: GameMinutes): void {
    const onPlatform = [...this.runtimes.values()]
      .filter((r) => r.profile.visitor && this.onPlatform(r.state.pos))
      .map((r) => r.profile.id);
    const leaving = this.playerWorld.onTrainDeparting(now, onPlatform);
    for (const id of leaving) this.removeVillager(id);
    this.train!.setPassengers({ departing: leaving });
  }

  private stepRides(): void {
    for (const ride of this.rides.step(this.clock.time)) this.broadcast({ type: 'ride.updated', ride });
    for (const event of this.rides.takeEvents()) {
      const rt = this.runtimes.get(event.riderId);
      const loc = locationById(this.map.locations, event.rideId);
      if (rt && loc) {
        const name = loc.name.replace(/^the /i, '');
        if (event.kind === 'boarded') {
          this.setActivity(rt, `riding the ${name}`, RIDE_EMOJI[loc.id] ?? '🎡', 'acting');
        } else {
          if (event.kind === 'finished') {
            const gain = this.rides.spec(loc.id)?.funGain ?? 0;
            rt.state.needs.fun = Math.min(100, rt.state.needs.fun + gain);
            // One cycle per visit: the rider steps off and spends the rest of the block nearby.
            const to = this.afterRidePlace(loc);
            if (to) {
              rt.doneRide = { rideId: loc.id, to: to.id };
              this.goTo(rt, to.id, AFTER_RIDE_ACTIVITY, '😄', false);
              continue;
            }
          }
          rt.rodeAt = loc.id;
          this.setActivity(rt, RIDE_FALLBACK_ACTIVITY, '👀', 'acting');
        }
      }
      this.bus.emit('ride', event);
    }
  }

  private afterRidePlace(ride: Location): Location | null {
    let best: Location | null = null;
    let bestD = Infinity;
    for (const l of this.map.locations) {
      if (l.kind !== 'public' && l.kind !== 'food' && l.kind !== 'nature') continue;
      // Zoo food stands sit next to the rides; a public place across town is a last resort.
      const d =
        Math.abs(l.entry.x - ride.entry.x) +
        Math.abs(l.entry.y - ride.entry.y) +
        (l.kind === 'food' ? 0 : 40);
      if (d < bestD) {
        best = l;
        bestD = d;
      }
    }
    return best;
  }

  private animalsNear(pos: Point): { id: string; species: AnimalSpecies; distance: number }[] {
    const out: { id: string; species: AnimalSpecies; distance: number }[] = [];
    for (const a of this.animals.all()) {
      const d = distance(pos, a.pos);
      if (d <= ANIMALS_NEARBY_RADIUS) out.push({ id: a.id, species: a.species, distance: d });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  /** Eating at the burger joint or an ice cream truck (spec v2 §3.4); never waits for stock. */
  private eatAt(rt: Runtime, loc: Location): void {
    const needs = rt.state.needs;
    if (loc.id.startsWith('ice_cream_truck')) {
      this.playerWorld.consumeFood(loc.id, 'ice_cream');
      needs.hunger = Math.min(100, needs.hunger + 10);
      needs.fun = Math.min(100, needs.fun + 10);
      this.bus.emit('food.eaten', { villagerId: rt.profile.id, venueId: loc.id, itemId: 'ice_cream' });
    } else if (loc.id === 'burger_joint') {
      const fromStock = this.playerWorld.consumeFood(loc.id, 'burger');
      needs.hunger = Math.min(100, needs.hunger + 50);
      this.bus.emit('food.eaten', {
        villagerId: rt.profile.id,
        venueId: loc.id,
        itemId: fromStock ? 'burger' : 'veggie_burger',
      });
    }
  }

  /** Residents in the profile list but not in the save (Laude and Franzi for a v1 save) move in at home. */
  private moveIn(restore: SaveData | null, profiles: readonly VillagerProfile[]): void {
    if (!restore) return;
    const names = profiles
      .filter((p) => !p.transient && this.runtimes.has(p.id) && !restore.villagers.some((v) => v.id === p.id))
      .map((p) => p.name.split(' ')[0]!);
    if (names.length === 0) return;
    const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    const where = this.map.locations.some((l) => l.id === 'bakery') ? ' near the bakery' : '';
    // Sent on the first step: nobody listens while the engine is being built.
    this.deferred.push({ type: 'toast', icon: '🏡', text: `${who} moved in${where}!` });
    this.deferred.push({ type: 'log', level: 'info', text: `${who} moved in${where}.`, time: this.now() });
  }

  private onNewDay(day: number): void {
    this.bus.emit('day.start', { day, time: this.clock.time });
  }

  private updateNeedsAndBlocks(dt: number): void {
    const now = this.clock.time;
    for (const rt of this.runtimes.values()) {
      const s = rt.state;
      if (this.config.needs.enabled) {
        const loc = s.locationId ? locationById(this.map.locations, s.locationId) : null;
        updateNeeds(
          s.needs,
          { status: s.status, activity: s.activity.text, location: loc },
          dt,
          this.config.needs.decayPerHour,
        );
      }
      const plan = s.plan;
      if (!plan) continue;
      const today = dayOf(now);
      const m = minuteOfDay(now);
      for (const block of plan.blocks) {
        if (block.done) continue;
        if (plan.day < today || (plan.day === today && block.end <= m)) {
          block.done = true;
          this.bus.emit('block.done', { villagerId: s.id, block });
        }
      }
    }
  }

  private think(rt: Runtime): void {
    if (rt.state.status === 'talking' || rt.state.conversationId) return;
    let intent: Intent;
    try {
      intent = rt.mind.update(this.buildView(rt));
    } catch (err) {
      log.error(`mind.update failed for ${rt.profile.id}`, err);
      intent = { type: 'wait' };
    }
    this.applyIntent(rt, intent);
  }

  private applyIntent(rt: Runtime, intent: Intent): void {
    const s = rt.state;
    if (rt.doneRide) {
      const done = rt.doneRide;
      const atRide = intent.type === 'act' && s.locationId === done.rideId;
      if ((intent.type === 'goto' && intent.locationId === done.rideId) || atRide) {
        this.goTo(rt, done.to, AFTER_RIDE_ACTIVITY, '😄', false);
        return;
      }
      if (
        intent.type !== 'wait' &&
        intent.type !== 'talk' &&
        !(intent.type === 'act' && s.locationId === done.to)
      )
        rt.doneRide = null;
      else if (intent.type === 'act') return;
    }
    switch (intent.type) {
      case 'goto':
        this.goTo(rt, intent.locationId, intent.activity, intent.emoji ?? '🚶', false);
        break;
      case 'sleep':
        this.goTo(rt, rt.profile.homeId, 'sleeping', '💤', true);
        break;
      case 'act': {
        s.path = [];
        rt.target = {
          locationId: s.locationId,
          spot: tileOf(s.pos),
          activity: intent.activity,
          emoji: intent.emoji ?? '✨',
          sleep: false,
        };
        rt.arrived = true;
        const loc = s.locationId ? locationById(this.map.locations, s.locationId) : null;
        if (loc?.kind === 'ride') {
          // Queue, ride and "watching the rides" own the activity while the villager stays here.
          if (!this.rides.rideOf(rt.profile.id) && rt.rodeAt !== loc.id) this.enterRide(rt, loc);
          break;
        }
        this.setActivity(rt, intent.activity, intent.emoji ?? '✨', 'acting');
        break;
      }
      case 'talk':
        if (!this.isBusy(rt)) {
          const other = this.runtimes.get(intent.targetId);
          if (other && !this.isBusy(other)) this.startConversation(rt.profile.id, intent.targetId);
        }
        break;
      case 'wait':
        if (s.path.length === 0 && s.status === 'walking') s.status = 'idle';
        break;
    }
  }

  private goTo(rt: Runtime, locationId: string, activity: string, emoji: string, sleep: boolean): void {
    const s = rt.state;
    const loc =
      locationById(this.map.locations, locationId) ?? locationById(this.map.locations, rt.profile.homeId);
    if (!loc) return;
    if (rt.target && rt.target.locationId === loc.id) {
      rt.target.activity = activity;
      rt.target.emoji = emoji;
      rt.target.sleep = sleep;
      const atRide = loc.kind === 'ride' && (this.rides.rideOf(rt.profile.id) || rt.rodeAt === loc.id);
      if (rt.arrived && !atRide) this.setActivity(rt, activity, emoji, this.arrivedStatus(rt, loc));
      return;
    }
    this.rides.leave(rt.profile.id);
    rt.rodeAt = null;
    const spot = this.pickSpot(loc, rt.profile.id) ?? loc.entry;
    let path = this.paths.find(s.pos, spot);
    if (!path && (spot.x !== loc.entry.x || spot.y !== loc.entry.y)) path = this.paths.find(s.pos, loc.entry);
    if (!path) {
      // Unreachable (e.g. spawned inside a wall): hop there so the villager never gets stuck.
      log.debug(`${rt.profile.id}: no path to ${loc.id}, teleporting`);
      s.pos = { ...spot };
      path = [];
    }
    rt.target = { locationId: loc.id, spot, activity, emoji, sleep };
    rt.arrived = false;
    s.path = path;
    if (path.length === 0) this.arrive(rt);
    else this.setActivity(rt, `walking to the ${loc.name.replace(/^the /i, '')}`, '🚶', 'walking');
  }

  private arrivedStatus(rt: Runtime, loc: Location | null): VillagerState['status'] {
    if (rt.target?.sleep) return 'sleeping';
    if (
      loc &&
      this.eventList.some(
        (e) =>
          e.status === 'happening' &&
          e.locationId === loc.id &&
          (e.hostId === rt.profile.id || e.accepted.includes(rt.profile.id)),
      )
    )
      return 'attending';
    return 'acting';
  }

  /** Join the ride's queue, or watch when it is closed or full of waiting riders. */
  private enterRide(rt: Runtime, loc: Location): void {
    if (this.rides.join(rt.profile.id, loc.id)) {
      this.setActivity(rt, `waiting for the ${loc.name.replace(/^the /i, '')}`, '⏳', 'idle');
    } else {
      rt.rodeAt = loc.id;
      this.setActivity(rt, RIDE_FALLBACK_ACTIVITY, '👀', 'acting');
    }
  }

  private arrive(rt: Runtime): void {
    const t = rt.target;
    if (!t) return;
    rt.arrived = true;
    const loc = t.locationId ? locationById(this.map.locations, t.locationId) : null;
    rt.state.locationId = t.locationId;
    if (loc?.kind === 'ride' && !t.sleep) {
      this.enterRide(rt, loc);
    } else {
      this.setActivity(rt, t.activity, t.emoji, this.arrivedStatus(rt, loc));
      if (loc?.kind === 'food' && !t.sleep) this.eatAt(rt, loc);
    }
    if (t.locationId && !t.sleep) {
      try {
        rt.mind.onArrive(this.buildView(rt), t.locationId);
      } catch (err) {
        log.error(`onArrive failed for ${rt.profile.id}`, err);
      }
      this.bus.emit('villager.arrived', { villagerId: rt.profile.id, locationId: t.locationId });
    } else if (t.locationId && t.sleep) {
      this.bus.emit('villager.arrived', { villagerId: rt.profile.id, locationId: t.locationId });
    }
  }

  private setActivity(rt: Runtime, text: string, emoji: string, status: VillagerState['status']): void {
    const s = rt.state;
    s.status = status;
    if (s.activity.text !== text || s.activity.emoji !== emoji) {
      s.activity = { text, emoji, locationId: s.locationId, since: this.now() };
      if (!rt.bubble) s.thought = text;
    }
  }

  private moveVillager(rt: Runtime, dt: number): void {
    const s = rt.state;
    if (s.path.length === 0) return;
    const done = advanceAlongPath(s, WALK_TILES_PER_GAME_MINUTE * dt);
    const here = locationAt(this.map.locations, s.pos);
    s.locationId = here?.id ?? null;
    if (!done) return;
    if (rt.approach) {
      const entry = this.active.get(rt.approach.conversationId);
      const partner = this.runtimes.get(rt.approach.partnerId);
      rt.approach = null;
      if (entry && partner) {
        s.facing = facingFor(partner.state.pos.x - s.pos.x, partner.state.pos.y - s.pos.y, s.facing);
        partner.state.facing = facingFor(
          s.pos.x - partner.state.pos.x,
          s.pos.y - partner.state.pos.y,
          partner.state.facing,
        );
        this.runConversation(entry);
      }
      return;
    }
    if (rt.target && !rt.arrived) this.arrive(rt);
  }

  private isBusy(rt: Runtime): boolean {
    return (
      rt.state.status === 'sleeping' ||
      rt.state.status === 'talking' ||
      !!rt.state.conversationId ||
      this.rides.isRiding(rt.profile.id)
    );
  }

  private pickSpot(loc: Location | null, villagerId: VillagerId): Point | null {
    if (!loc) return null;
    const spots = loc.spots && loc.spots.length > 0 ? loc.spots : [loc.entry];
    const taken = new Set<string>();
    for (const rt of this.runtimes.values()) {
      if (rt.profile.id === villagerId || !rt.target || rt.target.locationId !== loc.id) continue;
      taken.add(`${rt.target.spot.x},${rt.target.spot.y}`);
    }
    const free = spots.filter((p) => !taken.has(`${p.x},${p.y}`));
    const pool = free.length > 0 ? free : spots;
    const choice = pool.length === 1 ? pool[0] : this.rng.pick(pool);
    return choice ? { ...choice } : null;
  }

  private tileNextTo(target: Point, from: Point): Point | null {
    const t = tileOf(target);
    const candidates = [
      { x: t.x + 1, y: t.y },
      { x: t.x - 1, y: t.y },
      { x: t.x, y: t.y + 1 },
      { x: t.x, y: t.y - 1 },
    ].filter(
      (p) =>
        this.map.collision[p.y * this.map.width + p.x] === 0 &&
        p.x >= 0 &&
        p.y >= 0 &&
        p.x < this.map.width &&
        p.y < this.map.height,
    );
    candidates.sort((a, b) => distance(a, from) - distance(b, from));
    return candidates[0] ?? null;
  }

  // ---------- perception ----------

  private perceive(): void {
    const now = this.now();
    const all = [...this.runtimes.values()];
    const player = this.player;
    for (const rt of all) {
      if (rt.state.status === 'sleeping') continue;
      const where = rt.state.locationId ? locationById(this.map.locations, rt.state.locationId) : null;
      const place = where ? ` at the ${where.name.replace(/^the /i, '')}` : '';
      for (const other of all) {
        if (other === rt || other.state.status === 'sleeping' || other.state.status === 'walking') continue;
        if (distance(rt.state.pos, other.state.pos) > PERCEPTION_RADIUS) continue;
        this.maybeObserve(
          rt,
          other.profile.id,
          other.state.activity.text,
          `${other.profile.name} is ${other.state.activity.text}${place}`,
          2,
          OBSERVATION_COOLDOWN_MINUTES,
          now,
        );
      }
      if (distance(rt.state.pos, player.pos) <= PERCEPTION_RADIUS) {
        const act = player.path.length > 0 ? 'walking by' : 'hanging around';
        this.maybeObserve(rt, PLAYER_ID, act, `${player.name} is ${act}${place}`, 2, 60, now);
      }
      const pet = player.pet;
      if (distance(rt.state.pos, pet.pos) <= PERCEPTION_RADIUS) {
        const act = pet.mode === 'stay' ? 'sitting quietly' : 'playing';
        this.maybeObserve(
          rt,
          'pet',
          act,
          `${pet.name} the ${pet.species} is ${act} nearby${place}`,
          3,
          120,
          now,
        );
      }
    }
  }

  private maybeObserve(
    rt: Runtime,
    subject: string,
    activity: string,
    text: string,
    importance: number,
    cooldown: number,
    now: GameMinutes,
  ): void {
    const last = rt.seen.get(subject);
    if (last && (last.activity === activity || now - last.at < cooldown)) return;
    rt.seen.set(subject, { activity, at: now });
    this.observe(rt.profile.id, { at: now, kind: 'observation', text, importance });
  }

  // ---------- conversations ----------

  private activeVillagerConversations(): number {
    let n = 0;
    for (const a of this.active.values()) if (!a.withPlayer) n++;
    return n;
  }

  private scheduleConversations(): void {
    const cap = Math.max(1, this.config.llm.concurrency);
    if (this.activeVillagerConversations() >= cap) return;
    const now = this.now();
    const free = [...this.runtimes.values()].filter(
      (rt) =>
        !this.isBusy(rt) &&
        rt.state.status !== 'walking' &&
        now - rt.lastConversationEnd >= VILLAGER_CONVERSATION_COOLDOWN,
    );
    this.rng.shuffle(free);
    const used = new Set<Runtime>();
    for (const a of free) {
      if (used.has(a)) continue;
      for (const b of free) {
        if (a === b || used.has(b)) continue;
        const loc = a.state.locationId ? locationById(this.map.locations, a.state.locationId) : null;
        const sameSmall =
          !!loc && a.state.locationId === b.state.locationId && (loc.kind === 'shop' || loc.kind === 'house');
        if (!sameSmall && distance(a.state.pos, b.state.pos) > CHAT_RADIUS) continue;
        const lastTalked = a.state.relationships[b.profile.id]?.lastTalkedAt;
        if (lastTalked !== undefined && now - lastTalked < this.config.cognition.pairCooldownMinutes)
          continue;
        let willing = false;
        try {
          willing =
            a.mind.wantsToTalkTo(this.buildView(a), b.profile.id) &&
            b.mind.wantsToTalkTo(this.buildView(b), a.profile.id);
        } catch (err) {
          log.error('wantsToTalkTo failed', err);
        }
        // Mark the pair as "considered" so a refusal does not get re-rolled every minute.
        this.touchPair(a, b, now);
        if (!willing) continue;
        if (this.startConversation(a.profile.id, b.profile.id)) {
          used.add(a);
          used.add(b);
          if (this.activeVillagerConversations() >= cap) return;
          break;
        }
      }
    }
  }

  /** Records a declined chat as a half cooldown so the same pair is retried later, not every minute. */
  private touchPair(a: Runtime, b: Runtime, now: GameMinutes): void {
    const half = now - this.config.cognition.pairCooldownMinutes / 2;
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const rel = (x.state.relationships[y.profile.id] ??= { affinity: 0 });
      if (rel.lastTalkedAt === undefined || rel.lastTalkedAt < half) rel.lastTalkedAt = half;
    }
  }

  private runConversation(entry: ActiveConversation): void {
    if (entry.started) return;
    entry.started = true;
    const [aId, bId] = entry.conversation.participants;
    const a = this.runtimes.get(aId);
    const b = this.runtimes.get(bId);
    if (!a || !b) {
      this.endConversation(entry, 'aborted');
      return;
    }
    this.log('info', `${a.profile.name} started chatting with ${b.profile.name}`);
    const p = this.runner.run(entry.conversation, [a.mind, b.mind]).then(
      () => this.endConversation(entry, 'ended'),
      (err: unknown) => {
        log.warn(`conversation ${entry.conversation.id} failed: ${(err as Error).message}`);
        this.endConversation(entry, 'aborted');
      },
    );
    this.track(p);
  }

  private updateConversations(): void {
    const now = this.now();
    for (const entry of [...this.active.values()]) {
      this.flushMessages(entry);
      const limit = entry.withPlayer ? PLAYER_CHAT_TIMEOUT_MINUTES : MAX_CONVERSATION_GAME_MINUTES;
      if (now - entry.conversation.startedAt > limit) this.endConversation(entry, 'aborted');
      else if (entry.withPlayer && !entry.pendingReplies && now >= (entry.holdUntil ?? 0)) {
        this.endConversation(entry, 'ended');
      }
    }
  }

  private flushMessages(entry: ActiveConversation): void {
    const c = entry.conversation;
    while (entry.sent < c.messages.length) {
      const m = c.messages[entry.sent++]!;
      const listenerId = c.participants[0] === m.speakerId ? c.participants[1] : c.participants[0];
      const source = m.source;
      this.broadcast({
        type: 'conversation.message',
        conversationId: entry.publicId ?? c.id,
        speakerId: m.speakerId,
        listenerId,
        text: m.text,
        time: m.at,
        ...(source ? { source } : {}),
      });
      const speaker = this.runtimes.get(m.speakerId);
      if (speaker) {
        speaker.bubble = { text: m.text, untilMs: Date.now() + BUBBLE_MS, untilGame: this.now() + 10 };
        speaker.state.thought = m.text;
      }
    }
  }

  private endConversation(entry: ActiveConversation, status: 'ended' | 'aborted'): void {
    const c = entry.conversation;
    if (!this.active.has(c.id)) return;
    this.flushMessages(entry);
    this.active.delete(c.id);
    c.status = status;
    c.endedAt = this.now();
    this.history.push(c);
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    const now = this.now();
    for (const id of c.participants) {
      const rt = this.runtimes.get(id);
      if (!rt) continue;
      if (rt.state.conversationId === c.id) delete rt.state.conversationId;
      if (rt.approach?.conversationId === c.id) {
        rt.approach = null;
        rt.state.path = [];
      }
      rt.lastConversationEnd = now;
      rt.state.status = 'idle';
      rt.target = null;
      rt.arrived = false;
      if (c.messages.length > 0 && this.config.needs.enabled) {
        rt.state.needs.social = Math.min(100, rt.state.needs.social + CONVERSATION_SOCIAL_BONUS);
      }
      const other = c.participants[0] === id ? c.participants[1] : c.participants[0];
      const rel = (rt.state.relationships[other] ??= { affinity: 0 });
      rel.lastTalkedAt = now;
    }
    this.broadcast({
      type: 'conversation.ended',
      conversationId: entry.publicId ?? c.id,
      participants: [...c.participants] as [VillagerId, VillagerId],
    });
    this.bus.emit('conversation.ended', { conversation: c });
  }

  // ---------- events ----------

  private updateEvents(dt: number): void {
    const now = this.now();
    for (const e of this.eventList) {
      if ((e.status === 'scheduled' || e.status === 'proposed') && now >= e.start && now < e.end) {
        e.status = 'happening';
        this.eventPresence.set(e.id, new Map());
        this.broadcast({ type: 'event.updated', event: structuredClone(e) });
        this.log('info', `"${e.title}" is starting`);
        this.bus.emit('event.started', { event: e });
      }
      if (e.status === 'proposed' && now >= e.end) {
        e.status = 'cancelled';
        this.broadcast({ type: 'event.updated', event: structuredClone(e) });
      }
      if (e.status !== 'happening') continue;
      const loc = locationById(this.map.locations, e.locationId);
      let presence = this.eventPresence.get(e.id);
      if (!presence) {
        presence = new Map();
        this.eventPresence.set(e.id, presence);
      }
      if (loc) {
        for (const rt of this.runtimes.values()) {
          if (rt.state.status === 'sleeping') continue;
          if (isAt(loc, rt.state.pos)) presence.set(rt.profile.id, (presence.get(rt.profile.id) ?? 0) + dt);
        }
        if (isAt(loc, this.player.pos)) presence.set(PLAYER_ID, (presence.get(PLAYER_ID) ?? 0) + dt);
      }
      if (now >= e.end) this.finishEvent(e, presence);
    }
  }

  private finishEvent(e: VillageEvent, presence: Map<string, number>): void {
    const need = (e.end - e.start) * 0.5;
    const attendees = [...presence.entries()]
      .filter(([id, mins]) => id !== PLAYER_ID && mins >= need - 1e-6)
      .map(([id]) => id);
    const playerAttended = (presence.get(PLAYER_ID) ?? 0) >= need - 1e-6;
    e.attendees = attendees;
    e.status = 'done';
    this.eventPresence.delete(e.id);
    const names = attendees.map((id) => this.nameOf(id));
    const who = [...names, ...(playerAttended ? [this.player.name] : [])];
    for (const id of attendees) {
      const others = who.filter((n) => n !== this.nameOf(id));
      this.observe(id, {
        at: this.now(),
        kind: 'event',
        text: `I went to "${e.title}" hosted by ${this.nameOf(e.hostId)}${others.length ? ` with ${others.join(', ')}` : ''}.`,
        importance: 6,
        meta: { eventId: e.id },
      });
    }
    this.broadcast({ type: 'event.updated', event: structuredClone(e) });
    this.log(
      'info',
      `"${e.title}" ended with ${attendees.length} attendee${attendees.length === 1 ? '' : 's'}`,
    );
    this.bus.emit('event.done', { event: e, playerAttended });
  }

  // ---------- views & frames ----------

  private nameOf(id: VillagerId): string {
    if (id === PLAYER_ID) return this.player.name;
    return this.runtimes.get(id)?.profile.name ?? id;
  }

  private buildView(rt: Runtime): WorldView {
    const now = this.now();
    const nearby: NearbyVillager[] = [];
    for (const other of this.runtimes.values()) {
      if (other === rt) continue;
      const d = distance(rt.state.pos, other.state.pos);
      if (d > NEARBY_RADIUS) continue;
      nearby.push({
        id: other.profile.id,
        name: other.profile.name,
        activity: other.state.activity.text,
        distance: d,
        status: other.state.status,
      });
    }
    const player = this.player;
    const dp = distance(rt.state.pos, player.pos);
    if (dp <= NEARBY_RADIUS) {
      nearby.push({
        id: PLAYER_ID,
        name: player.name,
        activity: player.path.length > 0 ? 'walking' : 'standing around',
        distance: dp,
        status: player.path.length > 0 ? 'walking' : 'idle',
      });
    }
    nearby.sort((a, b) => a.distance - b.distance);
    const names: Record<VillagerId, string> = { [PLAYER_ID]: this.player.name };
    for (const o of this.runtimes.values()) names[o.profile.id] = o.profile.name;
    const location = rt.state.locationId ? locationById(this.map.locations, rt.state.locationId) : null;
    return {
      now,
      self: rt.state,
      profile: rt.profile,
      nearby,
      location,
      locations: this.map.locations,
      notesAtHome: this.noteList.filter((n) => n.houseId === rt.profile.homeId),
      events: this.eventList.filter((e) => e.status !== 'cancelled' && e.end >= now - MINUTES_PER_DAY),
      villagerNames: names,
      weather: { ...this.playerWorld.weather },
      animalsNearby: this.animalsNear(rt.state.pos),
      noticesInReach: this.noticesInReach(rt),
      lettersAtHome: this.playerWorld.post
        .letters()
        .filter((l) => l.to === rt.profile.id && l.status === 'delivered'),
      ...(rt.profile.id === LAUDE_ID
        ? { searchKeep: (query: string, k: number) => this.playerWorld.post.keep.search(query, k) }
        : {}),
      ...(rt.profile.visitor ? visitorField(this.playerWorld.visitors.info(rt.profile.id)) : {}),
    };
  }

  /** Villagers read the board within 3 tiles of it, or when their plan block is at the board or the post office. */
  private noticesInReach(rt: Runtime): readonly Notice[] {
    const notices = this.playerWorld.post.notices();
    if (notices.length === 0) return [];
    const board = locationById(this.map.locations, NOTICE_BOARD_ID);
    const near = !!board && distanceToArea(board, rt.state.pos) <= NOTICE_READ_RADIUS;
    const blockLoc = currentBlock(rt.state.plan, this.now())?.locationId;
    const planned =
      blockLoc === NOTICE_BOARD_ID || (blockLoc === POST_OFFICE_ID && rt.state.locationId === POST_OFFICE_ID);
    return near || planned ? notices : [];
  }

  private frameOf(rt: Runtime): VillagerFrame {
    const s = rt.state;
    const f: VillagerFrame = {
      id: s.id,
      x: Math.round(s.pos.x * 100) / 100,
      y: Math.round(s.pos.y * 100) / 100,
      facing: s.facing,
      status: s.status,
      activity: s.activity.text,
      emoji: s.activity.emoji,
    };
    if (rt.bubble) {
      if (Date.now() < rt.bubble.untilMs || this.now() < rt.bubble.untilGame) f.bubble = rt.bubble.text;
      else rt.bubble = null;
    }
    return f;
  }

  private emitTick(full: boolean): void {
    this.tickCount++;
    const forceAll = full || this.tickCount % FULL_FRAME_EVERY_TICKS === 1;
    const frames: VillagerFrame[] = [];
    for (const rt of this.runtimes.values()) {
      const f = this.frameOf(rt);
      const key = JSON.stringify(f);
      if (forceAll || this.lastFrames.get(f.id) !== key) frames.push(f);
      this.lastFrames.set(f.id, key);
    }
    const animals = this.animals.frames();
    this.broadcast({
      type: 'tick',
      time: this.clock.time,
      speed: this.clock.speed,
      villagers: frames,
      ...(animals.length > 0 ? { animals } : {}),
    });
  }

  /** All frames (used by tests and new clients). */
  frames(): VillagerFrame[] {
    return [...this.runtimes.values()].map((rt) => this.frameOf(rt));
  }

  private error(message: string, requestId?: string): ServerMessage {
    return requestId ? { type: 'error', message, requestId } : { type: 'error', message };
  }

  // ---------- built-in commands ----------

  private registerBuiltins(): void {
    this.registerCommand('speed', (cmd) => {
      if (cmd.type !== 'speed') return;
      this.setSpeed(cmd.speed);
    });

    this.registerCommand('inspect', (cmd) => {
      if (cmd.type !== 'inspect' || cmd.villagerId === null) return [];
      return this.inspect(cmd.villagerId, cmd.requestId);
    });

    this.registerCommand('note.post', (cmd) => {
      if (cmd.type !== 'note.post') return;
      const text = cmd.text.trim();
      const house = locationById(this.map.locations, cmd.houseId);
      if (!house || house.kind !== 'house' || !house.door)
        return [this.error('That is not a house door.', cmd.requestId)];
      const owners = (house.ownerIds ?? []).filter((id) => id !== PLAYER_ID);
      const ownerId = owners.find((id) => this.runtimes.has(id));
      if (!ownerId) return [this.error('Nobody lives there.', cmd.requestId)];
      if (!text) return [this.error('The note is empty.', cmd.requestId)];
      if (text.length > NOTE_MAX_LENGTH)
        return [this.error(`Notes are limited to ${NOTE_MAX_LENGTH} characters.`, cmd.requestId)];
      const note: DoorNote = {
        id: `n${++this.seq}`,
        houseId: house.id,
        ownerId,
        authorId: PLAYER_ID,
        text,
        postedAt: this.now(),
        status: 'unread',
      };
      this.upsertNote(note);
      this.log('info', `You pinned a note on ${this.nameOf(ownerId)}'s door`);
      this.bus.emit('note.posted', { note });
      return [];
    });

    this.registerCommand('save', () => {
      this.saveNow().then(
        () => this.toast('💾', 'Game saved'),
        (err: unknown) => this.log('warn', `Saving failed: ${(err as Error).message}`),
      );
      return [];
    });

    this.registerCommand('debug.inject', (cmd) => {
      if (cmd.type !== 'debug.inject') return;
      if (!this.config.debug) return [this.error('Debug commands are disabled.', cmd.requestId)];
      if (!this.runtimes.has(cmd.villagerId)) return [this.error('Unknown villager.', cmd.requestId)];
      const text = cmd.text.trim();
      if (!text) return [this.error('Nothing to inject.', cmd.requestId)];
      const originId = `fact_${Math.floor(this.now())}_${++this.seq}`;
      this.observe(cmd.villagerId, {
        at: this.now(),
        kind: 'heard',
        text,
        importance: cmd.importance ?? 7,
        meta: { originId },
      });
      try {
        this.playerWorld.onDebugInject(cmd.villagerId, text, originId);
      } catch (err) {
        log.error('onDebugInject failed', err);
      }
      this.log('info', `debug: injected a memory into ${this.nameOf(cmd.villagerId)}`);
      return [];
    });
    this.registerCommand('debug.jump', (cmd) => {
      if (cmd.type !== 'debug.jump') return;
      if (!this.config.debug) return [this.error('Debug commands are disabled.', cmd.requestId)];
      const target = Math.min(cmd.toTime, this.now() + 3 * MINUTES_PER_DAY);
      while (this.now() < target - 1e-9) this.step(Math.min(1, target - this.now()));
      this.emitTick(true);
      return [];
    });
  }

  private inspect(villagerId: VillagerId, requestId?: string): ServerMessage[] {
    const rt = this.runtimes.get(villagerId);
    if (!rt) return [this.error('Unknown villager.', requestId)];
    const memories = [...rt.mind.serialize().memories]
      .filter((m) => !m.meta.archived)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10)
      .map(({ embedding: _embedding, ...m }) => m);
    const conv = rt.state.conversationId ? this.active.get(rt.state.conversationId)?.conversation : undefined;
    const msg: ServerMessage = {
      type: 'inspect.data',
      villagerId,
      state: structuredClone(rt.state),
      plan: structuredClone(rt.state.plan),
      memories: structuredClone(memories),
      relationships: structuredClone(rt.state.relationships),
      ...(conv ? { currentConversation: structuredClone(conv) } : {}),
    };
    return [msg];
  }

  /** "Have them talk" (player.pairTalk via WP8). */
  private pairTalk(aId: VillagerId, bId: VillagerId): CommandResult {
    const a = this.runtimes.get(aId);
    const b = this.runtimes.get(bId);
    if (!a || !b || a === b) return { ok: false, reason: 'Pick two different villagers' };
    for (const rt of [a, b]) {
      if (rt.state.status === 'sleeping') return { ok: false, reason: `${rt.profile.name} is asleep` };
      if (rt.state.conversationId) return { ok: false, reason: `${rt.profile.name} is busy talking` };
    }
    if (!this.startConversation(aId, bId, true)) return { ok: false, reason: 'They cannot talk right now' };
    this.toast('💬', `${a.profile.name} is going to talk to ${b.profile.name}`);
    return { ok: true };
  }

  /** Toolbar "Town event": ask the most sociable awake villager without an upcoming event to propose one. */
  private proposeTownEvent(): CommandResult {
    const now = this.now();
    const hosting = new Set(
      this.eventList
        .filter((e) => e.end > now && e.status !== 'cancelled' && e.status !== 'done')
        .map((e) => e.hostId),
    );
    let best: Runtime | null = null;
    let bestScore = -Infinity;
    for (const rt of this.runtimes.values()) {
      if (rt.profile.transient || rt.state.status === 'sleeping') continue;
      const social = rt.profile.traits.filter((t) => SOCIAL_TRAITS.test(t)).length;
      const score = (hosting.has(rt.profile.id) ? -10 : 0) + social + this.rng.next();
      if (score > bestScore) {
        bestScore = score;
        best = rt;
      }
    }
    if (!best) return { ok: false, reason: 'Everyone is asleep' };
    try {
      best.mind.requestEventProposal();
    } catch (err) {
      log.error(`requestEventProposal failed for ${best.profile.id}`, err);
      return { ok: false, reason: 'Nobody has an idea right now' };
    }
    this.log('info', `${best.profile.name} is thinking about a town event`);
    return { ok: true };
  }

  /**
   * The villager answers the player (WP8 already broadcast the player's line). The villager stops
   * and faces the player until a few minutes after its last reply.
   */
  /** The owner stops for up to GREETING_HOLD_MINUTES (👋) and greets the player via `mind.greetVisitor` (spec v2 §6). */
  private requestGreeting(id: VillagerId, visit: HouseVisit): Promise<{ reply: string; source: Provenance }> {
    const rt = this.runtimes.get(id);
    if (!rt?.mind.greetVisitor) return Promise.reject(new Error(`${id} cannot greet`));
    const now = this.now();
    if (!rt.state.conversationId && rt.state.status !== 'sleeping') {
      const conversation: Conversation = {
        id: `c${++this.seq}`,
        participants: [PLAYER_ID, id],
        locationId: rt.state.locationId,
        startedAt: now,
        messages: [],
        status: 'active',
      };
      this.active.set(conversation.id, {
        conversation,
        sent: 0,
        started: true,
        withPlayer: true,
        publicId: playerConversationId(id),
        pendingReplies: 0,
        holdUntil: now + GREETING_HOLD_MINUTES,
      });
      rt.state.conversationId = conversation.id;
      rt.state.status = 'talking';
      rt.state.path = [];
      rt.approach = null;
      rt.target = null;
      rt.arrived = false;
      rt.state.activity = {
        text: `greeting ${this.player.name}`,
        emoji: '👋',
        locationId: rt.state.locationId,
        since: now,
      };
      const p = this.player.pos;
      rt.state.facing = facingFor(p.x - rt.state.pos.x, p.y - rt.state.pos.y, rt.state.facing);
    }
    let reply: Promise<{ reply: string; source: Provenance }>;
    try {
      reply = rt.mind.greetVisitor(this.buildView(rt), visit);
    } catch (err) {
      reply = Promise.reject(err);
    }
    const shown = reply.then((r) => {
      const live = this.runtimes.get(id);
      const text = typeof r?.reply === 'string' ? r.reply.trim() : '';
      if (live && text) live.bubble = { text, untilMs: Date.now() + BUBBLE_MS, untilGame: this.now() + 10 };
      return r;
    });
    this.track(shown.catch(() => undefined));
    return shown;
  }

  private requestPlayerReply(req: PlayerReplyRequest): void {
    const rt = this.runtimes.get(req.villagerId);
    if (!rt) return;
    const id = rt.profile.id;
    const now = this.now();
    const currentId = rt.state.conversationId;
    let entry = currentId ? this.active.get(currentId) : undefined;
    if (entry && !entry.withPlayer) entry = undefined;
    if (!entry && !currentId) {
      const conversation: Conversation = {
        id: `c${++this.seq}`,
        participants: [PLAYER_ID, id],
        locationId: rt.state.locationId,
        startedAt: now,
        messages: [],
        status: 'active',
      };
      entry = {
        conversation,
        sent: 0,
        started: true,
        withPlayer: true,
        publicId: req.conversationId,
        pendingReplies: 0,
      };
      this.active.set(conversation.id, entry);
      rt.state.conversationId = conversation.id;
      rt.state.status = 'talking';
      rt.state.path = [];
      rt.approach = null;
      rt.target = null;
      rt.arrived = false;
      rt.state.activity = {
        text: `talking with ${this.player.name}`,
        emoji: '💬',
        locationId: rt.state.locationId,
        since: now,
      };
    }
    if (entry) {
      const p = this.player.pos;
      rt.state.facing = facingFor(p.x - rt.state.pos.x, p.y - rt.state.pos.y, rt.state.facing);
      if (req.mode !== 'gift') {
        // Already broadcast by WP8; kept for the conversation history only.
        entry.conversation.messages.push({ speakerId: PLAYER_ID, text: req.text, at: now });
        entry.sent = entry.conversation.messages.length;
      }
      entry.pendingReplies = (entry.pendingReplies ?? 0) + 1;
    }
    const input = {
      text: req.text,
      mode: req.mode,
      ...(req.itemId !== undefined ? { itemId: req.itemId } : {}),
      ...(req.liked !== undefined ? { liked: req.liked } : {}),
    };
    let reply: Promise<PlayerReply>;
    try {
      reply = rt.mind.replyToPlayer(this.buildView(rt), input);
    } catch (err) {
      reply = Promise.reject(err);
    }
    const target = entry;
    const p = reply
      .then(
        (r): PlayerReply & { source?: Provenance } => r,
        (err: unknown): PlayerReply & { source?: Provenance } => {
          log.warn(`replyToPlayer failed for ${id}: ${(err as Error).message}`);
          return { reply: PLAYER_REPLY_FALLBACK, source: 'fallback' };
        },
      )
      .then((r) => {
        const live = this.runtimes.get(id);
        if (!live) return;
        const given = (r.reply ?? '').trim();
        const text = given || PLAYER_REPLY_FALLBACK;
        const source: Provenance | undefined = given ? r.source : 'fallback';
        const prov = source ? { source } : {};
        if (target && this.active.has(target.conversation.id)) {
          target.conversation.messages.push({ speakerId: id, text, at: this.now(), ...prov });
          this.flushMessages(target);
        } else {
          this.broadcast({
            type: 'conversation.message',
            conversationId: req.conversationId,
            speakerId: id,
            listenerId: PLAYER_ID,
            text,
            time: this.now(),
            ...prov,
          });
          live.bubble = { text, untilMs: Date.now() + BUBBLE_MS, untilGame: this.now() + 10 };
        }
        if (r.task) {
          const who = live.profile.name;
          this.log(
            'info',
            r.task.accepted ? `${who} agreed to ${r.task.activity}` : `${who} declined your request`,
          );
        }
      })
      .finally(() => {
        if (!target) return;
        target.pendingReplies = Math.max(0, (target.pendingReplies ?? 1) - 1);
        target.holdUntil = this.now() + PLAYER_CHAT_HOLD_MINUTES;
      });
    this.track(p);
  }
}
function settle(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

export const createSimEngine = (opts: SimEngineOptions): Engine => new Engine(opts);
