import type {
  InspectDataMsg,
  QueueStats,
  ServerMessage,
  VillagerFrame,
  VillagerProfilePublic,
} from '../../shared/protocol.ts';
import {
  PLAYER_ID,
  type DoorNote,
  type GameMinutes,
  type Location,
  type LocationId,
  type PlayerState,
  type Rumor,
  type VillageEvent,
  type VillagerId,
  type VillagerState,
  type Weather,
  type WorldEvent,
  type WorldMap,
} from '../../shared/types.ts';
import { DEFAULT_CATALOG } from './catalog.ts';
import type { Catalog, ConnectionState } from './types.ts';

export type Topic =
  | 'hello'
  | 'connection'
  | 'time'
  | 'speed'
  | 'villagers'
  | 'player'
  | 'stats'
  | 'rumors'
  | 'notes'
  | 'events'
  | 'weather'
  | 'inspect'
  | 'selection'
  | 'scene'
  | 'catalog'
  | 'chat';

export interface ToastItem {
  icon: string;
  text: string;
}

/** A line in the player conversation dialog. */
export interface ChatLine {
  from: VillagerId;
  to: VillagerId;
  text: string;
  pending?: boolean;
}

export interface LlmInfo {
  provider: string;
  model: string;
  embeddings: string | null;
}

/**
 * Client-side view of the world for the UI panels, built only from server messages.
 * Components subscribe to topics and re-render when one of them changes.
 */
export class UiStore {
  connection: ConnectionState = 'connecting';
  map: WorldMap | null = null;
  llm: LlmInfo | null = null;
  debug = false;
  time: GameMinutes = 0;
  speed = 1;
  /** Last non-zero speed, restored by un-pausing. */
  lastSpeed = 1;
  profiles = new Map<VillagerId, VillagerProfilePublic>();
  frames = new Map<VillagerId, VillagerFrame>();
  villagerStates = new Map<VillagerId, VillagerState>();
  player: PlayerState | null = null;
  rumors: Rumor[] = [];
  notes = new Map<string, DoorNote>();
  events = new Map<string, VillageEvent>();
  worldEvents = new Map<string, WorldEvent>();
  weather: Weather = { state: 'clear', since: 0, until: null };
  queue: QueueStats | null = null;
  llmOnline = true;
  simTicksPerSecond = 0;
  inspect: InspectDataMsg | null = null;
  selectedId: VillagerId | null = null;
  activeScene: string | null = 'plaza';
  catalog: Catalog = DEFAULT_CATALOG;
  chat: ChatLine[] = [];
  chatWith: VillagerId | null = null;

  private listeners = new Map<Topic, Set<() => void>>();
  private toastListeners = new Set<(t: ToastItem) => void>();

  subscribe(topics: Topic[], cb: () => void): () => void {
    for (const t of topics) {
      let set = this.listeners.get(t);
      if (!set) this.listeners.set(t, (set = new Set()));
      set.add(cb);
    }
    return () => topics.forEach((t) => this.listeners.get(t)?.delete(cb));
  }

  onToast(cb: (t: ToastItem) => void): () => void {
    this.toastListeners.add(cb);
    return () => this.toastListeners.delete(cb);
  }

  toast(icon: string, text: string): void {
    for (const cb of this.toastListeners) cb({ icon, text });
  }

  emit(...topics: Topic[]): void {
    const called = new Set<() => void>();
    for (const t of topics) {
      for (const cb of this.listeners.get(t) ?? []) {
        if (called.has(cb)) continue;
        called.add(cb);
        cb();
      }
    }
  }

