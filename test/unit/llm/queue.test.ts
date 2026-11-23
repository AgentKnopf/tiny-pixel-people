import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmError } from '../../../src/server/llm/errors.ts';
import { OllamaChatProvider } from '../../../src/server/llm/providers/ollama.ts';
import { MockEmbeddingProvider } from '../../../src/server/llm/providers/mock.ts';
import { PriorityLlmQueue } from '../../../src/server/llm/queue.ts';
import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  EmbeddingProvider,
  HealthResult,
  LlmTask,
} from '../../../src/server/llm/types.ts';
import { startFakeServer } from './fake-server.ts';

/** Chat provider whose calls stay pending until the test resolves them. */
class ManualProvider implements ChatProvider {
  readonly kind = 'mock' as const;
  readonly model = 'manual';
  calls: { req: ChatRequest; resolve: (r: Partial<ChatResponse>) => void; reject: (e: unknown) => void }[] =
    [];
  active = 0;
  maxActive = 0;

  chat(req: ChatRequest): Promise<ChatResponse> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    return new Promise((resolve, reject) => {
      this.calls.push({
        req,
        resolve: (r) => {
          this.active--;
          resolve({ text: 'ok', model: this.model, latencyMs: 100, ...r });
        },
        reject: (e) => {
          this.active--;
          reject(e);
        },
      });
    });
  }

  async health(): Promise<HealthResult> {
    return { ok: true, message: 'manual' };
  }
}

/** Chat provider answering from a script of results/errors per call. */
class ScriptedProvider implements ChatProvider {
  readonly kind = 'mock' as const;
  readonly model = 'scripted';
  calls = 0;
  constructor(private readonly script: (n: number, req: ChatRequest) => Partial<ChatResponse> | Error) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const out = this.script(this.calls++, req);
    if (out instanceof Error) throw out;
    return { text: 'ok', model: this.model, latencyMs: 10, ...out };
  }
  async health(): Promise<HealthResult> {
    return { ok: true, message: 'scripted' };
  }
}

const tick = () => new Promise((r) => setImmediate(r));
const req = (task: LlmTask, content: string = task): ChatRequest => ({
  task,
  messages: [{ role: 'user', content }],
});

