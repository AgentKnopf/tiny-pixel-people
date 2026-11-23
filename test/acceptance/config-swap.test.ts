/**
 * AC7: the model name and provider come from config (file or env) and reach the provider's HTTP
 * requests for all four real providers, with fetch mocked (no network). Providers that are not
 * implemented yet (WP1) are skipped.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type ProviderKind } from '../../src/server/config.ts';
import { createProviders } from '../../src/server/llm/index.ts';
import { LlmError } from '../../src/server/llm/errors.ts';
import { STRICT } from '../helpers/features.ts';

const ANSWER = '{"ok":true}';

function cannedResponse(provider: ProviderKind, url: string, model: string): unknown {
  switch (provider) {
    case 'ollama':
      if (url.endsWith('/api/tags')) return { models: [{ name: model, model }] };
      return {
        model,
        message: { role: 'assistant', content: ANSWER },
        done: true,
        prompt_eval_count: 5,
        eval_count: 3,
      };
    case 'openai':
      if (url.endsWith('/models')) return { data: [{ id: model }] };
      return {
        model,
        choices: [{ message: { role: 'assistant', content: ANSWER } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      };
    case 'anthropic':
      return {
        model,
        content: [{ type: 'text', text: ANSWER }],
        usage: { input_tokens: 5, output_tokens: 3 },
      };
    case 'gemini':
      return {
        candidates: [{ content: { role: 'model', parts: [{ text: ANSWER }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      };
    case 'mock':
      return {};
  }
}

interface Captured {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function stubFetch(provider: ProviderKind, model: string): Captured[] {
  const captured: Captured[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    captured.push({ url, body: typeof init?.body === 'string' ? init.body : '', headers });
    return new Response(JSON.stringify(cannedResponse(provider, url, model)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const REAL: ProviderKind[] = ['ollama', 'openai', 'anthropic', 'gemini'];

describe('AC7: swapping provider/model is config-only', () => {
  for (const provider of REAL) {
    for (const source of ['file', 'env'] as const) {
      it(`${provider}: llm.model from ${source} reaches the request`, async (ctx) => {
        const model = `swap-${provider}-${source}-model`;
        const dir = mkdtempSync(join(tmpdir(), 'tpp-swap-'));
        let cfg;
        if (source === 'file') {
          writeFileSync(
            join(dir, 'config.json'),
            JSON.stringify({
              llm: { provider, model, apiKey: 'test-key' },
              embeddings: { provider: 'none' },
            }),
          );
          cfg = loadConfig({ env: {}, cwd: dir });
        } else {
          cfg = loadConfig({
            env: {
              TPP_LLM_PROVIDER: provider,
              TPP_LLM_MODEL: model,
              TPP_LLM_API_KEY: 'test-key',
              TPP_EMBED_PROVIDER: 'none',
            },
            cwd: dir,
          });
        }
        expect(cfg.llm.provider).toBe(provider);
        expect(cfg.llm.model).toBe(model);
        let providers;
        try {
          providers = createProviders(cfg);
        } catch (err) {
          if (
            !STRICT &&
            err instanceof LlmError &&
            err.kind === 'config' &&
            /not implemented/i.test(err.message)
          ) {
            ctx.skip();
            return;
          }
          throw err;
        }
        expect(providers.chat.kind).toBe(provider);
        expect(providers.chat.model).toBe(model);
        const captured = stubFetch(provider, model);
        const res = await providers.chat.chat({
          task: 'health',
          messages: [
            { role: 'system', content: 'Answer in JSON.' },
            { role: 'user', content: 'Say ok.' },
          ],
          json: true,
          meta: { secret: 'never-sent' },
        });
        expect(res.text).toContain('ok');
        expect(captured.length).toBeGreaterThanOrEqual(1);
        const req = captured.at(-1)!;
        expect(req.url.includes(model) || req.body.includes(`"${model}"`)).toBe(true);
        expect(req.body).not.toContain('never-sent');
        expect(JSON.stringify(req.headers)).toContain('test-key');
      });
    }
  }

  it('mock: model name from config is reported by the provider', async () => {
    const cfg = loadConfig({
      env: { TPP_LLM_PROVIDER: 'mock', TPP_LLM_MODEL: 'mock-swapped' },
      cwd: tmpdir(),
    });
    const { chat } = createProviders(cfg);
    expect(chat.model).toBe('mock-swapped');
    expect((await chat.chat({ task: 'health', messages: [] })).model).toBe('mock-swapped');
  });
});
