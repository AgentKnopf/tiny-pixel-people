import { afterEach, describe, expect, it } from 'vitest';
import { LlmError } from '../../../src/server/llm/errors.ts';
import { AnthropicChatProvider } from '../../../src/server/llm/providers/anthropic.ts';
import { GeminiChatProvider, GeminiEmbeddingProvider } from '../../../src/server/llm/providers/gemini.ts';
import { OllamaChatProvider, OllamaEmbeddingProvider } from '../../../src/server/llm/providers/ollama.ts';
import { OpenAiChatProvider, OpenAiEmbeddingProvider } from '../../../src/server/llm/providers/openai.ts';
import type { ChatRequest } from '../../../src/server/llm/types.ts';
import { startFakeServer, type FakeHandler, type FakeServer } from './fake-server.ts';

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function fake(handler: FakeHandler): Promise<FakeServer> {
  server = await startFakeServer(handler);
  return server;
}

const jsonReq: ChatRequest = {
  task: 'plan.day',
  json: true,
  temperature: 0.3,
  maxTokens: 200,
  messages: [
    { role: 'system', content: 'You are Ada, the baker. Answer in JSON.' },
    { role: 'user', content: 'Plan your day.' },
  ],
  meta: { secret: 'never sent' },
};

describe('ollama provider', () => {
  it('sends /api/chat with model, format json, options and keep_alive', async () => {
    const s = await fake(() => ({
      body: {
        model: 'qwen2.5:7b',
        message: { role: 'assistant', content: '{"ok":true}' },
        prompt_eval_count: 12,
        eval_count: 5,
      },
    }));
    const p = new OllamaChatProvider({ baseUrl: s.url, model: 'qwen2.5:7b' });
    const res = await p.chat(jsonReq);
    expect(res).toMatchObject({
      text: '{"ok":true}',
      model: 'qwen2.5:7b',
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    const r = s.requests[0]!;
    expect(r.method).toBe('POST');
    expect(r.path).toBe('/api/chat');
    expect(r.body).toEqual({
      model: 'qwen2.5:7b',
      messages: jsonReq.messages,
      stream: false,
      format: 'json',
      options: { temperature: 0.3, num_predict: 200 },
      keep_alive: '30m',
    });
    expect(JSON.stringify(r.body)).not.toContain('never sent');
  });

  it('omits format when jsonMode is off and uses provider defaults', async () => {
    const s = await fake(() => ({ body: { message: { content: 'hi' } } }));
    const p = new OllamaChatProvider({
      baseUrl: s.url,
      model: 'm',
      jsonMode: false,
      temperature: 0.9,
      maxTokens: 64,
    });
    await p.chat({ ...jsonReq, temperature: undefined, maxTokens: undefined });
    expect(s.requests[0]!.body.format).toBeUndefined();
    expect(s.requests[0]!.body.options).toEqual({ temperature: 0.9, num_predict: 64 });
  });

  it('embeds through /api/embed', async () => {
    const s = await fake(() => ({
      body: {
        embeddings: [
          [1, 0],
          [0, 1],
        ],
      },
    }));
    const e = new OllamaEmbeddingProvider({ baseUrl: s.url, model: 'nomic-embed-text' });
    expect(await e.embed(['a', 'b'])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(s.requests[0]).toMatchObject({
      path: '/api/embed',
      body: { model: 'nomic-embed-text', input: ['a', 'b'] },
    });
  });

  it('health checks /api/tags and suggests ollama pull', async () => {
    const s = await fake(() => ({ body: { models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5:7b' }] } }));
    expect((await new OllamaChatProvider({ baseUrl: s.url, model: 'llama3.2' }).health()).ok).toBe(true);
    expect((await new OllamaChatProvider({ baseUrl: s.url, model: 'qwen2.5:7b' }).health()).ok).toBe(true);
    const missing = await new OllamaChatProvider({ baseUrl: s.url, model: 'gemma3:4b' }).health();
    expect(missing).toEqual({ ok: false, message: 'model gemma3:4b not pulled; run: ollama pull gemma3:4b' });
    expect(s.requests[0]).toMatchObject({ method: 'GET', path: '/api/tags' });
  });

  it('reports an unreachable server as a network error', async () => {
    const s = await fake(() => ({}));
    const url = s.url;
    await s.close();
    server = undefined;
    const p = new OllamaChatProvider({ baseUrl: url, model: 'm' });
    const err = await p.chat(jsonReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ kind: 'network', retryable: true });
    const h = await p.health();
    expect(h.ok).toBe(false);
    expect(h.message).toContain('ollama serve');
  });
});

describe('openai-compatible provider', () => {
  const reply = {
    body: {
      model: 'gpt-4o-mini',
      choices: [{ message: { content: '{"a":1}' } }],
      usage: { prompt_tokens: 9, completion_tokens: 3 },
    },
  };

  it('posts chat/completions with bearer auth, max_tokens and response_format', async () => {
    const s = await fake(() => reply);
    const p = new OpenAiChatProvider({ baseUrl: `${s.url}/v1`, model: 'gpt-4o-mini', apiKey: 'sk-test' });
    const res = await p.chat(jsonReq);
    expect(res).toMatchObject({ text: '{"a":1}', usage: { inputTokens: 9, outputTokens: 3 } });
    const r = s.requests[0]!;
    expect(r.path).toBe('/v1/chat/completions');
    expect(r.headers.authorization).toBe('Bearer sk-test');
    expect(r.body).toEqual({
      model: 'gpt-4o-mini',
      messages: jsonReq.messages,
      max_tokens: 200,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });
  });

  it('sends no auth header without a key and no response_format when jsonMode is off', async () => {
    const s = await fake(() => reply);
    await new OpenAiChatProvider({ baseUrl: `${s.url}/v1/`, model: 'local', jsonMode: false }).chat(jsonReq);
    expect(s.requests[0]!.headers.authorization).toBeUndefined();
    expect(s.requests[0]!.body.response_format).toBeUndefined();
    expect(s.requests[0]!.path).toBe('/v1/chat/completions');
  });

  it('adds a JSON hint when no message mentions JSON', async () => {
    const s = await fake(() => reply);
    await new OpenAiChatProvider({ baseUrl: s.url, model: 'm' }).chat({
      task: 'note.reply',
      json: true,
      messages: [{ role: 'user', content: 'Reply to the note.' }],
    });
    expect(s.requests[0]!.body.messages[0]).toMatchObject({ role: 'system' });
    expect(s.requests[0]!.body.messages[0].content).toMatch(/JSON/);
  });

  it('adapts to servers that reject response_format or max_tokens, and remembers it', async () => {
    const s = await fake((r) => {
      if (r.body.response_format)
        return { status: 400, body: { error: { message: "'response_format' is not supported" } } };
      if ('max_tokens' in r.body)
        return {
          status: 400,
          body: { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'." } },
        };
      return reply;
    });
    const p = new OpenAiChatProvider({ baseUrl: s.url, model: 'o-model' });
    await p.chat(jsonReq);
    expect(s.requests).toHaveLength(3);
    expect(s.requests[2]!.body).toMatchObject({ max_completion_tokens: 200 });
    await p.chat(jsonReq);
    expect(s.requests).toHaveLength(4);
  });

  it('embeds and orders results by index', async () => {
    const s = await fake(() => ({
      body: {
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      },
    }));
    const e = new OpenAiEmbeddingProvider({
      baseUrl: `${s.url}/v1`,
      model: 'text-embedding-3-small',
      apiKey: 'k',
    });
    expect(await e.embed(['a', 'b'])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(s.requests[0]).toMatchObject({
      path: '/v1/embeddings',
      body: { model: 'text-embedding-3-small', input: ['a', 'b'] },
    });
  });

  it('health hints at the key on 401', async () => {
    const s = await fake(() => ({ status: 401, body: { error: { message: 'Incorrect API key provided' } } }));
    const h = await new OpenAiChatProvider({ baseUrl: s.url, model: 'm', apiKey: 'bad' }).health();
    expect(h.ok).toBe(false);
    expect(h.message).toContain('Incorrect API key provided');
    expect(h.message).toContain('apiKeyEnv');
  });
});

describe('anthropic provider', () => {
  it('lifts system prompts, merges turns and sends required headers', async () => {
    const s = await fake(() => ({
      body: {
        model: 'claude-haiku-4-5',
        content: [
          { type: 'thinking', thinking: '...' },
          { type: 'text', text: '{"x":' },
          { type: 'text', text: '1}' },
        ],
        usage: { input_tokens: 20, output_tokens: 4 },
      },
    }));
    const p = new AnthropicChatProvider({ baseUrl: s.url, model: 'claude-haiku-4-5', apiKey: 'ak' });
    const res = await p.chat({
      ...jsonReq,
      temperature: 1.5,
      messages: [
        { role: 'system', content: 'Be Ada. Use JSON.' },
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'ok' },
      ],
    });
    expect(res).toMatchObject({ text: '{"x":1}', usage: { inputTokens: 20, outputTokens: 4 } });
    const r = s.requests[0]!;
    expect(r.path).toBe('/v1/messages');
    expect(r.headers['x-api-key']).toBe('ak');
    expect(r.headers['anthropic-version']).toBe('2023-06-01');
    expect(r.body).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      temperature: 1,
      system: 'Be Ada. Use JSON.',
      messages: [
        { role: 'user', content: 'one\n\ntwo' },
        { role: 'assistant', content: 'ok' },
      ],
    });
  });

  it('fails fast with a config error when no key is set', async () => {
    const p = new AnthropicChatProvider({ baseUrl: 'http://127.0.0.1:1', model: 'claude' });
    await expect(p.chat(jsonReq)).rejects.toMatchObject({ kind: 'config', retryable: false });
    expect((await p.health()).ok).toBe(false);
  });

  it('maps 529 overloaded to a retryable http error', async () => {
    const s = await fake(() => ({
      status: 529,
      body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    }));
    const err = await new AnthropicChatProvider({ baseUrl: s.url, model: 'c', apiKey: 'k' })
      .chat(jsonReq)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'http', status: 529, retryable: true });
    expect((err as Error).message).toContain('Overloaded');
  });

  it('health checks the model endpoint', async () => {
    const s = await fake((r) =>
      r.path.endsWith('/claude-ok') ? { body: { id: 'claude-ok' } } : { status: 404, body: {} },
    );
    expect(
      (await new AnthropicChatProvider({ baseUrl: s.url, model: 'claude-ok', apiKey: 'k' }).health()).ok,
    ).toBe(true);
    const bad = await new AnthropicChatProvider({
      baseUrl: s.url,
      model: 'claude-nope',
      apiKey: 'k',
    }).health();
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('unknown model');
  });
});

describe('gemini provider', () => {
  it('sends generateContent with systemInstruction, model role and JSON mime type', async () => {
    const s = await fake(() => ({
      body: {
        candidates: [
          {
            content: { parts: [{ text: 'thinking...', thought: true }, { text: '{"ok":1}' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
        modelVersion: 'gemini-2.5-flash',
      },
    }));
    const p = new GeminiChatProvider({
      baseUrl: `${s.url}/v1beta`,
      model: 'models/gemini-2.5-flash',
      apiKey: 'gk',
    });
    const res = await p.chat({
      ...jsonReq,
      messages: [...jsonReq.messages, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }],
    });
    expect(res).toMatchObject({ text: '{"ok":1}', usage: { inputTokens: 7, outputTokens: 2 } });
    const r = s.requests[0]!;
    expect(r.path).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
    expect(r.headers['x-goog-api-key']).toBe('gk');
    expect(r.body).toEqual({
      systemInstruction: { parts: [{ text: jsonReq.messages[0]!.content }] },
      contents: [
        { role: 'user', parts: [{ text: 'Plan your day.' }] },
        { role: 'model', parts: [{ text: 'a' }] },
        { role: 'user', parts: [{ text: 'b' }] },
      ],
      generationConfig: { temperature: 0.3, maxOutputTokens: 200, responseMimeType: 'application/json' },
    });
  });

  it('reports blocked or truncated answers as parse errors', async () => {
    const s = await fake((r) =>
      r.body.contents[0].parts[0].text === 'blocked'
        ? { body: { promptFeedback: { blockReason: 'SAFETY' } } }
        : { body: { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] } },
    );
    const p = new GeminiChatProvider({ baseUrl: s.url, model: 'g', apiKey: 'k' });
    await expect(
      p.chat({ task: 'reflect', messages: [{ role: 'user', content: 'blocked' }] }),
    ).rejects.toThrow(/SAFETY/);
    await expect(p.chat({ task: 'reflect', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /MAX_TOKENS/,
    );
  });

  it('embeds with batchEmbedContents', async () => {
    const s = await fake(() => ({ body: { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] } }));
    const e = new GeminiEmbeddingProvider({ baseUrl: s.url, model: 'gemini-embedding-001', apiKey: 'k' });
    expect(await e.embed(['a', 'b'])).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(s.requests[0]!.path).toBe('/models/gemini-embedding-001:batchEmbedContents');
    expect(s.requests[0]!.body).toEqual({
      requests: [
        { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'a' }] } },
        { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'b' }] } },
      ],
    });
  });
});

describe('http error mapping', () => {
  it('maps 429 with retry-after, 500, 401, timeouts and non-JSON bodies', async () => {
    const s = await fake((r) => {
      const mode = r.body.messages.at(-1).content as string;
      if (mode === '429')
        return { status: 429, headers: { 'retry-after': '2' }, body: { error: 'slow down' } };
      if (mode === '500') return { status: 500, body: 'boom' };
      if (mode === '401') return { status: 401, body: { error: { message: 'invalid key' } } };
      if (mode === 'slow') return { delayMs: 500, body: { message: { content: 'late' } } };
      return { body: 'not json' };
    });
    const p = new OllamaChatProvider({ baseUrl: s.url, model: 'm', timeoutMs: 100 });
    const ask = (content: string) =>
      p.chat({ task: 'reflect', messages: [{ role: 'user', content }] }).catch((e: unknown) => e as LlmError);
    expect(await ask('429')).toMatchObject({
      kind: 'http',
      status: 429,
      retryable: true,
      retryAfterMs: 2000,
    });
    expect(await ask('500')).toMatchObject({ kind: 'http', status: 500, retryable: true });
    const unauthorized = await ask('401');
    expect(unauthorized).toMatchObject({ kind: 'http', status: 401, retryable: false });
    expect((unauthorized as LlmError).message).toContain('invalid key');
    expect(await ask('slow')).toMatchObject({ kind: 'timeout', retryable: true });
    expect(await ask('junk')).toMatchObject({ kind: 'parse' });
  });

  it('maps a caller abort to an aborted error', async () => {
    const s = await fake(() => ({ delayMs: 500, body: {} }));
    const ctrl = new AbortController();
    const p = new OllamaChatProvider({ baseUrl: s.url, model: 'm' });
    const pending = p.chat({ task: 'reflect', messages: [], signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', retryable: false });
  });
});
