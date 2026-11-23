import { DEFAULT_CONFIG, type AppConfig } from '../../../src/server/config.ts';
import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  EmbeddingProvider,
  EnqueueOptions,
  LlmQueue,
  LlmTask,
} from '../../../src/server/llm/types.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import type { QueueStats, ServerMessage } from '../../../src/shared/protocol.ts';
import type {
  DoorNote,
  GameMinutes,
  Letter,
  Location,
  VillageEvent,
  VillagerProfile,
  VillagerState,
  Weather,
} from '../../../src/shared/types.ts';
import { Mind } from '../../../src/server/cognition/mind.ts';
import { createMemoryWorld, type MemoryWorld } from '../../../src/server/cognition/host.ts';
import type { MindSnapshot, WorldView } from '../../../src/server/cognition/types.ts';
import { createRng } from '../../../src/server/cognition/rng.ts';

/** Minimal LlmQueue over a provider (no concurrency limit), with drain() and a request log. */
export class DirectQueue implements LlmQueue {
  readonly requests: ChatRequest[] = [];
  private inflight = new Set<Promise<unknown>>();

  constructor(
    readonly chat: ChatProvider,
    readonly embeddings: EmbeddingProvider | null = null,
  ) {}

  /** Mirrors PriorityLlmQueue: false when embeddings are off for good. */
  get embeddingsAvailable(): boolean {
    return this.embeddings !== null;
  }

  readonly priorities = new Map<ChatRequest, number | undefined>();

  enqueue(req: ChatRequest, opts?: EnqueueOptions): Promise<ChatResponse> {
    this.requests.push(req);
    this.priorities.set(req, opts?.priority);
    const signal = req.signal;
    if (!signal) return this.track(this.chat.chat(req));
    // Like the real queue: an aborted caller stops waiting for the provider.
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error('aborted'));
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return this.track(Promise.race([this.chat.chat(req), aborted]));
  }

  embed(texts: string[]): Promise<number[][] | null> {
    if (!this.embeddings) return Promise.resolve(null);
    return this.track(this.embeddings.embed(texts));
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p)).catch(() => {});
    return p;
  }

  async drain(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (this.inflight.size === 0) {
        await new Promise((r) => setTimeout(r, 0));
        if (this.inflight.size === 0) return;
      }
      await Promise.allSettled([...this.inflight]);
    }
  }

  count(task: LlmTask): number {
    return this.requests.filter((r) => r.task === task).length;
  }

  stats(): QueueStats {
    return {
      queued: 0,
      running: this.inflight.size,
      done: this.requests.length,
      failed: 0,
      avgLatencyMs: 0,
      totalLatencyMs: 0,
      totalTokens: 0,
      lastReplyMs: null,
      tokensPerSecond: null,
    };
  }
}

export const LOCATIONS: Location[] = [
  { id: 'plaza', name: 'Plaza', kind: 'public', area: { x: 20, y: 10, w: 8, h: 8 }, entry: { x: 24, y: 14 } },
  {
    id: 'bakery',
    name: 'Bakery',
    kind: 'shop',
    area: { x: 5, y: 5, w: 5, h: 4 },
    entry: { x: 7, y: 9 },
    ownerIds: ['mia'],
  },
  { id: 'cafe', name: 'Cafe', kind: 'shop', area: { x: 30, y: 5, w: 5, h: 4 }, entry: { x: 32, y: 9 } },
  { id: 'park', name: 'Park', kind: 'nature', area: { x: 30, y: 20, w: 8, h: 6 }, entry: { x: 34, y: 20 } },
  { id: 'farm', name: 'Farm', kind: 'nature', area: { x: 2, y: 20, w: 8, h: 6 }, entry: { x: 6, y: 20 } },
  {
    id: 'house_mia',
    name: "Mia's house",
    kind: 'house',
    area: { x: 10, y: 2, w: 3, h: 3 },
    entry: { x: 11, y: 5 },
    door: { x: 11, y: 4 },
    ownerIds: ['mia'],
  },
  {
    id: 'house_ben',
    name: "Ben's house",
    kind: 'house',
    area: { x: 14, y: 2, w: 3, h: 3 },
    entry: { x: 15, y: 5 },
    door: { x: 15, y: 4 },
    ownerIds: ['ben'],
  },
  {
    id: 'house_cleo',
    name: "Cleo's house",
    kind: 'house',
    area: { x: 18, y: 2, w: 3, h: 3 },
    entry: { x: 19, y: 5 },
    door: { x: 19, y: 4 },
    ownerIds: ['cleo'],
  },
  {
    id: 'house_dan',
    name: "Dan's house",
    kind: 'house',
    area: { x: 22, y: 2, w: 3, h: 3 },
    entry: { x: 23, y: 5 },
    door: { x: 23, y: 4 },
    ownerIds: ['dan'],
  },
];

