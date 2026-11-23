import type { Observation } from '../../../src/server/cognition/types.ts';
import { DEFAULT_CONFIG } from '../../../src/server/config.ts';
import type { LlmQueue } from '../../../src/server/llm/types.ts';
import { loadCatalogs } from '../../../src/server/player/catalog.ts';
import type { PlayerHost, PlayerReplyRequest } from '../../../src/server/player/host.ts';
import {
  createPlayerWorld,
  type PlayerWorld,
  type PlayerWorldSave,
} from '../../../src/server/player/index.ts';
import type { PlayerWorldConfig } from '../../../src/server/player/context.ts';
import type { CommandResult } from '../../../src/server/player/types.ts';
import type { ServerMessage } from '../../../src/shared/protocol.ts';
import { at } from '../../../src/shared/time.ts';
import {
  PLAYER_HOME_ID,
  PLAYER_ID,
  type DayPlan,
  type Location,
  type Point,
  type VillageEvent,
  type VillagerProfile,
  type VillagerState,
  type WorldMap,
} from '../../../src/shared/types.ts';

export const W = 30;
export const H = 20;

/** Open 30x20 map with a blocked border and a few locations. */
export function testMap(): WorldMap {
  const collision: (0 | 1)[] = Array.from({ length: W * H }, (_, i) => {
    const x = i % W;
    const y = Math.floor(i / W);
    return x === 0 || y === 0 || x === W - 1 || y === H - 1 ? 1 : 0;
  });
  const loc = (l: Location) => l;
  return {
    width: W,
    height: H,
    tileSize: 16,
    tilesets: [],
    layers: { ground: [], decor: [], overhead: [] },
    collision,
    locations: [
      loc({
        id: 'square',
        name: 'Town square',
        kind: 'public',
        area: { x: 12, y: 7, w: 6, h: 6 },
        entry: { x: 15, y: 10 },
      }),
      loc({
        id: 'park',
        name: 'Park',
        kind: 'nature',
        area: { x: 22, y: 2, w: 6, h: 5 },
        entry: { x: 24, y: 4 },
      }),
      loc({
        id: 'bakery',
        name: 'Bakery',
        kind: 'shop',
        area: { x: 12, y: 2, w: 5, h: 3 },
        entry: { x: 14, y: 5 },
      }),
      loc({
        id: 'shop',
        name: 'Shop',
        kind: 'shop',
        area: { x: 22, y: 14, w: 5, h: 3 },
        entry: { x: 24, y: 13 },
      }),
      loc({
        id: 'house_ada',
        name: "Ada's house",
        kind: 'house',
        area: { x: 2, y: 2, w: 4, h: 3 },
        entry: { x: 4, y: 5 },
        door: { x: 4, y: 4 },
        ownerIds: ['ada'],
      }),
      loc({
        id: 'house_ben',
        name: "Ben's house",
        kind: 'house',
        area: { x: 6, y: 2, w: 4, h: 3 },
        entry: { x: 8, y: 5 },
        door: { x: 8, y: 4 },
        ownerIds: ['ben'],
      }),
      loc({
        id: PLAYER_HOME_ID,
        name: 'Your cottage',
        kind: 'house',
        area: { x: 1, y: 14, w: 6, h: 5 },
        entry: { x: 4, y: 16 },
        door: { x: 4, y: 15 },
        ownerIds: [PLAYER_ID],
        decorSlots: Array.from({ length: 10 }, (_, i) => ({ x: 1 + (i % 5), y: 17 + Math.floor(i / 5) })),
      }),
    ],
    scenes: [],
    itemSpawns: [{ itemId: 'flower', area: { x: 22, y: 2, w: 6, h: 5 }, max: 3 }],
  };
}

/** BFS 4-dir path, excluding the start tile. */
export function bfs(map: WorldMap, from: Point, to: Point): Point[] | null {
  const key = (p: Point) => p.y * map.width + p.x;
  const blocked = (p: Point) =>
    p.x < 0 || p.y < 0 || p.x >= map.width || p.y >= map.height || map.collision[key(p)] === 1;
  if (blocked(to)) return null;
  const prev = new Map<number, number>([[key(from), -1]]);
  const queue: Point[] = [from];
  while (queue.length) {
    const p = queue.shift()!;
    if (p.x === to.x && p.y === to.y) {
      const path: Point[] = [];
      let k = key(p);
      while (k !== key(from)) {
        path.unshift({ x: k % map.width, y: Math.floor(k / map.width) });
        k = prev.get(k)!;
      }
      return path;
    }
    for (const d of [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ]) {
      const n = { x: p.x + d.x, y: p.y + d.y };
      if (blocked(n) || prev.has(key(n))) continue;
      prev.set(key(n), key(p));
      queue.push(n);
    }
  }
  return null;
}

export function profile(
  id: string,
  name: string,
  homeId: string,
  extra: Partial<VillagerProfile> = {},
): VillagerProfile {
  return {
    id,
    name,
    age: 30,
    occupation: 'baker',
    bio: `${name} lives here.`,
    traits: [],
    homeId,
    sprite: 'characters/villager-01.png',
    wakeTime: '06:00',
    sleepTime: '22:00',
    ...extra,
  };
}

