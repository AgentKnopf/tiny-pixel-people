import {
  DEFAULT_BASE_URLS,
  resolveApiKey,
  resolveEmbeddingProvider,
  type AppConfig,
  type ProviderKind,
} from '../config.ts';
import { LlmError } from './errors.ts';
import type { FetchLike } from './http.ts';
import { AnthropicChatProvider } from './providers/anthropic.ts';
import type { ProviderOptions } from './providers/common.ts';
import { GeminiChatProvider, GeminiEmbeddingProvider } from './providers/gemini.ts';
import { MockChatProvider, MockEmbeddingProvider } from './providers/mock.ts';
import { OllamaChatProvider, OllamaEmbeddingProvider } from './providers/ollama.ts';
import { OpenAiChatProvider, OpenAiEmbeddingProvider } from './providers/openai.ts';
import type { PriorityLlmQueue } from './queue.ts';
import type { ChatProvider, EmbeddingProvider, HealthResult, Providers } from './types.ts';

export { LlmError } from './errors.ts';
export { askJson, askJsonDetailed, parseJsonLoose } from './json.ts';
export { PriorityLlmQueue, createLlmQueue, type LlmQueueOptions } from './queue.ts';

export interface CreateProvidersOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. */
  fetch?: FetchLike;
}

const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
/** Used when `embeddings.model` is left at the Ollama default for a provider that lacks it. */
const PROVIDER_EMBED_MODELS: Partial<Record<ProviderKind, string>> = {
  openai: 'text-embedding-3-small',
  gemini: 'gemini-embedding-001',
};

function isOfficialOpenAi(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

/**
 * Conventional key variables, used when neither apiKey nor apiKeyEnv is set. OPENAI_API_KEY is
 * only used for api.openai.com so the key is never sent to a custom OpenAI-compatible server.
 */
function conventionalKey(kind: ProviderKind, baseUrl: string, env: NodeJS.ProcessEnv): string | undefined {
  switch (kind) {
    case 'anthropic':
      return env.ANTHROPIC_API_KEY || undefined;
    case 'gemini':
      return env.GEMINI_API_KEY || env.GOOGLE_API_KEY || undefined;
    case 'openai':
      return isOfficialOpenAi(baseUrl) ? env.OPENAI_API_KEY || undefined : undefined;
    default:
      return undefined;
  }
}

function chatOptions(cfg: AppConfig, opts: CreateProvidersOptions): ProviderOptions {
  const env = opts.env ?? process.env;
  const kind = cfg.llm.provider;
  const baseUrl = cfg.llm.baseUrl || DEFAULT_BASE_URLS[kind];
  return {
    baseUrl,
    model: cfg.llm.model,
    apiKey: resolveApiKey(cfg.llm, env) ?? conventionalKey(kind, baseUrl, env),
    temperature: cfg.llm.temperature,
    maxTokens: cfg.llm.maxTokens,
    timeoutMs: cfg.llm.timeoutMs,
    jsonMode: cfg.llm.jsonMode,
    think: cfg.llm.think,
    reasoningEffort: cfg.llm.reasoningEffort,
    fetch: opts.fetch,
  };
}

function embeddingOptions(
  cfg: AppConfig,
  kind: ProviderKind,
  chat: ProviderOptions,
  opts: CreateProvidersOptions,
): ProviderOptions {
  const env = opts.env ?? process.env;
  const sameAsChat = kind === cfg.llm.provider;
  const baseUrl = cfg.embeddings.baseUrl || (sameAsChat ? chat.baseUrl : DEFAULT_BASE_URLS[kind]);
  const sameEndpoint = sameAsChat && baseUrl === chat.baseUrl;
  let model = cfg.embeddings.model || DEFAULT_EMBED_MODEL;
  const swap = PROVIDER_EMBED_MODELS[kind];
  if (model === DEFAULT_EMBED_MODEL && swap && (kind === 'gemini' || isOfficialOpenAi(baseUrl))) model = swap;
  return {
    baseUrl,
    model,
    apiKey:
      resolveApiKey(cfg.embeddings, env) ??
      (sameEndpoint ? chat.apiKey : undefined) ??
      conventionalKey(kind, baseUrl, env),
    timeoutMs: cfg.llm.timeoutMs,
    fetch: opts.fetch,
  };
}

/**
 * Build chat + embedding providers from config. Switching provider or model is config-only.
 * `embeddings: null` means keyword retrieval.
 */
export function createProviders(cfg: AppConfig, opts: CreateProvidersOptions = {}): Providers {
  const chatOpts = chatOptions(cfg, opts);
  const chat: ChatProvider = (() => {
    switch (cfg.llm.provider) {
      case 'mock':
        return new MockChatProvider(cfg.llm.model);
      case 'ollama':
        return new OllamaChatProvider(chatOpts);
      case 'openai':
        return new OpenAiChatProvider(chatOpts);
      case 'anthropic':
        return new AnthropicChatProvider(chatOpts);
      case 'gemini':
        return new GeminiChatProvider(chatOpts);
    }
  })();
  const embedKind = resolveEmbeddingProvider(cfg);
  const embeddings: EmbeddingProvider | null = (() => {
    switch (embedKind) {
      case 'none':
        return null;
      case 'mock':
        return new MockEmbeddingProvider(cfg.embeddings.model || 'mock-embed');
      case 'ollama':
        return new OllamaEmbeddingProvider(embeddingOptions(cfg, embedKind, chatOpts, opts));
      case 'openai':
        return new OpenAiEmbeddingProvider(embeddingOptions(cfg, embedKind, chatOpts, opts));
      case 'gemini':
        return new GeminiEmbeddingProvider(embeddingOptions(cfg, embedKind, chatOpts, opts));
      default:
        throw new LlmError('config', `Unknown embeddings provider "${String(embedKind)}"`);
    }
  })();
  return { chat, embeddings };
}

export interface LlmHealth {
  chat: HealthResult;
  /** null when embeddings are off (keyword retrieval). */
  embeddings: HealthResult | null;
}

/** Health of an embeddings provider: its own check if it has one, else a one-text probe. */
export async function embeddingsHealth(provider: EmbeddingProvider): Promise<HealthResult> {
  const withHealth = provider as EmbeddingProvider & { health?: () => Promise<HealthResult> };
  if (typeof withHealth.health === 'function') return withHealth.health();
  try {
    const [v] = await provider.embed(['health check']);
    return {
      ok: true,
      message: `embeddings ${provider.kind}/${provider.model} ready (${v?.length ?? 0} dims)`,
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/**
 * Startup check (never throws). With a queue, it seeds the online flag and switches retrieval to
 * keywords when the embedding model is unusable (e.g. `nomic-embed-text` not pulled).
 */
export async function checkLlmHealth(providers: Providers, queue?: PriorityLlmQueue): Promise<LlmHealth> {
  const safe = (p: Promise<HealthResult>) =>
    p.catch((err: unknown): HealthResult => ({ ok: false, message: (err as Error).message }));
  const [chat, embeddings] = await Promise.all([
    safe(providers.chat.health()),
    providers.embeddings ? safe(embeddingsHealth(providers.embeddings)) : Promise.resolve(null),
  ]);
  if (queue) {
    queue.setOnline(chat.ok);
    if (embeddings && !embeddings.ok) queue.disableEmbeddings(embeddings.message);
  }
  return { chat, embeddings };
}
