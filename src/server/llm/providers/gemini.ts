import { LlmError } from '../errors.ts';
import { asVectors, isRecord, joinUrl, requestJson } from '../http.ts';
import type { ChatProvider, ChatRequest, ChatResponse, EmbeddingProvider, HealthResult } from '../types.ts';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  healthTimeout,
  splitSystem,
  tokensPart,
  withJsonHint,
  type ProviderOptions,
} from './common.ts';

/** Accept both `gemini-2.5-flash` and `models/gemini-2.5-flash`. */
function modelId(model: string): string {
  return model.replace(/^models\//, '');
}

function geminiHeaders(opts: ProviderOptions): Record<string, string> {
  if (!opts.apiKey)
    throw new LlmError('config', 'gemini: no API key; set llm.apiKeyEnv (e.g. GEMINI_API_KEY) or llm.apiKey');
  return { 'x-goog-api-key': opts.apiKey };
}

async function geminiModelHealth(opts: ProviderOptions, model: string): Promise<HealthResult> {
  try {
    await requestJson(joinUrl(opts.baseUrl, `/models/${modelId(model)}`), undefined, {
      label: 'gemini',
      headers: geminiHeaders(opts),
      timeoutMs: healthTimeout(opts),
      fetch: opts.fetch,
    });
    return { ok: true, message: `gemini model ${modelId(model)} available` };
  } catch (err) {
    const e = err as LlmError;
    if (e.status === 404)
      return { ok: false, message: `gemini: unknown model ${model}; check the model name` };
    if (e.status === 400 || e.status === 401 || e.status === 403)
      return { ok: false, message: `${e.message}. Check the API key` };
    return { ok: false, message: e.message };
  }
}

/** Native Gemini `generateContent`. JSON mode maps to `responseMimeType: application/json`. */
export class GeminiChatProvider implements ChatProvider {
  readonly kind = 'gemini' as const;
  readonly model: string;

  constructor(private readonly opts: ProviderOptions) {
    this.model = opts.model;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const { system, turns } = splitSystem(withJsonHint(req));
    const generationConfig: Record<string, unknown> = {
      temperature: req.temperature ?? this.opts.temperature ?? 0.7,
      maxOutputTokens: req.maxTokens ?? this.opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (req.json && this.opts.jsonMode !== false) generationConfig.responseMimeType = 'application/json';
    const body: Record<string, unknown> = {
      contents: turns.map((t) => ({
        role: t.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: t.content }],
      })),
      generationConfig,
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const res = await requestJson(
      joinUrl(this.opts.baseUrl, `/models/${modelId(this.model)}:generateContent`),
      body,
      {
        label: 'gemini',
        headers: geminiHeaders(this.opts),
        timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: req.signal,
        fetch: this.opts.fetch,
      },
    );
    const candidate = isRecord(res) && Array.isArray(res.candidates) ? res.candidates[0] : undefined;
    if (!isRecord(candidate)) {
      const feedback =
        isRecord(res) && isRecord(res.promptFeedback) ? res.promptFeedback.blockReason : undefined;
      throw new LlmError(
        'parse',
        `gemini: no candidates in response${feedback ? ` (blocked: ${String(feedback)})` : ''}`,
      );
    }
    const parts =
      isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    // Thinking models return thought summaries as parts flagged `thought: true`.
    const text = parts
      .filter((p) => isRecord(p) && typeof p.text === 'string' && p.thought !== true)
      .map((p) => (p as { text: string }).text)
      .join('');
    if (!text && candidate.finishReason && candidate.finishReason !== 'STOP')
      throw new LlmError('parse', `gemini: empty answer (finishReason ${String(candidate.finishReason)})`);
    const usage = isRecord(res) && isRecord(res.usageMetadata) ? res.usageMetadata : {};
    return {
      text,
      model: isRecord(res) && typeof res.modelVersion === 'string' ? res.modelVersion : this.model,
      usage: tokensPart(usage.promptTokenCount, usage.candidatesTokenCount),
      latencyMs: Date.now() - started,
    };
  }

  health(): Promise<HealthResult> {
    return geminiModelHealth(this.opts, this.model);
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'gemini' as const;
  readonly model: string;

  constructor(private readonly opts: ProviderOptions) {
    this.model = opts.model;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const id = modelId(this.model);
    const res = await requestJson(
      joinUrl(this.opts.baseUrl, `/models/${id}:batchEmbedContents`),
      { requests: texts.map((text) => ({ model: `models/${id}`, content: { parts: [{ text }] } })) },
      {
        label: 'gemini embed',
        headers: geminiHeaders(this.opts),
        timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal,
        fetch: this.opts.fetch,
      },
    );
    const rows =
      isRecord(res) && Array.isArray(res.embeddings)
        ? res.embeddings.map((e) => (isRecord(e) ? e.values : undefined))
        : undefined;
    return asVectors(rows, 'gemini embed', texts.length);
  }

  health(): Promise<HealthResult> {
    return geminiModelHealth(this.opts, this.model);
  }
}
