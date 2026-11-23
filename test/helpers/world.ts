/**
 * Headless test harness (spec §13): a SimEngine on the virtual clock with the deterministic mock
 * provider, plus helpers to drive the day and query what happened. The engine and mind modules are
 * loaded dynamically so this file typechecks before WP2/WP3 land.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientMessage, InspectDataMsg, ServerMessage } from '../../src/shared/protocol.ts';
import {
  type Conversation,
  type GameMinutes,
  type Location,
  type Memory,
  type VillagerId,
  type VillagerProfile,
  type VillagerState,
  type WorldMap,
  type WorldSnapshot,
} from '../../src/shared/types.ts';
import { at, dayOf, MINUTES_PER_DAY, minuteOfDay, parseClock } from '../../src/shared/time.ts';
import { loadConfig, type AppConfig, type PartialConfig } from '../../src/server/config.ts';
import { MockChatProvider, MockEmbeddingProvider } from '../../src/server/llm/providers/mock.ts';
import type { CreateMind } from '../../src/server/cognition/types.ts';
import type { CreateSimEngine, SimEngine } from '../../src/server/sim/types.ts';
import type { SaveData } from '../../src/server/persistence/types.ts';
import { featurePath, repoPath } from './features.ts';

export interface TestWorldOptions {
  villagers?: number;
  seed?: number;
  /** "HH:MM" on day 0, or absolute game minutes. Default "06:00". */
  startAt?: string | GameMinutes;
  config?: PartialConfig;
  /** Use embeddings (mock) or keyword retrieval. Default: mock embeddings. */
  embeddings?: boolean;
  map?: WorldMap;
  profiles?: VillagerProfile[];
  restore?: SaveData;
  createMind?: CreateMind;
  /** Reuse a provider (e.g. to keep scripted answers across a restore). */
  provider?: MockChatProvider;
  /** Engine factory (default: WP2's createSimEngine). The harness self-test passes a fake. */
  engineFactory?: CreateSimEngine;
}

export interface StepInfo {
  time: GameMinutes;
  snapshot: () => WorldSnapshot;
}

export interface TestWorld {
  engine: SimEngine;
  provider: MockChatProvider;
  config: AppConfig;
  /** Every broadcast message except `tick` and `stats` (kept small for long runs). */
  messages: ServerMessage[];
  ticks: number;
  now(): GameMinutes;
  state(): WorldSnapshot;
  villager(id: VillagerId): VillagerState;
  profile(id: VillagerId): VillagerProfile;
  location(id: string): Location | undefined;
  /** Advance to the next occurrence of `hhmm` (or an absolute time), calling onStep every `sampleEvery` minutes. */
  advanceTo(target: string | GameMinutes, opts?: AdvanceToOptions): Promise<void>;
  advance(minutes: number, opts?: AdvanceToOptions): Promise<void>;
  /** Step minute by minute until `pred` holds (returns true) or `maxMinutes` pass (returns false). */
  until(pred: (w: TestWorld) => boolean, maxMinutes: number, step?: number): Promise<boolean>;
  command(cmd: ClientMessage): ServerMessage[];
  inspect(id: VillagerId): InspectDataMsg | undefined;
  memories(id: VillagerId): readonly Memory[];
  conversations(): readonly Conversation[];
  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[];
  errors(): string[];
  dispose(): void;
}

export interface AdvanceToOptions {
  /** Game minutes per engine.advance call (default 5). */
  chunk?: number;
  onStep?: (info: StepInfo) => void;
}

type EngineModule = { createSimEngine: CreateSimEngine };

export async function loadEngineFactory(): Promise<CreateSimEngine> {
  const mod = (await import(/* @vite-ignore */ repoPath(featurePath('engine')))) as EngineModule;
  if (typeof mod.createSimEngine !== 'function')
    throw new Error(`${featurePath('engine')} does not export createSimEngine`);
  return mod.createSimEngine;
}

/** A config for tests: mock provider, debug on, no autosave, saves in a temp dir, no config.json. */
export function testConfig(opts: TestWorldOptions = {}): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'tpp-test-'));
  const base: PartialConfig = {
    llm: { provider: 'mock', model: 'mock', concurrency: 2 },
    embeddings: { provider: opts.embeddings === false ? 'none' : 'mock', model: 'mock-embed' },
    sim: { villagers: opts.villagers ?? 10, seed: opts.seed ?? 42 },
    persistence: { dir: join(dir, 'saves'), loadOnStart: false, autosaveGameMinutes: 0 },
    debug: true,
  };
  // cwd = empty temp dir, so a developer's config.json or env never leaks into tests.
  const { sourcePath: _ignored, ...cfg } = loadConfig({
    env: {},
    cwd: dir,
    overrides: mergeDeep(base, opts.config),
  });
  return cfg;
}

function mergeDeep(a: unknown, b: unknown): PartialConfig {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null || Array.isArray(b))
    return (b ?? a) as PartialConfig;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b)) out[k] = mergeDeep(out[k], v);
  return out as PartialConfig;
}

export function toGameTime(t: string | GameMinutes, day = 0): GameMinutes {
  return typeof t === 'number' ? t : at(day, t);
}

