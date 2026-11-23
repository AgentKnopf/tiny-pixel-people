import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type ProviderKind } from '../../../src/server/config.ts';
import { checkLlmHealth, createLlmQueue, createProviders } from '../../../src/server/llm/index.ts';
import { startFakeServer, type FakeServer, type RecordedRequest } from './fake-server.ts';

/** One fake server answering every provider's chat, embed and health routes. */
function universalReply(r: RecordedRequest) {
  if (r.path === '/api/tags') return { body: { models: [{ name: 'qwen2.5:7b' }] } };
  if (r.path.endsWith('/api/chat')) return { body: { message: { content: '{}' } } };
  if (r.path.endsWith('/api/embed')) return { body: { embeddings: r.body.input.map(() => [1]) } };
  if (r.path.endsWith('/chat/completions')) return { body: { choices: [{ message: { content: '{}' } }] } };
  if (r.path.endsWith('/embeddings'))
    return { body: { data: r.body.input.map((_: string, index: number) => ({ index, embedding: [1] })) } };
  if (r.path.endsWith('/v1/messages')) return { body: { content: [{ type: 'text', text: '{}' }] } };
  if (r.path.endsWith(':generateContent'))
    return { body: { candidates: [{ content: { parts: [{ text: '{}' }] } }] } };
  if (r.path.endsWith(':batchEmbedContents'))
    return { body: { embeddings: r.body.requests.map(() => ({ values: [1] })) } };
  return { status: 404, body: { error: 'unknown route' } };
}

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function configDir(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'tpp-llm-cfg-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(content));
  return dir;
}

function modelInRequest(kind: ProviderKind, r: RecordedRequest): string {
  if (kind === 'gemini') return /\/models\/([^:]+):/.exec(r.path)?.[1] ?? '';
  return r.body.model as string;
}

describe('createProviders (AC7: model and provider are config-only)', () => {
  const cases: { kind: ProviderKind; suffix: string; auth: (r: RecordedRequest) => string | undefined }[] = [
    { kind: 'ollama', suffix: '', auth: () => undefined },
    { kind: 'openai', suffix: '/v1', auth: (r) => r.headers.authorization },
    { kind: 'anthropic', suffix: '', auth: (r) => r.headers['x-api-key'] as string },
    { kind: 'gemini', suffix: '/v1beta', auth: (r) => r.headers['x-goog-api-key'] as string },
  ];

  for (const { kind, suffix, auth } of cases) {
    it(`${kind}: llm.model from file, then from TPP_LLM_MODEL, reaches the request`, async () => {
      server = await startFakeServer(universalReply);
      const dir = configDir({
        llm: {
          provider: kind,
          baseUrl: `${server.url}${suffix}`,
          model: 'model-from-file',
          apiKeyEnv: 'MY_KEY',
        },
      });
      const env = { MY_KEY: 'secret-123' };
      for (const [cfgEnv, expected] of [
        [env, 'model-from-file'],
        [{ ...env, TPP_LLM_MODEL: 'model-from-env' }, 'model-from-env'],
      ] as const) {
        const cfg = loadConfig({ cwd: dir, env: cfgEnv });
        const providers = createProviders(cfg, { env: cfgEnv });
        expect(providers.chat.kind).toBe(kind);
        expect(providers.chat.model).toBe(expected);
        await providers.chat.chat({
          task: 'plan.day',
          json: true,
          messages: [{ role: 'user', content: 'hi' }],
        });
        const r = server.requests.at(-1)!;
        expect(modelInRequest(kind, r)).toBe(expected);
        if (kind !== 'ollama') expect(auth(r)).toContain('secret-123');
      }
    });
  }

  it('resolves embeddings: auto follows the chat provider, anthropic means keyword fallback', () => {
    const mk = (llm: object, embeddings: object = {}) =>
      createProviders(loadConfig({ cwd: configDir({ llm, embeddings }), env: {} }), { env: {} });
    expect(mk({ provider: 'ollama' }).embeddings).toMatchObject({
      kind: 'ollama',
      model: 'nomic-embed-text',
    });
    expect(mk({ provider: 'anthropic', apiKey: 'k' }).embeddings).toBeNull();
    expect(mk({ provider: 'gemini', apiKey: 'k' }).embeddings).toMatchObject({
      kind: 'gemini',
      model: 'gemini-embedding-001',
    });
    expect(mk({ provider: 'openai', apiKey: 'k' }).embeddings).toMatchObject({
      kind: 'openai',
      model: 'text-embedding-3-small',
    });
    // A custom OpenAI-compatible server keeps the configured name.
    expect(mk({ provider: 'openai', baseUrl: 'http://localhost:1234/v1' }).embeddings?.model).toBe(
      'nomic-embed-text',
    );
    expect(mk({ provider: 'openai' }, { provider: 'none' }).embeddings).toBeNull();
    expect(mk({ provider: 'mock', model: 'm' }).embeddings?.kind).toBe('mock');
  });

  it('anthropic chat + ollama embeddings with separate endpoints', async () => {
    server = await startFakeServer(universalReply);
    const cfg = loadConfig({
      cwd: configDir({
        llm: { provider: 'anthropic', baseUrl: server.url, model: 'claude-x', apiKey: 'ak' },
        embeddings: { provider: 'ollama', baseUrl: server.url, model: 'nomic-embed-text' },
      }),
      env: {},
    });
    const providers = createProviders(cfg, { env: {} });
    expect(await providers.embeddings!.embed(['a'])).toEqual([[1]]);
    const embedReq = server.requests.at(-1)!;
    expect(embedReq.path).toBe('/api/embed');
    expect(embedReq.headers['x-api-key']).toBeUndefined();
  });

  it('only sends OPENAI_API_KEY to api.openai.com, never to a custom server', async () => {
    server = await startFakeServer(universalReply);
    const env = { OPENAI_API_KEY: 'sk-official' };
    const cfg = loadConfig({
      cwd: configDir({ llm: { provider: 'openai', baseUrl: `${server.url}/v1`, model: 'local' } }),
      env,
    });
    await createProviders(cfg, { env }).chat.chat({
      task: 'reflect',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(server.requests.at(-1)!.headers.authorization).toBeUndefined();
  });

  it('checkLlmHealth seeds the queue and disables an unusable embedding model', async () => {
    server = await startFakeServer(universalReply);
    const cfg = loadConfig({
      cwd: configDir({ llm: { provider: 'ollama', baseUrl: server.url, model: 'qwen2.5:7b' } }),
      env: {},
    });
    const providers = createProviders(cfg, { env: {} });
    const queue = createLlmQueue(cfg.llm, providers, { embedConcurrency: cfg.embeddings.concurrency });
    const health = await checkLlmHealth(providers, queue);
    expect(health.chat.ok).toBe(true);
    expect(health.embeddings).toMatchObject({
      ok: false,
      message: expect.stringContaining('ollama pull nomic-embed-text'),
    });
    expect(queue.isOnline()).toBe(true);
    expect(queue.embeddingsAvailable).toBe(false);
    expect(await queue.embed(['x'])).toBeNull();
  });
});