  apply(msg: ServerMessage): void {
    switch (msg.type) {
      case 'hello': {
        this.map = msg.map;
        this.llm = msg.llm;
        this.debug = msg.debug;
        this.profiles = new Map(msg.villagers.map((v) => [v.id, v]));
        const s = msg.snapshot;
        this.time = s.time;
        this.setSpeed(s.speed);
        this.villagerStates = new Map(s.villagers.map((v) => [v.id, v]));
        this.frames = new Map(
          s.villagers.map((v) => [
            v.id,
            {
              id: v.id,
              x: v.pos.x,
              y: v.pos.y,
              facing: v.facing,
              status: v.status,
              activity: v.activity.text,
              emoji: v.activity.emoji,
            },
          ]),
        );
        this.player = s.player;
        this.rumors = [...s.rumors];
        this.notes = new Map(s.notes.map((n) => [n.id, n]));
        this.events = new Map(s.events.map((e) => [e.id, e]));
        this.worldEvents = new Map(s.worldEvents.map((e) => [e.id, e]));
        this.weather = s.weather;
        this.emit(
          'hello',
          'time',
          'speed',
          'villagers',
          'player',
          'rumors',
          'notes',
          'events',
          'weather',
          'scene',
        );
        break;
      }
      case 'tick':
        this.time = msg.time;
        for (const f of msg.villagers) this.frames.set(f.id, f);
        if (msg.speed !== this.speed) {
          this.setSpeed(msg.speed);
          this.emit('speed');
        }
        this.emit('time', 'villagers');
        break;
      case 'stats':
        this.queue = msg.queue;
        this.llmOnline = msg.llmOnline;
        this.simTicksPerSecond = msg.simTicksPerSecond;
        this.emit('stats');
        break;
      case 'player.updated':
        this.player = msg.player;
        this.emit('player');
        break;
      case 'rumor.updated': {
        const i = this.rumors.findIndex((r) => r.id === msg.rumor.id);
        if (i >= 0) this.rumors[i] = msg.rumor;
        else this.rumors.push(msg.rumor);
        this.emit('rumors');
        break;
      }
      case 'note.updated':
        this.notes.set(msg.note.id, msg.note);
        this.emit('notes');
        break;
      case 'event.updated':
        this.events.set(msg.event.id, msg.event);
        this.emit('events');
        break;
      case 'world.event':
        this.worldEvents.set(msg.event.id, msg.event);
        this.emit('events');
        break;
      case 'weather.updated':
        this.weather = msg.weather;
        this.emit('weather');
        break;
      case 'inspect.data':
        if (msg.villagerId !== this.selectedId) break;
        this.inspect = msg;
        this.villagerStates.set(msg.villagerId, msg.state);
        this.emit('inspect');
        break;
      case 'villagers.changed':
        for (const p of msg.added) this.profiles.set(p.id, p);
        for (const id of msg.removed) {
          this.profiles.delete(id);
          this.frames.delete(id);
          this.villagerStates.delete(id);
        }
        this.emit('villagers');
        if (this.selectedId && msg.removed.includes(this.selectedId)) this.select(null);
        break;
      case 'conversation.message':
        if (msg.listenerId === PLAYER_ID && msg.speakerId === this.chatWith) {
          this.chat = this.chat.filter((l) => !l.pending);
          this.chat.push({ from: msg.speakerId, to: PLAYER_ID, text: msg.text });
          this.emit('chat');
        }
        break;
      case 'toast':
        this.toast(msg.icon, msg.text);
        break;
      case 'error':
        this.toast('⚠️', msg.message);
        if (this.chat.some((l) => l.pending)) {
          this.chat = this.chat.filter((l) => !l.pending);
          this.emit('chat');
        }
        break;
      default:
        break;
    }
  }

  setConnection(state: ConnectionState): void {
    if (state === this.connection) return;
    this.connection = state;
    this.emit('connection');
  }

  select(id: VillagerId | null): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.inspect = null;
    this.emit('selection', 'inspect');
  }

  setScene(id: string | null): void {
    if (id === this.activeScene) return;
    this.activeScene = id;
    this.emit('scene');
  }

  setCatalog(c: Partial<Catalog>): void {
    this.catalog = {
      items: c.items?.length ? c.items : this.catalog.items,
      decorations: c.decorations?.length ? c.decorations : this.catalog.decorations,
    };
    this.emit('catalog', 'player');
  }

  startChat(villagerId: VillagerId, text: string, pendingText: string): void {
    if (this.chatWith !== villagerId) this.chat = [];
    this.chatWith = villagerId;
    this.chat = this.chat.filter((l) => !l.pending);
    this.chat.push({ from: PLAYER_ID, to: villagerId, text });
    this.chat.push({ from: villagerId, to: PLAYER_ID, text: pendingText, pending: true });
    this.chat = this.chat.slice(-8);
    this.emit('chat');
  }

  closeChat(): void {
    this.chatWith = null;
    this.chat = [];
    this.emit('chat');
  }

  private setSpeed(s: number): void {
    this.speed = s;
    if (s > 0) this.lastSpeed = s;
  }

  // ---------- derived helpers ----------

  name(id: VillagerId): string {
    if (id === PLAYER_ID) return this.player?.name ?? 'You';
    return this.profiles.get(id)?.name ?? id;
  }

  location(id: LocationId | null | undefined): Location | undefined {
    if (!id) return undefined;
    return this.map?.locations.find((l) => l.id === id);
  }

  locationName(id: LocationId | null | undefined): string {
    return this.location(id)?.name ?? (id ? id.replace(/_/g, ' ') : 'somewhere');
  }

  /** Villager ids sorted by name (excludes the player). */
  villagerIds(): VillagerId[] {
    return [...this.profiles.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => p.id);
  }

  notesFor(houseId: LocationId): DoorNote[] {
    return [...this.notes.values()]
      .filter((n) => n.houseId === houseId)
      .sort((a, b) => b.postedAt - a.postedAt);
  }

  /** Notes villagers left in the player's mailbox that the player has not opened yet. */
  unreadMail(): number {
    return [...this.notes.values()].filter(
      (n) => n.ownerId === PLAYER_ID && n.authorId !== PLAYER_ID && n.status === 'unread',
    ).length;
  }

  /** Newest rumor first. */
  sortedRumors(): Rumor[] {
    return [...this.rumors].sort((a, b) => latestRumorTime(b) - latestRumorTime(a));
  }
}

function latestRumorTime(r: Rumor): number {
  return Math.max(r.startedAt, ...r.hops.map((h) => h.at));
}