export async function createTestWorld(opts: TestWorldOptions = {}): Promise<TestWorld> {
  const createSimEngine = opts.engineFactory ?? (await loadEngineFactory());
  const config = testConfig(opts);
  const provider = opts.provider ?? new MockChatProvider(config.llm.model);
  const engine = createSimEngine({
    config,
    providers: { chat: provider, embeddings: opts.embeddings === false ? null : new MockEmbeddingProvider() },
    startAt: toGameTime(opts.startAt ?? '06:00'),
    ...(opts.map ? { map: opts.map } : {}),
    ...(opts.profiles ? { profiles: opts.profiles } : {}),
    ...(opts.restore ? { restore: opts.restore } : {}),
    ...(opts.createMind ? { createMind: opts.createMind } : {}),
  });
  const messages: ServerMessage[] = [];
  let ticks = 0;
  const unsubscribe = engine.onMessage((msg) => {
    if (msg.type === 'tick') ticks++;
    else if (msg.type !== 'stats') messages.push(msg);
  });

  const world: TestWorld = {
    engine,
    provider,
    config,
    messages,
    get ticks() {
      return ticks;
    },
    now: () => engine.now(),
    state: () => engine.snapshot(),
    villager(id) {
      const v = engine.snapshot().villagers.find((x) => x.id === id);
      if (!v) throw new Error(`unknown villager ${id}`);
      return v;
    },
    profile(id) {
      const p = engine.profiles.find((x) => x.id === id);
      if (!p) throw new Error(`unknown profile ${id}`);
      return p;
    },
    location: (id) => engine.map.locations.find((l) => l.id === id),
    async advance(minutes, o = {}) {
      await world.advanceTo(engine.now() + minutes, o);
    },
    async advanceTo(target, o = {}) {
      let end: GameMinutes;
      if (typeof target === 'number') end = target;
      else {
        const now = engine.now();
        end = dayOf(now) * MINUTES_PER_DAY + parseClock(target);
        if (end <= now) end += MINUTES_PER_DAY;
      }
      const chunk = o.chunk ?? 5;
      while (engine.now() < end) {
        const dt = Math.min(chunk, end - engine.now());
        await engine.advance(dt, { drainLlm: true, step: 1 });
        o.onStep?.({ time: engine.now(), snapshot: () => engine.snapshot() });
      }
    },
    async until(pred, maxMinutes, step = 1) {
      const end = engine.now() + maxMinutes;
      while (engine.now() < end) {
        if (pred(world)) return true;
        await engine.advance(step, { drainLlm: true, step: 1 });
      }
      return pred(world);
    },
    command(cmd) {
      const replies = engine.handleCommand(cmd);
      messages.push(...replies.filter((m) => m.type !== 'tick'));
      return replies;
    },
    inspect(id) {
      const replies = world.command({ type: 'inspect', villagerId: id });
      const found =
        replies.find((m): m is InspectDataMsg => m.type === 'inspect.data' && m.villagerId === id) ??
        [...messages]
          .reverse()
          .find((m): m is InspectDataMsg => m.type === 'inspect.data' && m.villagerId === id);
      world.command({ type: 'inspect', villagerId: null });
      return found;
    },
    memories: (id) => engine.memories(id),
    conversations: () => engine.conversations(),
    of(type) {
      return messages.filter((m) => m.type === type) as never;
    },
    errors: () =>
      messages
        .filter((m) => m.type === 'log' && m.level === 'error')
        .map((m) => (m as { text: string }).text),
    dispose() {
      unsubscribe();
      engine.stop();
    },
  };
  return world;
}

/** Dynamically import a module of another work package (typed by the caller). */
export async function importRepo<T>(rel: string): Promise<T> {
  return (await import(/* @vite-ignore */ repoPath(rel))) as T;
}

/** A mind that never decides anything: for engine-only tests (speed, movement, data). */
export const stubMind: CreateMind = (profile) => ({
  id: profile.id,
  update: () => ({ type: 'wait' }),
  observe: () => {},
  onArrive: () => {},
  wantsToTalkTo: () => false,
  replyToPlayer: async () => ({ reply: '...' }),
  requestEventProposal: () => {},
  serialize: () => ({
    villagerId: profile.id,
    memories: [],
    bookkeeping: { importanceSinceReflection: 0, lastReflectionAt: null, lastPlanAt: null },
  }),
});

/** Wait real time (real-clock tests only). */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- query helpers ----------

export function currentBlock(v: VillagerState, time: GameMinutes) {
  const mod = minuteOfDay(time);
  return v.plan?.blocks.find((b) => b.start <= mod && mod < b.end);
}

export function awake(v: VillagerState): boolean {
  return v.status !== 'sleeping';
}

export function inArea(p: { x: number; y: number }, loc: Location): boolean {
  const { x, y, w, h } = loc.area;
  return p.x >= x - 0.5 && p.x < x + w + 0.5 && p.y >= y - 0.5 && p.y < y + h + 0.5;
}

/** Keywords of a text: lowercase words of 4+ letters minus a few stopwords. */
export function keywords(text: string): string[] {
  const stop = new Set([
    'that',
    'this',
    'with',
    'from',
    'your',
    'have',
    'will',
    'about',
    'there',
    'what',
    'could',
    'would',
  ]);
  return [...new Set((text.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !stop.has(w)))];
}