const at = (id: string, x: number, y: number, extra: Partial<Location> = {}): Location => ({
  id,
  name: id.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
  kind: 'public',
  area: { x, y, w: 4, h: 4 },
  entry: { x: x + 2, y: y + 4 },
  ...extra,
});

/** The v1 test places plus the v2 places cognition cares about (spec v2 §2.1). */
export const V2_LOCATIONS: Location[] = [
  ...LOCATIONS,
  at('square', 20, 20),
  at('market', 40, 30),
  at('post_office', 50, 2, { name: 'Post Office', kind: 'post', hours: { open: '08:00', close: '18:00' } }),
  at('notice_board', 56, 6),
  at('zoo_gate', 64, 7, { name: 'Zoo gate', kind: 'zoo', district: 'zoo' }),
  at('zoo_lion', 66, 0, { name: 'Lions', kind: 'zoo', district: 'zoo', species: 'lion' }),
  at('zoo_penguin', 72, 0, { name: 'Penguins', kind: 'zoo', district: 'zoo', species: 'penguin' }),
  at('rollercoaster', 70, 20, { name: 'Rollercoaster', kind: 'ride', district: 'zoo' }),
  at('burger_joint', 80, 26, {
    name: 'Burger Joint',
    kind: 'food',
    hours: { open: '11:00', close: '21:00' },
  }),
  at('forest', 100, 10, { name: 'Forest', kind: 'nature', district: 'forest' }),
  at('forest_grove', 110, 20, { name: 'Grove', kind: 'nature', district: 'forest' }),
  at('forest_lake', 112, 30, { name: 'Lake', kind: 'nature', district: 'forest' }),
  at('station', 70, 50, { name: 'Station', kind: 'station', district: 'station' }),
  at('hotel', 80, 40, { name: 'Hotel', kind: 'hotel', district: 'station' }),
  at('butcher', 30, 31, { name: 'Butcher', kind: 'farm', district: 'farmstead' }),
  at('house_laude', 44, 2, { name: "Laude's house", kind: 'house', ownerIds: ['laude'] }),
  at('house_franzi', 58, 2, { name: "Franzi's house", kind: 'house', ownerIds: ['franzi'] }),
];

function profile(
  id: string,
  name: string,
  occupation: string,
  bio: string,
  traits: string[],
): VillagerProfile {
  return {
    id,
    name,
    age: 30,
    occupation,
    bio,
    traits,
    homeId: `house_${id}`,
    sprite: `characters/${id}.png`,
    wakeTime: '06:00',
    sleepTime: '22:00',
  };
}

export const PROFILES: VillagerProfile[] = [
  profile('mia', 'Mia', 'baker', 'Mia runs the bakery and loves hosting bake-offs.', [
    'cheerful',
    'outgoing',
  ]),
  profile('ben', 'Ben', 'farmer', 'Ben grows vegetables on the farm.', ['quiet']),
  profile('cleo', 'Cleo', 'barista', 'Cleo makes coffee at the cafe and knows all the gossip.', ['chatty']),
  profile('dan', 'Dan', 'painter', 'Dan paints in the park.', ['dreamy']),
];

export function testConfig(overrides: Partial<AppConfig['cognition']> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    llm: { ...DEFAULT_CONFIG.llm, provider: 'mock' },
    cognition: { ...DEFAULT_CONFIG.cognition, ...overrides },
  };
}

export function makeState(
  p: VillagerProfile,
  now: GameMinutes,
  locations: readonly Location[] = LOCATIONS,
): VillagerState {
  const home = locations.find((l) => l.id === p.homeId) ?? locations[0]!;
  return {
    id: p.id,
    pos: { ...home.entry },
    facing: 'down',
    path: [],
    locationId: p.homeId,
    status: 'idle',
    activity: { text: 'waking up', emoji: '☕', locationId: p.homeId, since: now },
    thought: '',
    needs: { hunger: 80, energy: 80, social: 80, fun: 80 },
    plan: null,
    relationships: {},
  };
}

