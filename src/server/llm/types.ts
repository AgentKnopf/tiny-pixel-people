/**
 * LLM provider abstraction. See specs/technical-spec.md §8.
 * Owned by WP1 (providers, queue); `mock` provider owned by WP6.
 */
import type { QueueStats } from '../../shared/protocol.ts';
import type { ProviderKind } from '../config.ts';

export type { ProviderKind };

export type LlmTask =
  | 'importance.rate'
  | 'plan.day'
  | 'plan.revise'
  | 'convo.turn'
  | 'convo.summarize'
  | 'reflect'
  | 'reflect.questions'
  | 'event.propose'
  | 'event.decide'
  | 'note.reply'
  | 'day.summarize'
  | 'player.reply'
  | 'task.decide'
  | 'stranger.create'
  | 'health';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  /** Used by the queue (priority, stats) and by the mock provider. */
  task: LlmTask;
  messages: ChatMessage[];
  /** Ask the provider for JSON output where supported. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Structured context for the mock provider and logs. Never sent to real providers. */
  meta?: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs: number;
}

export interface HealthResult {
  ok: boolean;
  /** Human-readable status, e.g. 'model qwen2.5:7b not pulled; run: ollama pull qwen2.5:7b'. */
  message: string;
}

export interface ChatProvider {
  readonly kind: ProviderKind;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  health(): Promise<HealthResult>;
}

export interface EmbeddingProvider {
  readonly kind: ProviderKind;
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface Providers {
  chat: ChatProvider;
  /** null => keyword retrieval fallback. */
  embeddings: EmbeddingProvider | null;
}

/** Queue priorities, higher runs first. */
export const TASK_PRIORITY: Record<LlmTask, number> = {
  'player.reply': 110,
  'task.decide': 85,
  'stranger.create': 75,
  'convo.turn': 100,
  'note.reply': 90,
  'event.decide': 80,
  'plan.day': 70,
  'plan.revise': 70,
  'convo.summarize': 60,
  reflect: 50,
  'reflect.questions': 50,
  'event.propose': 40,
  'importance.rate': 30,
  'day.summarize': 20,
  health: 100,
};

export interface EnqueueOptions {
  priority?: number;
  /** Coalesce duplicate jobs (e.g. `plan:ada:day3`). */
  dedupeKey?: string;
  /** Drop the job if it has not started by this game time. */
  expiresAt?: number;
}

/** Contract for src/server/llm/queue.ts (WP1). */
export interface LlmQueue {
  enqueue(req: ChatRequest, opts?: EnqueueOptions): Promise<ChatResponse>;
  embed(texts: string[]): Promise<number[][] | null>;
  /** Resolves when no job is queued or running (used by the virtual-clock test harness). */
  drain(): Promise<void>;
  stats(): QueueStats;
}
