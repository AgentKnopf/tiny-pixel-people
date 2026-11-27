import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type ProviderKind } from '../../../src/server/config.ts';
import { createProviders } from '../../../src/server/llm/index.ts';
import { OpenAiChatProvider } from '../../../src/server/llm/providers/openai.ts';
import type { ChatRequest } from '../../../src/server/llm/types.ts';
import { startFakeServer, type FakeServer, type RecordedRequest } from './fake-server.ts';

function reply(r: RecordedRequest) {
  if (r.path.endsWith('/api/chat')) return { body: { message: { content: '{}' } } };
  if (r.path.endsWith('/chat/completions')) return { body: { choices: [{ message: { content: '{}' } }] } };
  if (r.path.endsWith('/v1/messages')) return { body: { content: [{ type: 'text', text: '{}' }] } };
  if (r.path.endsWith(':generateContent'))
    return { body: { candidates: [{ content: { parts: [{ text: '{}' }] } }] } };
  return { status: 404, body: { error: 'unknown route' } };
}

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

const planReq: ChatRequest = { task: 'plan.day', json: true, messages: [{ role: 'user', content: 'Plan.' }] };

type ThinkCase = { name: string; llm: { think?: boolean; reasoningEffort?: string } };
const CASES: ThinkCase[] = [
  { name: 'think unset', llm: {} },
  { name: 'think false', llm: { think: false } },
  { name: 'think true', llm: { think: true } },
  { name: 'think false, reasoningEffort ""', llm: { think: false, reasoningEffort: '' } },
  { name: 'think false, reasoningEffort "low"', llm: { think: false, reasoningEffort: 'low' } },
];

/** Sends one chat through config -> createProviders -> provider and returns the request body. */
async function bodyFor(kind: ProviderKind, suffix: string, llm: ThinkCase['llm']) {
  server ??= await startFakeServer(reply);
  const dir = mkdtempSync(join(tmpdir(), 'tpp-think-'));
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      llm: { provider: kind, baseUrl: `${server.url}${suffix}`, model: 'm', apiKey: 'k', ...llm },
    }),
  );
  const cfg = loadConfig({ cwd: dir, env: {} });
  await createProviders(cfg, { env: {} }).chat.chat(planReq);
  return server.requests.at(-1)!.body as Record<string, unknown>;
}

describe('llm.think in the request body', () => {
  it('ollama: top-level "think" only when llm.think is set', async () => {
    const expected = [undefined, false, true, false, false];
    for (const [i, c] of CASES.entries()) {
      const body = await bodyFor('ollama', '', c.llm);
      expect('think' in body ? body.think : undefined, c.name).toBe(expected[i]);
      expect(body.reasoning_effort, c.name).toBeUndefined();
      expect(body.options, c.name).not.toHaveProperty('think');
    }
  });

  it('openai: reasoning_effort only while think is false and the value is not ""', async () => {
    const expected = [undefined, 'none', undefined, undefined, 'low'];
    for (const [i, c] of CASES.entries()) {
      const body = await bodyFor('openai', '/v1', c.llm);
      expect(body.reasoning_effort, c.name).toBe(expected[i]);
      expect('reasoning_effort' in body, c.name).toBe(expected[i] !== undefined);
      expect(body, c.name).not.toHaveProperty('think');
    }
  });

  for (const [kind, suffix] of [
    ['anthropic', ''],
    ['gemini', '/v1beta'],
  ] as const) {
    it(`${kind}: ignores think (the body is the same for every setting)`, async () => {
      const bodies = [];
      for (const c of CASES) bodies.push(await bodyFor(kind, suffix, c.llm));
      for (const [i, b] of bodies.entries()) {
        expect(b, CASES[i]!.name).toEqual(bodies[0]);
        expect(JSON.stringify(b), CASES[i]!.name).not.toMatch(/think|reasoning_effort/);
      }
    });
  }

  it('mock: answers the same with any think setting', async () => {
    const texts = [];
    for (const c of CASES) {
      const dir = mkdtempSync(join(tmpdir(), 'tpp-think-'));
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ llm: { provider: 'mock', model: 'm', ...c.llm } }),
      );
      const res = await createProviders(loadConfig({ cwd: dir, env: {} }), { env: {} }).chat.chat(planReq);
      texts.push(res.text);
    }
    expect(new Set(texts).size).toBe(1);
  });
});

describe('openai: servers that reject reasoning_effort', () => {
  it('drops the field after a 400 naming it, warns once and remembers it', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    server = await startFakeServer((r) =>
      'reasoning_effort' in r.body
        ? {
            status: 400,
            body: { error: { message: 'Unrecognized request argument supplied: reasoning_effort' } },
          }
        : reply(r),
    );
    const p = new OpenAiChatProvider({
      baseUrl: `${server.url}/v1`,
      model: 'm',
      think: false,
      reasoningEffort: 'none',
    });
    await p.chat(planReq);
    await p.chat(planReq);
    expect(server.requests.map((r) => 'reasoning_effort' in r.body)).toEqual([true, false, false]);
    const warnings = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('reasoning_effort'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/WARN/);
  });

  it('does not retry a 400 about something else as a reasoning_effort problem', async () => {
    server = await startFakeServer(() => ({
      status: 400,
      body: { error: { message: 'messages: too long' } },
    }));
    const p = new OpenAiChatProvider({
      baseUrl: `${server.url}/v1`,
      model: 'm',
      think: false,
      reasoningEffort: 'none',
    });
    await expect(p.chat(planReq)).rejects.toMatchObject({ status: 400 });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.body.reasoning_effort).toBe('none');
  });
});
