import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export const PROVIDER_KINDS = ['ollama', 'openai', 'anthropic', 'gemini', 'mock'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const EMBEDDING_PROVIDER_KINDS = ['auto', 'ollama', 'openai', 'gemini', 'mock', 'none'] as const;
export type EmbeddingProviderKind = (typeof EMBEDDING_PROVIDER_KINDS)[number];

/** Default base URLs per provider. OpenAI-compatible base URLs include the `/v1` suffix. */
export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  ollama: 'http://127.0.0.1:11434',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  mock: '',
};

/**
 * `llm.concurrency` used when the provider is `ollama` and no config layer sets it. A local Ollama
 * (especially CPU-only) runs one request at a time, so extra in-flight calls only wait inside Ollama,
 * where the game's priorities (player replies first) can no longer reorder them.
 */
export const OLLAMA_DEFAULT_CONCURRENCY = 1;

/** `sim.wakeUpMode`: 'hold' stops the clock at 06:00 until plans settle; 'soft' keeps it running. */
export const WAKE_UP_MODES = ['hold', 'soft'] as const;

const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/, 'expected "HH:MM"');

const llmSchema = z.object({
  provider: z.enum(PROVIDER_KINDS),
  baseUrl: z.string(),
  model: z.string().min(1, 'llm.model must not be empty'),
  apiKey: z.string(),
  apiKeyEnv: z.string(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  concurrency: z.number().int().min(1).max(64),
  jsonMode: z.boolean(),
  logFile: z.string(),
  /** Thinking on reasoning models. Unset: the provider's default, and no field is sent. */
  think: z.boolean().optional(),
  /** `reasoning_effort` the openai provider sends while `think` is false; "" sends no field. */
  reasoningEffort: z.string(),
});

const embeddingsSchema = z.object({
  provider: z.enum(EMBEDDING_PROVIDER_KINDS),
  baseUrl: z.string(),
  model: z.string(),
  apiKey: z.string(),
  apiKeyEnv: z.string(),
  concurrency: z.number().int().min(1).max(16),
});

export const configSchema = z
  .object({
    llm: llmSchema,
    embeddings: embeddingsSchema,
    sim: z.object({
      villagers: z.number().int().min(1).max(20),
      dayLengthMinutes: z.number().positive(),
      startTime: hhmm,
      speed: z.number().min(0),
      nightSpeedMultiplier: z.number().min(1),
      tickMs: z.number().int().min(10),
      seed: z.number().int(),
      /** 'hold': the clock waits at 06:00 for plans; 'soft': it runs and late plans swap in. */
      wakeUpMode: z.enum(WAKE_UP_MODES),
      /** wakeUpMode 'hold' only: real seconds the clock holds at day start; 0 disables the hold. */
      wakeUpTimeoutSec: z.number().min(0),
    }),
    cognition: z.object({
      retrievalK: z.number().int().min(1),
      retrievalWeights: z.object({
        recency: z.number().min(0),
        importance: z.number().min(0),
        relevance: z.number().min(0),
      }),
      importanceMode: z.enum(['llm', 'heuristic']),
      reflectionThreshold: z.number().positive(),
      reflectionMode: z.enum(['single', 'two-step']),
      maxConversationTurns: z.number().int().min(2).max(20),
      pairCooldownMinutes: z.number().min(0),
    }),
    events: z.object({
      ensureDaily: z.boolean(),
      maxProposalsPerDay: z.number().int().min(0),
    }),
    server: z.object({
      host: z.string(),
      port: z.number().int().min(0).max(65535),
    }),
    persistence: z.object({
      dir: z.string(),
      slot: z.string().regex(/^[\w-]+$/, 'slot may only contain letters, digits, _ and -'),
      loadOnStart: z.boolean(),
      autosaveGameMinutes: z.number().min(0),
    }),
    needs: z.object({
      enabled: z.boolean(),
      decayPerHour: z.object({
        hunger: z.number().min(0),
        energy: z.number().min(0),
        social: z.number().min(0),
        fun: z.number().min(0),
      }),
    }),
    player: z.object({
      name: z.string().min(1).max(24),
      petName: z.string().min(1).max(24),
      petSpecies: z.string().min(1),
    }),
    economy: z.object({
      startGold: z.number().int().min(0),
      eventReward: z.number().int().min(0),
      taskReward: z.number().int().min(0),
      itemRespawnGameMinutes: z.number().positive(),
    }),
    world: z.object({
      randomWeather: z.boolean(),
      llmStrangers: z.boolean(),
      /** v2: generate train visitors with the LLM (fallback: data/visitors.json). */
      llmVisitors: z.boolean(),
    }),
    // ---------- v2 (spec v2 §12) ----------
    zoo: z.object({ openTime: hhmm, closeTime: hhmm }),
    farm: z.object({
      enabled: z.boolean(),
      /** Hard cap: config can lower it, never raise it above 10. */
      capPerSpecies: z.number().int().min(1).max(10),
      breedChance: z.number().min(0).max(1),
      butcherTime: hhmm,
      butcherAtCount: z.number().int().min(1).max(10),
    }),
    train: z.object({
      enabled: z.boolean(),
      arrivals: z.array(hhmm).min(1),
      dwellMinutes: z.number().int().min(1).max(120),
    }),
    visitors: z.object({
      enabled: z.boolean(),
      min: z.number().int().min(0).max(10),
      max: z.number().int().min(0).max(10),
      stayDays: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
    }),
    hotel: z.object({ rooms: z.number().int().min(1).max(20) }),
    romance: z.object({
      enabled: z.boolean(),
      minAge: z.number().int().min(18),
      crushAffinity: z.number().min(-10).max(10),
      coupleAffinity: z.number().min(-10).max(10),
      datesForCouple: z.number().int().min(1),
      shyMinDays: z.number().int().min(0),
      shyVisitChance: z.number().min(0).max(1),
      shyMaxTurns: z.number().int().min(2).max(20),
    }),
    interiors: z.object({
      visitAffinity: z.number().min(-10).max(10),
      snoopAffinity: z.number().min(-10).max(10),
    }),
    post: z.object({
      enabled: z.boolean(),
      deliveryTimes: z.array(hhmm).min(1),
      maxVillagerLettersPerDay: z.number().int().min(0),
      noticeTtlDays: z.number().min(0),
      maxNotices: z.number().int().min(1),
      keepMax: z.number().int().min(1).max(5000),
    }),
    forest: z.object({ enabled: z.boolean() }),
    observer: z.object({
      enabled: z.boolean(),
      /** Host of the separate observer listener (only used when `port` is set). */
      host: z.string(),
      /** null = serve the observer API on the game server; a number = separate listener. */
      port: z.number().int().min(0).max(65535).nullable(),
      /** Accept non-loopback clients; only honoured when `token` is set. */
      allowRemote: z.boolean(),
      /** Bearer token required on every observer request when non-empty (env OBSERVER_TOKEN). */
      token: z.string(),
      /** Entries kept in the town event log ring buffer. */
      logSize: z.number().int().min(100).max(100_000),
    }),
    debug: z.boolean(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.visitors.min > cfg.visitors.max)
      ctx.addIssue({ code: 'custom', path: ['visitors', 'min'], message: 'must be <= visitors.max' });
    if (cfg.visitors.max > cfg.hotel.rooms)
      ctx.addIssue({ code: 'custom', path: ['visitors', 'max'], message: 'must be <= hotel.rooms' });
    if (cfg.visitors.stayDays[0] > cfg.visitors.stayDays[1])
      ctx.addIssue({
        code: 'custom',
        path: ['visitors', 'stayDays'],
        message: 'expected [min, max] with min <= max',
      });
  });

export type AppConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: AppConfig = {
  llm: {
    provider: 'ollama',
    baseUrl: '',
    model: 'qwen2.5:7b',
    apiKey: '',
    apiKeyEnv: '',
    temperature: 0.7,
    maxTokens: 512,
    timeoutMs: 120_000,
    // Hosted providers; `ollama` gets OLLAMA_DEFAULT_CONCURRENCY unless set explicitly.
    concurrency: 2,
    jsonMode: true,
    logFile: '',
    reasoningEffort: 'none',
  },
  embeddings: {
    provider: 'auto',
    baseUrl: '',
    model: 'nomic-embed-text',
    apiKey: '',
    apiKeyEnv: '',
    concurrency: 1,
  },
  sim: {
    villagers: 12,
    dayLengthMinutes: 15,
    startTime: '06:00',
    speed: 1,
    nightSpeedMultiplier: 6,
    tickMs: 100,
    seed: 42,
    wakeUpMode: 'soft',
    wakeUpTimeoutSec: 300,
  },
  cognition: {
    retrievalK: 8,
    retrievalWeights: { recency: 1, importance: 1, relevance: 1 },
    importanceMode: 'llm',
    reflectionThreshold: 60,
    reflectionMode: 'single',
    maxConversationTurns: 6,
    pairCooldownMinutes: 120,
  },
  events: { ensureDaily: true, maxProposalsPerDay: 2 },
  server: { host: '127.0.0.1', port: 3000 },
  persistence: { dir: './saves', slot: 'default', loadOnStart: true, autosaveGameMinutes: 60 },
  needs: { enabled: true, decayPerHour: { hunger: 6, energy: 4, social: 5, fun: 4 } },
  player: { name: 'You', petName: 'Pip', petSpecies: 'cat' },
  economy: { startGold: 50, eventReward: 10, taskReward: 12, itemRespawnGameMinutes: 180 },
  world: { randomWeather: false, llmStrangers: false, llmVisitors: true },
  zoo: { openTime: '08:00', closeTime: '21:00' },
  farm: { enabled: true, capPerSpecies: 10, breedChance: 0.5, butcherTime: '16:00', butcherAtCount: 8 },
  train: { enabled: true, arrivals: ['10:00', '16:00'], dwellMinutes: 20 },
  visitors: { enabled: true, min: 2, max: 4, stayDays: [1, 3] },
  hotel: { rooms: 6 },
  romance: {
    enabled: true,
    minAge: 18,
    crushAffinity: 6,
    coupleAffinity: 7,
    datesForCouple: 2,
    shyMinDays: 5,
    shyVisitChance: 0.7,
    shyMaxTurns: 3,
  },
  interiors: { visitAffinity: 1, snoopAffinity: -2 },
  post: {
    enabled: true,
    deliveryTimes: ['11:00', '17:00'],
    maxVillagerLettersPerDay: 3,
    noticeTtlDays: 3,
    maxNotices: 12,
    keepMax: 2000,
  },
  forest: { enabled: true },
  observer: { enabled: true, host: '127.0.0.1', port: null, allowRemote: false, token: '', logSize: 5000 },
  debug: false,
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type PartialConfig = DeepPartial<AppConfig>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override))
    return (override === undefined ? base : override) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

