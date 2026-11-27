import { LlmError } from '../errors.ts';
import { asVectors, isRecord, joinUrl, requestJson } from '../http.ts';
import type { ChatProvider, ChatRequest, ChatResponse, EmbeddingProvider, HealthResult } from '../types.ts';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  healthTimeout,
  tokensPart,
  withJsonHint,
  type ProviderOptions,
} from './common.ts';

/** Ollama treats `name` and `name:latest` as the same model. */
export function sameOllamaModel(a: string, b: string): boolean {
  const norm = (s: string) => (s.includes(':') ? s : `${s}:latest`);
  return norm(a) === norm(b);
}

/** Ollama has no auth; remote instances behind a proxy (or hosted Ollama) take a Bearer key. */
function ollamaAuth(opts: ProviderOptions): Record<string, string> {
  return opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {};
}

/** Check that Ollama is reachable and `model` is pulled (`GET /api/tags`). */
export async function ollamaModelHealth(opts: ProviderOptions, model: string): Promise<HealthResult> {
  try {
    const res = await requestJson(joinUrl(opts.baseUrl, '/api/tags'), undefined, {
      label: 'ollama',
      headers: ollamaAuth(opts),
      timeoutMs: healthTimeout(opts),
      fetch: opts.fetch,
    });
    const models = isRecord(res) && Array.isArray(res.models) ? res.models : [];
    const names = models.flatMap((m) =>
      isRecord(m) ? [m.name, m.model].filter((n): n is string => typeof n === 'string') : [],
    );
    if (!names.some((n) => sameOllamaModel(n, model)))
      return { ok: false, message: `model ${model} not pulled; run: ollama pull ${model}` };
    return { ok: true, message: `ollama at ${opts.baseUrl}, model ${model} ready` };
  } catch (err) {
    return {
      ok: false,
      message: `${(err as Error).message}. Is Ollama running? Start it with: ollama serve`,
    };
  }
}

export class OllamaChatProvider implements ChatProvider {
  readonly kind = 'ollama' as const;
  readonly model: string;

  constructor(private readonly opts: ProviderOptions) {
    this.model = opts.model;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.model,
      messages: withJsonHint(req).map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      options: {
        temperature: req.temperature ?? this.opts.temperature ?? 0.7,
        num_predict: req.maxTokens ?? this.opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      },
      keep_alive: '30m',
    };
    if (req.json && this.opts.jsonMode !== false) body.format = 'json';
    if (this.opts.think !== undefined) body.think = this.opts.think;
    const res = await requestJson(joinUrl(this.opts.baseUrl, '/api/chat'), body, {
      label: 'ollama',
      headers: ollamaAuth(this.opts),
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: req.signal,
      fetch: this.opts.fetch,
    });
    const message = isRecord(res) ? res.message : undefined;
    const text = isRecord(message) ? message.content : undefined;
    if (typeof text !== 'string') throw new LlmError('parse', 'ollama: response has no message.content');
    return {
      text,
      model: isRecord(res) && typeof res.model === 'string' ? res.model : this.model,
      usage: isRecord(res) ? tokensPart(res.prompt_eval_count, res.eval_count) : undefined,
      latencyMs: Date.now() - started,
    };
  }

  health(): Promise<HealthResult> {
    return ollamaModelHealth(this.opts, this.model);
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'ollama' as const;
  readonly model: string;

  constructor(private readonly opts: ProviderOptions) {
    this.model = opts.model;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await requestJson(
      joinUrl(this.opts.baseUrl, '/api/embed'),
      { model: this.model, input: texts },
      {
        label: 'ollama embed',
        headers: ollamaAuth(this.opts),
        timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal,
        fetch: this.opts.fetch,
      },
    );
    return asVectors(isRecord(res) ? res.embeddings : undefined, 'ollama embed', texts.length);
  }

  health(): Promise<HealthResult> {
    return ollamaModelHealth(this.opts, this.model);
  }
}
