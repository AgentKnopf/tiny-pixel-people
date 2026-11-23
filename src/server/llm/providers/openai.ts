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

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/**
 * OpenAI-compatible chat completions (OpenAI, LM Studio, vLLM, llama.cpp server, OpenRouter, Groq…).
 * Servers differ in which parameters they accept, so a 400 that names `response_format`,
 * `max_tokens` or `temperature` triggers one adapted retry, and the adaptation is remembered.
 */
export class OpenAiChatProvider implements ChatProvider {
  readonly kind = 'openai' as const;
  readonly model: string;
  private useResponseFormat: boolean;
  private tokenParam: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';
  private sendTemperature = true;

  constructor(private readonly opts: ProviderOptions) {
    this.model = opts.model;
    this.useResponseFormat = opts.jsonMode !== false;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    let res: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await requestJson(joinUrl(this.opts.baseUrl, '/chat/completions'), this.body(req), {
          label: 'openai',
          headers: authHeaders(this.opts.apiKey),
          timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: req.signal,
          fetch: this.opts.fetch,
        });
        break;
      } catch (err) {
        if (attempt < 3 && this.adaptTo(err, req)) continue;
        throw err;
      }
    }
    const choice = isRecord(res) && Array.isArray(res.choices) ? res.choices[0] : undefined;
    const message = isRecord(choice) ? choice.message : undefined;
    const text = isRecord(message) ? message.content : undefined;
    if (typeof text !== 'string')
      throw new LlmError('parse', 'openai: response has no choices[0].message.content');
    const usage = isRecord(res) && isRecord(res.usage) ? res.usage : {};
    return {
      text,
      model: isRecord(res) && typeof res.model === 'string' ? res.model : this.model,
      usage: tokensPart(usage.prompt_tokens, usage.completion_tokens),
      latencyMs: Date.now() - started,
    };
  }

  private body(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: withJsonHint(req).map((m) => ({ role: m.role, content: m.content })),
      [this.tokenParam]: req.maxTokens ?? this.opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (this.sendTemperature) body.temperature = req.temperature ?? this.opts.temperature ?? 0.7;
    if (req.json && this.useResponseFormat) body.response_format = { type: 'json_object' };
    return body;
  }

  /** Returns true when the error shows an unsupported parameter we can drop or rename. */
  private adaptTo(err: unknown, req: ChatRequest): boolean {
    if (!(err instanceof LlmError) || err.status !== 400) return false;
    const msg = err.message.toLowerCase();
    if (req.json && this.useResponseFormat && msg.includes('response_format')) {
      this.useResponseFormat = false;
      return true;
    }
    if (this.tokenParam === 'max_tokens' && msg.includes('max_tokens')) {
      this.tokenParam = 'max_completion_tokens';
      return true;
    }
    if (this.sendTemperature && msg.includes('temperature')) {
      this.sendTemperature = false;
      return true;
    }
    return false;
  }

  async health(): Promise<HealthResult> {
    try {
      const res = await requestJson(joinUrl(this.opts.baseUrl, '/models'), undefined, {
        label: 'openai',
        headers: authHeaders(this.opts.apiKey),
        timeoutMs: healthTimeout(this.opts),
        fetch: this.opts.fetch,
      });
      const ids =
        isRecord(res) && Array.isArray(res.data)
          ? res.data.flatMap((m) => (isRecord(m) && typeof m.id === 'string' ? [m.id] : []))
          : [];
      // Local servers often list one loaded model under a different name, so a missing id is a hint, not a failure.
      const listed = ids.length === 0 || ids.includes(this.model);
      return {
        ok: true,
        message: `OpenAI-compatible server at ${this.opts.baseUrl}, model ${this.model}${listed ? '' : ' (not in the server model list; check llm.model)'}`,
      };
    } catch (err) {
      const e = err as LlmError;
      if (e.status === 401 || e.status === 403)
        return { ok: false, message: `${e.message}. Check llm.apiKey / llm.apiKeyEnv` };
      // Some compatible servers do not implement /models; reachability is what matters.
      if (e.kind === 'http' && e.status === 404)
        return { ok: true, message: `OpenAI-compatible server at ${this.opts.baseUrl}, model ${this.model}` };
      return { ok: false, message: e.message };
    }
  }
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'openai' as const;
  readonly model: string;

  constructor(private readonly opts: ProviderOptions) {
    this.model = opts.model;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await requestJson(
      joinUrl(this.opts.baseUrl, '/embeddings'),
      { model: this.model, input: texts },
      {
        label: 'openai embed',
        headers: authHeaders(this.opts.apiKey),
        timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal,
        fetch: this.opts.fetch,
      },
    );
    const data = isRecord(res) && Array.isArray(res.data) ? res.data : undefined;
    const rows = data
      ?.filter(isRecord)
      .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0))
      .map((d) => d.embedding);
    return asVectors(rows, 'openai embed', texts.length);
  }
}