describe('PriorityLlmQueue', () => {
  it('runs at most `concurrency` jobs and picks higher priority first (FIFO within a priority)', async () => {
    const p = new ManualProvider();
    const q = new PriorityLlmQueue({ chat: p, concurrency: 2 });
    const results: string[] = [];
    const tasks: [LlmTask, string][] = [
      ['day.summarize', 'first'],
      ['importance.rate', 'second'],
      ['reflect', 'low-a'],
      ['player.reply', 'urgent'],
      ['reflect', 'low-b'],
      ['convo.turn', 'talk'],
    ];
    const all = tasks.map(([t, c]) => q.enqueue(req(t, c)).then(() => results.push(c)));
    expect(p.calls.map((c) => c.req.messages[0]!.content)).toEqual(['first', 'second']);
    expect(q.stats()).toMatchObject({ queued: 4, running: 2 });
    while (p.calls.some((c) => c)) {
      const next = p.calls.shift()!;
      next.resolve({});
      await tick();
    }
    await Promise.all(all);
    expect(results).toEqual(['first', 'second', 'urgent', 'talk', 'low-a', 'low-b']);
    expect(p.maxActive).toBe(2);
  });

  it('honours an explicit priority override', async () => {
    const p = new ManualProvider();
    const q = new PriorityLlmQueue({ chat: p, concurrency: 1 });
    const order: string[] = [];
    const a = q.enqueue(req('reflect', 'blocker')).then(() => order.push('blocker'));
    const b = q.enqueue(req('player.reply', 'normal')).then(() => order.push('normal'));
    const c = q.enqueue(req('day.summarize', 'boosted'), { priority: 500 }).then(() => order.push('boosted'));
    for (let i = 0; i < 3; i++) {
      p.calls.shift()!.resolve({});
      await tick();
    }
    await Promise.all([a, b, c]);
    expect(order).toEqual(['blocker', 'boosted', 'normal']);
  });

  it('coalesces jobs with the same dedupeKey', async () => {
    const p = new ScriptedProvider(() => ({ text: 'plan' }));
    const q = new PriorityLlmQueue({ chat: p });
    const [a, b] = await Promise.all([
      q.enqueue(req('plan.day'), { dedupeKey: 'plan:ada:day3' }),
      q.enqueue(req('plan.day'), { dedupeKey: 'plan:ada:day3' }),
    ]);
    expect(a).toBe(b);
    expect(p.calls).toBe(1);
    await q.enqueue(req('plan.day'), { dedupeKey: 'plan:ada:day3' });
    expect(p.calls).toBe(2);
  });

  it('drops jobs that expired (game time) before they started', async () => {
    let now = 100;
    const p = new ManualProvider();
    const q = new PriorityLlmQueue({ chat: p, concurrency: 1, now: () => now });
    const first = q.enqueue(req('reflect'));
    const stale = q.enqueue(req('convo.turn'), { expiresAt: 110 });
    now = 120;
    p.calls.shift()!.resolve({});
    await first;
    await expect(stale).rejects.toMatchObject({ kind: 'expired' });
    expect(p.calls).toHaveLength(0);
    expect(q.droppedCount).toBe(1);
    expect(q.stats().failed).toBe(0);
  });

  it('retries retryable errors with backoff and honours retry-after', async () => {
    const delays: number[] = [];
    const p = new ScriptedProvider((n) =>
      n === 0
        ? new LlmError('http', '429', { status: 429, retryable: true, retryAfterMs: 1500 })
        : n === 1
          ? new LlmError('network', 'ECONNRESET')
          : { text: 'finally', usage: { inputTokens: 10, outputTokens: 20 }, latencyMs: 2000 },
    );
    const q = new PriorityLlmQueue({
      chat: p,
      retryBaseMs: 100,
      random: () => 0.5,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const res = await q.enqueue(req('note.reply'));
    expect(res.text).toBe('finally');
    expect(delays).toEqual([1500, 200]);
    expect(q.stats()).toMatchObject({
      done: 1,
      failed: 0,
      totalTokens: 30,
      tokensPerSecond: 10,
      lastReplyMs: 2000,
    });
    expect(q.isOnline()).toBe(true);
  });

  it('gives up after maxRetries and does not retry non-retryable errors', async () => {
    const sleeps: number[] = [];
    const flaky = new ScriptedProvider(() => new LlmError('http', '503', { status: 503, retryable: true }));
    const q1 = new PriorityLlmQueue({
      chat: flaky,
      maxRetries: 2,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await expect(q1.enqueue(req('reflect'))).rejects.toMatchObject({ status: 503 });
    expect(flaky.calls).toBe(3);
    expect(sleeps).toHaveLength(2);

    const bad = new ScriptedProvider(() => new LlmError('http', '400', { status: 400 }));
    const q2 = new PriorityLlmQueue({ chat: bad, sleep: async () => {} });
    await expect(q2.enqueue(req('reflect'))).rejects.toMatchObject({ status: 400 });
    expect(bad.calls).toBe(1);
    expect(q2.stats()).toMatchObject({ failed: 1, byTask: { reflect: { done: 0, failed: 1 } } });
  });

  it('times out providers that never answer and marks the LLM offline', async () => {
    const p = new ManualProvider();
    const q = new PriorityLlmQueue({ chat: p, timeoutMs: 50, maxRetries: 0 });
    await expect(q.enqueue(req('reflect'))).rejects.toMatchObject({ kind: 'timeout' });
    expect(q.isOnline()).toBe(false);
    expect(q.stats().running).toBe(0);
  });

  it('removes a queued job when its signal aborts', async () => {
    const p = new ManualProvider();
    const q = new PriorityLlmQueue({ chat: p, concurrency: 1 });
    const first = q.enqueue(req('reflect'));
    const ctrl = new AbortController();
    const second = q.enqueue({ ...req('reflect'), signal: ctrl.signal });
    ctrl.abort();
    await expect(second).rejects.toMatchObject({ kind: 'aborted' });
    expect(q.stats().queued).toBe(0);
    p.calls.shift()!.resolve({});
    await first;
    expect(p.calls).toHaveLength(0);
  });

  it('reports per-task stats and averages', async () => {
    let n = 0;
    const p = new ScriptedProvider(() => ({ latencyMs: ++n * 100 }));
    const q = new PriorityLlmQueue({ chat: p });
    await Promise.all([
      q.enqueue(req('convo.turn')),
      q.enqueue(req('convo.turn')),
      q.enqueue(req('plan.day')),
    ]);
    const s = q.stats();
    expect(s).toMatchObject({
      queued: 0,
      running: 0,
      done: 3,
      failed: 0,
      totalLatencyMs: 600,
      avgLatencyMs: 200,
    });
    expect(s.tokensPerSecond).toBeNull();
    expect(Object.keys(s.byTask!).sort()).toEqual(['convo.turn', 'plan.day']);
    expect(s.byTask!['convo.turn']!.done).toBe(2);
  });

  it('drain() resolves once queued and running jobs are finished', async () => {
    const p = new ManualProvider();
    const q = new PriorityLlmQueue({ chat: p, concurrency: 1 });
    await q.drain();
    void q.enqueue(req('reflect'));
    void q.enqueue(req('reflect'));
    let drained = false;
    const d = q.drain().then(() => (drained = true));
    p.calls.shift()!.resolve({});
    await tick();
    expect(drained).toBe(false);
    p.calls.shift()!.resolve({});
    await d;
    expect(drained).toBe(true);
  });

  it('writes a JSONL log when logFile is set', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tpp-llmlog-')), 'llm.jsonl');
    const q = new PriorityLlmQueue({ chat: new ScriptedProvider(() => ({ text: 'logged' })), logFile: file });
    await q.enqueue(req('note.reply', 'hello'));
    await new Promise((r) => setTimeout(r, 50));
    const entry = JSON.parse(readFileSync(file, 'utf8').trim()) as Record<string, unknown>;
    expect(entry).toMatchObject({
      task: 'note.reply',
      text: 'logged',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('retries a real 503 from an HTTP provider end to end', async () => {
    let n = 0;
    const s = await startFakeServer(() =>
      n++ === 0
        ? { status: 503, body: { error: 'loading model' } }
        : { body: { message: { content: 'up' } } },
    );
    try {
      const q = new PriorityLlmQueue({
        chat: new OllamaChatProvider({ baseUrl: s.url, model: 'm' }),
        retryBaseMs: 1,
      });
      expect((await q.enqueue(req('convo.turn'))).text).toBe('up');
      expect(s.requests).toHaveLength(2);
    } finally {
      await s.close();
    }
  });
});

describe('PriorityLlmQueue embeddings lane', () => {
  class CountingEmbedder implements EmbeddingProvider {
    readonly kind = 'mock' as const;
    readonly model = 'count';
    batches: string[][] = [];
    constructor(private readonly fail?: () => Error | undefined) {}
    async embed(texts: string[]): Promise<number[][]> {
      this.batches.push(texts);
      const err = this.fail?.();
      if (err) throw err;
      return texts.map((t) => [t.length]);
    }
  }

  it('returns null when no embeddings provider is configured (keyword fallback)', async () => {
    const q = new PriorityLlmQueue({ chat: new ManualProvider(), embeddings: null });
    expect(q.embeddingsAvailable).toBe(false);
    expect(await q.embed(['a'])).toBeNull();
  });

  it('batches up to 16 texts across calls made in the same tick', async () => {
    const e = new CountingEmbedder();
    const q = new PriorityLlmQueue({ chat: new ManualProvider(), embeddings: e });
    const texts = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const [a, b] = await Promise.all([
      q.embed(texts),
      q.embed(['x', 'yy', 'zzz', 'wwww', 'v', 'u', 'tt', 's', 'r', 'q']),
    ]);
    expect(e.batches.map((b) => b.length)).toEqual([16, 6]);
    expect(a).toHaveLength(12);
    expect(b).toEqual([[1], [2], [3], [4], [1], [1], [2], [1], [1], [1]]);
    expect(await q.embed([])).toEqual([]);
  });

  it('disables embeddings for good after a permanent error (model not found)', async () => {
    const e = new CountingEmbedder(
      () => new LlmError('http', 'model "nomic-embed-text" not found', { status: 404 }),
    );
    const q = new PriorityLlmQueue({ chat: new ManualProvider(), embeddings: e });
    expect(await q.embed(['a'])).toBeNull();
    expect(q.embeddingsAvailable).toBe(false);
    expect(await q.embed(['b'])).toBeNull();
    expect(e.batches).toHaveLength(1);
  });

  it('keeps embeddings on after a transient error and retries', async () => {
    let n = 0;
    const e = new CountingEmbedder(() => (n++ < 1 ? new LlmError('network', 'ECONNREFUSED') : undefined));
    const q = new PriorityLlmQueue({ chat: new ManualProvider(), embeddings: e, sleep: async () => {} });
    expect(await q.embed(['abc'])).toEqual([[3]]);
    expect(q.embeddingsAvailable).toBe(true);
  });

  it('works with the mock embedder and drains', async () => {
    const q = new PriorityLlmQueue({ chat: new ManualProvider(), embeddings: new MockEmbeddingProvider() });
    const p = q.embed(['bakery bread']);
    await q.drain();
    expect((await p)![0]).toHaveLength(64);
  });
});
