import { LlmError } from '../errors.ts';
import { isRecord, joinUrl, requestJson } from '../http.ts';
import type { ChatProvider, ChatRequest, ChatResponse, HealthResult } from '../types.ts';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  healthTimeout,
  splitSystem,
  tokensPart,
  withJsonHint,
  type ProviderOptions,
} from './common.ts';

export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Native Anthropic Messages API. There is no JSON mode: JSON requests get a system instruction
 * and callers parse with `parseJsonLoose`. Anthropic has no embeddings endpoint.
 */
export class AnthropicChatProvider implements ChatProvider {
  readonly kind = 'anthropic' as const;
  readonly model: string;

  constructor(private readonly opts: ProviderOptions) {
    this.model = opts.model;
  }

  private headers(): Record<string, string> {
    if (!this.opts.apiKey)
      throw new LlmError(
        'config',
        'anthropic: no API key; set llm.apiKeyEnv (e.g. ANTHROPIC_API_KEY) or llm.apiKey',
      );
    return { 'x-api-key': this.opts.apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const { system, turns } = splitSystem(withJsonHint(req));
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: turns,
      // Anthropic accepts 0..1; the shared config allows up to 2.
      temperature: Math.min(1, req.temperature ?? this.opts.temperature ?? 0.7),
    };
    if (system) body.system = system;
    const res = await requestJson(joinUrl(this.opts.baseUrl, '/v1/messages'), body, {
      label: 'anthropic',
      headers: this.headers(),
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: req.signal,
      fetch: this.opts.fetch,
    });
    const content = isRecord(res) && Array.isArray(res.content) ? res.content : undefined;
    if (!content) throw new LlmError('parse', 'anthropic: response has no content array');
    const text = content
      .filter((b) => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
      .map((b) => (b as { text: string }).text)
      .join('');
    const usage = isRecord(res) && isRecord(res.usage) ? res.usage : {};
    return {
      text,
      model: isRecord(res) && typeof res.model === 'string' ? res.model : this.model,
      usage: tokensPart(usage.input_tokens, usage.output_tokens),
      latencyMs: Date.now() - started,
    };
  }

  async health(): Promise<HealthResult> {
    try {
      await requestJson(
        joinUrl(this.opts.baseUrl, `/v1/models/${encodeURIComponent(this.model)}`),
        undefined,
        {
          label: 'anthropic',
          headers: this.headers(),
          timeoutMs: healthTimeout(this.opts),
          fetch: this.opts.fetch,
        },
      );
      return { ok: true, message: `anthropic model ${this.model} available` };
    } catch (err) {
      const e = err as LlmError;
      if (e.status === 404)
        return { ok: false, message: `anthropic: unknown model ${this.model}; check llm.model` };
      if (e.status === 401 || e.status === 403)
        return { ok: false, message: `${e.message}. Check llm.apiKey / llm.apiKeyEnv` };
      return { ok: false, message: e.message };
    }
  }
}