function envOverrides(env: NodeJS.ProcessEnv): PartialConfig {
  const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
  const str = (v: string | undefined) => (v === undefined || v === '' ? undefined : v);
  const bool = (v: string | undefined) =>
    v === undefined || v === '' ? undefined : /^(1|true|yes)$/i.test(v);
  return {
    llm: {
      provider: str(env.TPP_LLM_PROVIDER) as ProviderKind | undefined,
      model: str(env.TPP_LLM_MODEL),
      baseUrl: str(env.TPP_LLM_BASE_URL),
      apiKey: str(env.TPP_LLM_API_KEY),
    },
    embeddings: {
      provider: str(env.TPP_EMBED_PROVIDER) as EmbeddingProviderKind | undefined,
      model: str(env.TPP_EMBED_MODEL),
      baseUrl: str(env.TPP_EMBED_BASE_URL),
      apiKey: str(env.TPP_EMBED_API_KEY),
    },
    sim: { dayLengthMinutes: num(env.TPP_DAY_LENGTH_MINUTES), villagers: num(env.TPP_VILLAGERS) },
    server: { port: num(env.TPP_PORT) },
    observer: { port: num(env.TPP_OBSERVER_PORT), token: str(env.OBSERVER_TOKEN) },
    debug: bool(env.TPP_DEBUG),
  };
}