export function villager(id: string, pos: Point, extra: Partial<VillagerState> = {}): VillagerState {
  return {
    id,
    pos,
    facing: 'down',
    path: [],
    locationId: null,
    status: 'idle',
    activity: { text: 'idle', emoji: '🙂', locationId: null, since: 0 },
    thought: '',
    needs: { hunger: 80, energy: 80, social: 80, fun: 80 },
    plan: null,
    relationships: {},
    ...extra,
  };
}

export function seededRandom(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MemoryRecord extends Observation {
  villagerId: string;
}

/** In-memory PlayerHost that records everything WP8 asks the engine to do. */
export class FakeHost implements PlayerHost {
  readonly map = testMap();
  time = at(0, '08:00');
  readonly random = seededRandom(7);
  readonly states: VillagerState[] = [];
  readonly profiles = new Map<string, VillagerProfile>();
  readonly memories: MemoryRecord[] = [];
  readonly messages: ServerMessage[] = [];
  readonly replies: PlayerReplyRequest[] = [];
  readonly conversations: [string, string][] = [];
  readonly events: VillageEvent[] = [];
  readonly spawned: { profile: VillagerProfile; at: Point }[] = [];
  readonly removed: string[] = [];
  proposals = 0;
  llm?: LlmQueue;
  load: 'normal' | 'busy' | 'overloaded' = 'normal';
  joinRide?: (rideId: string) => CommandResult;
  triggerTrain?: () => CommandResult;
  loadLevel = () => this.load;

  constructor() {
    this.add(profile('ada', 'Ada', 'house_ada', { likes: ['flower'] }), villager('ada', { x: 15, y: 10 }));
    this.add(profile('ben', 'Ben', 'house_ben'), villager('ben', { x: 16, y: 10 }));
    this.add(profile('cy', 'Cy', 'house_ben'), villager('cy', { x: 17, y: 11 }));
    this.add(profile('dot', 'Dot', 'house_ada'), villager('dot', { x: 10, y: 10 }, { status: 'sleeping' }));
  }

  add(p: VillagerProfile, s: VillagerState): void {
    this.profiles.set(p.id, p);
    this.states.push(s);
  }

  now = () => this.time;
  findPath = (from: Point, to: Point) => bfs(this.map, from, to);
  villagers = () => this.states;
  profile = (id: string) => this.profiles.get(id);
  setPlan = (id: string, plan: DayPlan) => {
    const v = this.states.find((s) => s.id === id);
    if (v) v.plan = plan;
  };
  addMemory = (villagerId: string, obs: Observation) => {
    this.memories.push({ villagerId, ...obs });
  };
  adjustAffinity = (villagerId: string, otherId: string, delta: number) => {
    const v = this.states.find((s) => s.id === villagerId)!;
    const rel = (v.relationships[otherId] ??= { affinity: 0 });
    rel.affinity = Math.max(-10, Math.min(10, rel.affinity + delta));
  };
  emit = (msg: ServerMessage) => {
    this.messages.push(msg);
  };
  requestPlayerReply = (req: PlayerReplyRequest) => {
    this.replies.push(req);
  };
  startConversation = (a: string, b: string) => {
    this.conversations.push([a, b]);
    return { ok: true as const };
  };
  proposeTownEvent = () => {
    this.proposals++;
    return { ok: true as const };
  };
  villageEvents = () => this.events;
  addVillageEvent = (e: VillageEvent) => {
    this.events.push(e);
  };
  spawnVillager = (p: VillagerProfile, at: Point) => {
    this.spawned.push({ profile: p, at });
    this.add(p, villager(p.id, at));
  };
  removeVillager = (id: string) => {
    this.removed.push(id);
    const i = this.states.findIndex((s) => s.id === id);
    if (i >= 0) this.states.splice(i, 1);
  };

  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  memoriesOf(id: string): MemoryRecord[] {
    return this.memories.filter((m) => m.villagerId === id);
  }
}

export function testConfig(over: Partial<PlayerWorldConfig['world']> = {}): PlayerWorldConfig {
  return {
    player: { ...DEFAULT_CONFIG.player, name: 'Kai' },
    economy: { ...DEFAULT_CONFIG.economy },
    world: { ...DEFAULT_CONFIG.world, ...over },
  };
}

export const catalogs = loadCatalogs();

export function setup(
  opts: { world?: Partial<PlayerWorldConfig['world']>; restore?: Partial<PlayerWorldSave> } = {},
): {
  host: FakeHost;
  pw: PlayerWorld;
} {
  const host = new FakeHost();
  const pw = createPlayerWorld({ host, config: testConfig(opts.world), catalogs, restore: opts.restore });
  return { host, pw };
}

/** Advance the fake clock in 1-minute steps, calling update each step. */
export function advance(host: FakeHost, pw: PlayerWorld, minutes: number, step = 1): void {
  for (let t = 0; t < minutes; t += step) {
    host.time += step;
    pw.update(step);
  }
}
