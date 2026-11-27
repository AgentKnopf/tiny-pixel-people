import type { FetchLike } from '../http.ts';
import type { ChatMessage, ChatRequest } from '../types.ts';

export interface ProviderOptions {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  /** Defaults used when the request does not set them. */
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Use the provider's native JSON mode when a request sets `json: true`. */
  jsonMode?: boolean;
  /** Ollama: sent as top-level `think` when set. Other providers ignore it. */
  think?: boolean;
  /** OpenAI-compatible: sent as `reasoning_effort` when `think` is false and this is not "". */
  reasoningEffort?: string;
  /** Injected for tests. */
  fetch?: FetchLike;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_TOKENS = 512;
const HEALTH_TIMEOUT_MS = 10_000;

export function healthTimeout(opts: ProviderOptions): number {
  return Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, HEALTH_TIMEOUT_MS);
}

const JSON_HINT = 'Respond with a single valid JSON object only, no prose and no code fences.';

/**
 * Make sure a JSON request tells the model it must answer in JSON. Native JSON modes still need
 * this (OpenAI rejects `json_object` unless a message mentions JSON, and small models drift).
 */
export function withJsonHint(req: ChatRequest): ChatMessage[] {
  if (!req.json) return req.messages;
  if (req.messages.some((m) => /json/i.test(m.content))) return req.messages;
  const idx = req.messages.findIndex((m) => m.role === 'system');
  if (idx < 0) return [{ role: 'system', content: JSON_HINT }, ...req.messages];
  return req.messages.map((m, i) => (i === idx ? { ...m, content: `${m.content}\n\n${JSON_HINT}` } : m));
}

/** Split system messages out (Anthropic, Gemini) and merge consecutive same-role turns. */
export function splitSystem(messages: ChatMessage[]): {
  system: string;
  turns: { role: 'user' | 'assistant'; content: string }[];
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const turns: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else turns.push({ role: m.role, content: m.content });
  }
  // Both APIs require the conversation to start with a user turn.
  if (turns.length === 0 || turns[0]?.role !== 'user') turns.unshift({ role: 'user', content: '(begin)' });
  return { system, turns };
}

export function tokensPart(
  input: unknown,
  output: unknown,
): { inputTokens?: number; outputTokens?: number } | undefined {
  const usage: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof input === 'number') usage.inputTokens = input;
  if (typeof output === 'number') usage.outputTokens = output;
  return usage.inputTokens === undefined && usage.outputTokens === undefined ? undefined : usage;
}