export class ConfigError extends Error {}

export interface LoadConfigOptions {
  /** Explicit config path; otherwise TPP_CONFIG or ./config.json (optional). */
  path?: string;
  env?: NodeJS.ProcessEnv;
  /** Extra overrides applied last (tests). */
  overrides?: PartialConfig;
  cwd?: string;
}

/** Load config: defaults <- config file <- environment <- overrides. Throws ConfigError with readable messages. */
export function loadConfig(opts: LoadConfigOptions = {}): AppConfig & { sourcePath: string | null } {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const explicit = opts.path ?? env.TPP_CONFIG;
  const path = resolve(cwd, explicit ?? 'config.json');
  let fileConfig: unknown = {};
  let sourcePath: string | null = null;
  if (existsSync(path)) {
    try {
      fileConfig = JSON.parse(readFileSync(path, 'utf8'));
      sourcePath = path;
    } catch (err) {
      throw new ConfigError(`Could not parse ${path}: ${(err as Error).message}`);
    }
  } else if (explicit) {
    throw new ConfigError(`Config file not found: ${path}`);
  }
  const envLayer = envOverrides(env);
  let merged = deepMerge(DEFAULT_CONFIG, fileConfig);
  merged = deepMerge(merged, envLayer);
  merged = deepMerge(merged, opts.overrides);
  const concurrencySet = [fileConfig, envLayer, opts.overrides].some(
    (layer) => isPlainObject(layer) && isPlainObject(layer.llm) && layer.llm.concurrency !== undefined,
  );
  if (!concurrencySet && merged.llm.provider === 'ollama') {
    merged = deepMerge(merged, { llm: { concurrency: OLLAMA_DEFAULT_CONCURRENCY } });
  }
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration${sourcePath ? ` in ${sourcePath}` : ''}:\n${issues}`);
  }
  const cfg = parsed.data;
  if (!cfg.llm.baseUrl) cfg.llm.baseUrl = DEFAULT_BASE_URLS[cfg.llm.provider];
  return { ...cfg, sourcePath };
}

/** Resolve the API key for the chat provider: literal apiKey, else the env var named by apiKeyEnv. */
export function resolveApiKey(
  section: { apiKey: string; apiKeyEnv: string },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (section.apiKey) return section.apiKey;
  if (section.apiKeyEnv) return env[section.apiKeyEnv] || undefined;
  return undefined;
}

/**
 * Resolve the effective embeddings provider. `auto` means "same provider as llm if it supports
 * embeddings" (anthropic does not -> none).
 */
export function resolveEmbeddingProvider(cfg: AppConfig): Exclude<EmbeddingProviderKind, 'auto'> {
  const p = cfg.embeddings.provider;
  if (p !== 'auto') return p;
  return cfg.llm.provider === 'anthropic' ? 'none' : cfg.llm.provider;
}

/** Copy of the config safe to log or send to clients (no secrets). */
export function redactConfig(cfg: AppConfig): AppConfig {
  const redact = (s: string) => (s ? '***' : '');
  return {
    ...cfg,
    llm: { ...cfg.llm, apiKey: redact(cfg.llm.apiKey) },
    embeddings: { ...cfg.embeddings, apiKey: redact(cfg.embeddings.apiKey) },
    observer: { ...cfg.observer, token: redact(cfg.observer.token) },
  };
}