export interface TestVillage {
  queue: DirectQueue;
  provider: MockChatProvider;
  minds: Map<string, Mind>;
  worlds: Map<string, MemoryWorld>;
  states: Map<string, VillagerState>;
  events: VillageEvent[];
  notes: DoorNote[];
  letters: Letter[];
  messages: ServerMessage[];
  time: { now: GameMinutes };
  weather?: Weather;
  view(id: string): WorldView;
  /** Step every mind at `t` (1-minute steps from the current time), applying world writes to state. */
  advanceTo(t: GameMinutes, step?: number): Promise<void>;
}

export function createTestVillage(opts: {
  profiles?: VillagerProfile[];
  start: GameMinutes;
  config?: AppConfig;
  provider?: MockChatProvider;
  embeddings?: EmbeddingProvider | null;
  snapshots?: Record<string, MindSnapshot>;
  seed?: number;
  /** Map for the views (default: the v1 test places). */
  locations?: Location[];
  /** Extra WorldView fields per villager (v2: romances, notices, visitor, animals...). */
  extraView?: (id: string) => Partial<WorldView>;
}): TestVillage {
  const locations = opts.locations ?? LOCATIONS;
  const provider = opts.provider ?? new MockChatProvider();
  const queue = new DirectQueue(provider, opts.embeddings ?? null);
  const config = opts.config ?? testConfig();
  const profiles = opts.profiles ?? PROFILES;
  const events: VillageEvent[] = [];
  const notes: DoorNote[] = [];
  const letters: Letter[] = [];
  const messages: ServerMessage[] = [];
  const time = { now: opts.start };
  const rng = createRng(opts.seed ?? 7);
  const minds = new Map<string, Mind>();
  const worlds = new Map<string, MemoryWorld>();
  const states = new Map<string, VillagerState>();
  const names = Object.fromEntries(profiles.map((p) => [p.id, p.name]));
  const village: TestVillage = {
    queue,
    provider,
    minds,
    worlds,
    states,
    events,
    notes,
    letters,
    messages,
    time,
    view(id) {
      const p = profiles.find((x) => x.id === id)!;
      const self = states.get(id)!;
      self.relationships = Object.fromEntries(
        Object.entries(worlds.get(id)!.relationships).map(([k, v]) => [
          k,
          { affinity: v.affinity, ...(v.summary ? { summary: v.summary } : {}) },
        ]),
      );
      self.plan = worlds.get(id)!.plan;
      return {
        now: time.now,
        self,
        profile: p,
        nearby: [],
        location: locations.find((l) => l.id === self.locationId) ?? null,
        locations,
        notesAtHome: notes.filter((n) => n.houseId === p.homeId),
        events,
        villagerNames: names,
        ...(village.weather ? { weather: village.weather } : {}),
        ...opts.extraView?.(id),
      };
    },
    async advanceTo(t, step = 1) {
      while (time.now < t) {
        time.now = Math.min(t, time.now + step);
        for (const [id, mind] of minds) {
          const intent = mind.update(village.view(id));
          const s = states.get(id)!;
          if (intent.type === 'goto') {
            const was = s.locationId;
            s.locationId = intent.locationId;
            s.status = 'idle';
            s.activity = {
              text: intent.activity,
              emoji: intent.emoji ?? '',
              locationId: intent.locationId,
              since: time.now,
            };
            if (was !== intent.locationId) mind.onArrive(village.view(id), intent.locationId);
          } else if (intent.type === 'act') {
            s.status = 'acting';
            s.activity = {
              text: intent.activity,
              emoji: intent.emoji ?? '',
              locationId: s.locationId,
              since: time.now,
            };
          } else if (intent.type === 'sleep') s.status = 'sleeping';
        }
        await queue.drain();
      }
    },
  };
  for (const p of profiles) {
    const world = createMemoryWorld({ events, notes, letters, self: p.id, now: () => time.now });
    worlds.set(p.id, world);
    states.set(p.id, makeState(p, opts.start, locations));
    const snapshot = opts.snapshots?.[p.id];
    minds.set(
      p.id,
      new Mind(p, {
        config,
        queue,
        now: () => time.now,
        emit: (m) => messages.push(m),
        world,
        random: rng,
        ...(snapshot ? { snapshot } : {}),
      }),
    );
  }
  return village;
}
