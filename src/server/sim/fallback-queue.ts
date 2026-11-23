import type { QueueStats } from '../../shared/protocol.ts';
import {
  TASK_PRIORITY,
  type ChatRequest,
  type ChatResponse,
  type EnqueueOptions,
  type LlmQueue,
  type Providers,
} from '../llm/types.ts';

interface Job {
  req: ChatRequest;
  priority: number;
  seq: number;
  resolve: (r: ChatResponse) => void;
  reject: (e: unknown) => void;
}

/**
 * Minimal priority queue used by the engine until WP1's LlmQueue is wired in: concurrency limit,
 * priorities, dedupe, drain and stats. No retries or expiry.
 */
export class FallbackLlmQueue implements LlmQueue {
  private readonly pending: Job[] = [];
  private readonly dedupe = new Map<string, Promise<ChatResponse>>();
  private running = 0;
  private seq = 0;
  private done = 0;
  private failed = 0;
  private totalLatencyMs = 0;
  private totalTokens = 0;
  private lastReplyMs: number | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly providers: Providers,
    private readonly concurrency = 2,
  ) {}

  enqueue(req: ChatRequest, opts: EnqueueOptions = {}): Promise<ChatResponse> {
    if (opts.dedupeKey) {
      const existing = this.dedupe.get(opts.dedupeKey);
      if (existing) return existing;
    }
    const p = new Promise<ChatResponse>((resolve, reject) => {
      this.pending.push({
        req,
        priority: opts.priority ?? TASK_PRIORITY[req.task],
        seq: this.seq++,
        resolve,
        reject,
      });
    });
    if (opts.dedupeKey) {
      const key = opts.dedupeKey;
      this.dedupe.set(key, p);
      const clear = () => this.dedupe.delete(key);
      p.then(clear, clear);
    }
    this.pump();
    return p;
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    if (!this.providers.embeddings || texts.length === 0) return null;
    try {
      return await this.providers.embeddings.embed(texts);
    } catch {
      return null;
    }
  }

  drain(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  stats(): QueueStats {
    const finished = this.done + this.failed;
    return {
      queued: this.pending.length,
      running: this.running,
      done: this.done,
      failed: this.failed,
      avgLatencyMs: finished ? Math.round(this.totalLatencyMs / Math.max(1, this.done)) : 0,
      totalLatencyMs: this.totalLatencyMs,
      totalTokens: this.totalTokens,
      lastReplyMs: this.lastReplyMs,
      tokensPerSecond: null,
    };
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      this.pending.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      const job = this.pending.shift()!;
      this.running++;
      void this.providers.chat
        .chat(job.req)
        .then(
          (res) => {
            this.done++;
            this.totalLatencyMs += res.latencyMs;
            this.lastReplyMs = res.latencyMs;
            this.totalTokens += (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0);
            job.resolve(res);
          },
          (err: unknown) => {
            this.failed++;
            job.reject(err);
          },
        )
        .finally(() => {
          this.running--;
          this.pump();
          if (this.running === 0 && this.pending.length === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            for (const w of waiters) w();
          }
        });
    }
  }
}
