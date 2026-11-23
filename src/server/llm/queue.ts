/**
 * Concurrency-limited priority queue for LLM calls (spec §8.4). The sim never awaits it directly;
 * cognition enqueues jobs and applies results on a later tick.
 */
import { appendFile } from 'node:fs/promises';
import type { QueueStats } from '../../shared/protocol.ts';
import type { AppConfig } from '../config.ts';
import { createLogger } from '../log.ts';
import { LlmError } from './errors.ts';
import {
  TASK_PRIORITY,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type EmbeddingProvider,
  type EnqueueOptions,
  type LlmQueue,
  type Providers,
} from './types.ts';

const log = createLogger('llm.queue');

export interface LlmQueueOptions {
  chat: ChatProvider;
  /** null/undefined => `embed()` returns null (keyword retrieval). */
  embeddings?: EmbeddingProvider | null;
  /** Parallel chat calls (default 2). */
  concurrency?: number;
  /** Hard per-attempt timeout enforced by the queue (default 120 s). */
  timeoutMs?: number;
  /** Parallel embedding batches (default 1). */
  embedConcurrency?: number;
  /** Max texts per embedding request (default 16). */
  embedBatchSize?: number;
  /** Retries for retryable failures (default 2). */
  maxRetries?: number;
  /** Base backoff delay; doubles per attempt (default 500 ms). */
  retryBaseMs?: number;
  /** Cap for backoff and `retry-after` (default 30 s). */
  maxRetryDelayMs?: number;
  /** Game clock used for `expiresAt` (game minutes). Without it, `expiresAt` is ignored. */
  now?: () => number;
  /** JSONL file for prompts/responses (debugging); empty = off. */
  logFile?: string;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface Job {
  seq: number;
  req: ChatRequest;
  priority: number;
  dedupeKey: string | undefined;
  expiresAt: number | undefined;
  promise: Promise<ChatResponse>;
  resolve: (r: ChatResponse) => void;
  reject: (e: unknown) => void;
  onAbort?: () => void;
}

interface EmbedItem {
  text: string;
  resolve: (v: number[] | null) => void;
}

interface TaskStat {
  done: number;
  failed: number;
  totalLatencyMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class PriorityLlmQueue implements LlmQueue {
  private readonly chatProvider: ChatProvider;
  private embedProvider: EmbeddingProvider | null;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly embedConcurrency: number;
  private readonly embedBatchSize: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: (() => number) | undefined;
  private readonly logFile: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  private seq = 0;
  private pending: Job[] = [];
  private readonly byKey = new Map<string, Job>();
  private running = 0;
  private embedPending: EmbedItem[] = [];
  private embedRunning = 0;
  private embedPumpScheduled = false;
  private idleWaiters: (() => void)[] = [];
  private logChain: Promise<void> = Promise.resolve();

  private done = 0;
  private failed = 0;
  private dropped = 0;
  private totalLatencyMs = 0;
  private totalTokens = 0;
  private outputTokens = 0;
  private outputTokenLatencyMs = 0;
  private lastReplyMs: number | null = null;
  private readonly tasks = new Map<string, TaskStat>();
  private online: boolean | null = null;

  constructor(opts: LlmQueueOptions) {
    this.chatProvider = opts.chat;
    this.embedProvider = opts.embeddings ?? null;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.embedConcurrency = Math.max(1, opts.embedConcurrency ?? 1);
    this.embedBatchSize = Math.max(1, opts.embedBatchSize ?? 16);
    this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 30_000;
    this.now = opts.now;
    this.logFile = opts.logFile ?? '';
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
  }

  get provider(): ChatProvider {
    return this.chatProvider;
  }

  /** False once the embeddings provider failed permanently (e.g. model not pulled). */
  get embeddingsAvailable(): boolean {
    return this.embedProvider !== null;
  }

  /** null until the first call (or `setOnline`); then whether the last call reached the model. */
  isOnline(): boolean | null {
    return this.online;
  }

  /** Seed the online flag from a startup health check. */
  setOnline(online: boolean): void {
    this.online = online;
  }

  /** Stop using embeddings (callers fall back to keyword retrieval). */
  disableEmbeddings(reason: string): void {
    if (!this.embedProvider) return;
    log.warn(`embeddings disabled (${reason}); memory retrieval falls back to keywords`);
    this.embedProvider = null;
    for (const item of this.embedPending.splice(0)) item.resolve(null);
  }

  enqueue(req: ChatRequest, opts: EnqueueOptions = {}): Promise<ChatResponse> {
    const priority = opts.priority ?? TASK_PRIORITY[req.task] ?? 0;
    if (opts.dedupeKey) {
      const existing = this.byKey.get(opts.dedupeKey);
      if (existing) {
        existing.priority = Math.max(existing.priority, priority);
        return existing.promise;
      }
    }
    if (req.signal?.aborted)
      return Promise.reject(new LlmError('aborted', `${req.task}: aborted before start`));
    let resolve!: (r: ChatResponse) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<ChatResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: Job = {
      seq: this.seq++,
      req,
      priority,
      dedupeKey: opts.dedupeKey,
      expiresAt: opts.expiresAt,
      promise,
      resolve,
      reject,
    };
    if (req.signal) {
      job.onAbort = () => {
        const idx = this.pending.indexOf(job);
        if (idx < 0) return;
        this.pending.splice(idx, 1);
        this.forget(job);
        job.reject(new LlmError('aborted', `${req.task}: aborted while queued`));
        this.checkIdle();
      };
      req.signal.addEventListener('abort', job.onAbort, { once: true });
    }
    if (job.dedupeKey) this.byKey.set(job.dedupeKey, job);
    this.pending.push(job);
    this.pump();
    return promise;
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    if (!this.embedProvider) return null;
    if (texts.length === 0) return [];
    const pending = texts.map(
      (text) =>
        new Promise<number[] | null>((resolve) => {
          this.embedPending.push({ text, resolve });
        }),
    );
    this.scheduleEmbedPump();
    const results = await Promise.all(pending);
    return results.every((r) => r !== null) ? (results as number[][]) : null;
  }

  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  stats(): QueueStats {
    const byTask: NonNullable<QueueStats['byTask']> = {};
    for (const [task, s] of this.tasks)
      byTask[task] = {
        done: s.done,
        failed: s.failed,
        avgLatencyMs: s.done ? Math.round(s.totalLatencyMs / s.done) : 0,
      };
    return {
      queued: this.pending.length,
      running: this.running,
      done: this.done,
      failed: this.failed,
      avgLatencyMs: this.done ? Math.round(this.totalLatencyMs / this.done) : 0,
      totalLatencyMs: this.totalLatencyMs,
      totalTokens: this.totalTokens,
      lastReplyMs: this.lastReplyMs,
      tokensPerSecond:
        this.outputTokenLatencyMs > 0
          ? Math.round((this.outputTokens / this.outputTokenLatencyMs) * 10_000) / 10
          : null,
      byTask,
    };
  }

  /** Jobs dropped because they expired before starting. */
  get droppedCount(): number {
    return this.dropped;
  }

  // ---------- internals ----------

  private isIdle(): boolean {
    return (
      this.pending.length === 0 &&
      this.running === 0 &&
      this.embedPending.length === 0 &&
      this.embedRunning === 0
    );
  }

  private checkIdle(): void {
    if (!this.isIdle()) return;
    for (const w of this.idleWaiters.splice(0)) w();
  }

  private forget(job: Job): void {
    if (job.dedupeKey && this.byKey.get(job.dedupeKey) === job) this.byKey.delete(job.dedupeKey);
    if (job.onAbort) job.req.signal?.removeEventListener('abort', job.onAbort);
  }

  private takeNext(): Job | undefined {
    let best = -1;
    for (let i = 0; i < this.pending.length; i++) {
      const j = this.pending[i]!;
      const b = best >= 0 ? this.pending[best]! : undefined;
      if (!b || j.priority > b.priority || (j.priority === b.priority && j.seq < b.seq)) best = i;
    }
    return best >= 0 ? this.pending.splice(best, 1)[0] : undefined;
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const job = this.takeNext();
      if (!job) break;
      if (job.expiresAt !== undefined && this.now && this.now() > job.expiresAt) {
        this.forget(job);
        this.dropped++;
        job.reject(new LlmError('expired', `${job.req.task}: dropped, expired before it started`));
        continue;
      }
      this.running++;
      void this.run(job);
    }
    this.checkIdle();
  }

  private async run(job: Job): Promise<void> {
    if (job.onAbort) job.req.signal?.removeEventListener('abort', job.onAbort);
    try {
      const res = await this.withRetries(
        job.req.task,
        (signal) => this.withTimeout(this.chatProvider.chat({ ...job.req, signal }), signal, job.req.task),
        job.req.signal,
      );
      this.record(job.req.task, res);
      this.writeLog({
        task: job.req.task,
        model: res.model,
        latencyMs: res.latencyMs,
        messages: job.req.messages,
        text: res.text,
      });
      job.resolve(res);
    } catch (err) {
      this.failed++;
      this.taskStat(job.req.task).failed++;
      this.writeLog({ task: job.req.task, messages: job.req.messages, error: (err as Error).message });
      if (!(err instanceof LlmError && err.kind === 'aborted'))
        log.warn(`${job.req.task} failed: ${(err as Error).message}`);
      job.reject(err);
    } finally {
      this.forget(job);
      this.running--;
      this.pump();
    }
  }

  /** Run `attempt` with retry/backoff for retryable errors; tracks the online flag. */
  private async withRetries<T>(
    label: string,
    attempt: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    for (let n = 0; ; n++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
      try {
        const out = await attempt(signal);
        this.online = true;
        return out;
      } catch (raw) {
        const err = this.normalize(raw, callerSignal);
        if (err.kind === 'network' || err.kind === 'timeout' || err.status === 401 || err.status === 403)
          this.online = false;
        if (!err.retryable || n >= this.maxRetries || callerSignal?.aborted) throw err;
        const backoff = this.retryBaseMs * 2 ** n * (0.75 + 0.5 * this.random());
        const delay = Math.min(this.maxRetryDelayMs, err.retryAfterMs ?? backoff);
        log.debug(`${label}: ${err.message}; retry ${n + 1}/${this.maxRetries} in ${Math.round(delay)} ms`);
        await this.sleep(delay);
      }
    }
  }

  private normalize(err: unknown, callerSignal?: AbortSignal): LlmError {
    if (err instanceof LlmError) return err;
    if (callerSignal?.aborted) return new LlmError('aborted', 'request aborted', { cause: err });
    return new LlmError('network', (err as Error)?.message ?? String(err), { cause: err, retryable: false });
  }

  /** Enforce the timeout even for providers that ignore the abort signal. */
  private withTimeout<T>(p: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const reason: unknown = signal.reason;
        if (reason instanceof DOMException && reason.name === 'TimeoutError')
          reject(new LlmError('timeout', `${label}: no answer within ${this.timeoutMs} ms`));
        else reject(new LlmError('aborted', `${label}: aborted`));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  private taskStat(task: string): TaskStat {
    let s = this.tasks.get(task);
    if (!s) {
      s = { done: 0, failed: 0, totalLatencyMs: 0 };
      this.tasks.set(task, s);
    }
    return s;
  }

  private record(task: string, res: ChatResponse): void {
    this.done++;
    this.totalLatencyMs += res.latencyMs;
    this.lastReplyMs = res.latencyMs;
    const s = this.taskStat(task);
    s.done++;
    s.totalLatencyMs += res.latencyMs;
    const inTok = res.usage?.inputTokens ?? 0;
    const outTok = res.usage?.outputTokens ?? 0;
    this.totalTokens += inTok + outTok;
    if (outTok > 0) {
      this.outputTokens += outTok;
      this.outputTokenLatencyMs += res.latencyMs;
    }
  }

  private scheduleEmbedPump(): void {
    if (this.embedPumpScheduled) return;
    this.embedPumpScheduled = true;
    // Defer one microtask so embed() calls made in the same tick share a batch.
    queueMicrotask(() => {
      this.embedPumpScheduled = false;
      this.embedPump();
    });
  }

  private embedPump(): void {
    while (this.embedRunning < this.embedConcurrency && this.embedPending.length > 0) {
      const batch = this.embedPending.splice(0, this.embedBatchSize);
      this.embedRunning++;
      void this.runEmbed(batch);
    }
    this.checkIdle();
  }

  private async runEmbed(batch: EmbedItem[]): Promise<void> {
    const provider = this.embedProvider;
    try {
      if (!provider) throw new LlmError('config', 'no embeddings provider');
      const texts = batch.map((b) => b.text);
      const vectors = await this.withRetries('embed', (signal) =>
        this.withTimeout(provider.embed(texts, signal), signal, 'embed'),
      );
      batch.forEach((b, i) => b.resolve(vectors[i] ?? null));
    } catch (err) {
      const e = err instanceof LlmError ? err : new LlmError('network', String(err));
      // Permanent errors (unknown model, bad request, bad key) mean embeddings will never work.
      if (provider && !e.retryable && (e.kind === 'http' || e.kind === 'parse' || e.kind === 'config'))
        this.disableEmbeddings(e.message);
      else log.warn(`embedding batch failed: ${e.message}`);
      for (const b of batch) b.resolve(null);
    } finally {
      this.embedRunning--;
      this.embedPump();
    }
  }

  private writeLog(entry: Record<string, unknown>): void {
    if (!this.logFile) return;
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    this.logChain = this.logChain
      .then(() => appendFile(this.logFile, line))
      .catch((err: unknown) => log.warn(`cannot write llm.logFile: ${(err as Error).message}`));
  }
}

/**
 * Build the queue from `config.llm` (concurrency, timeoutMs, logFile). `extra` sets the rest,
 * e.g. `{ now: () => clock.now(), embedConcurrency: config.embeddings.concurrency }`.
 */
export function createLlmQueue(
  llm: AppConfig['llm'],
  providers: Providers,
  extra: Partial<Omit<LlmQueueOptions, 'chat' | 'embeddings'>> = {},
): PriorityLlmQueue {
  return new PriorityLlmQueue({
    chat: providers.chat,
    embeddings: providers.embeddings,
    concurrency: llm.concurrency,
    // Providers enforce timeoutMs on the HTTP call; the queue adds slack as a backstop.
    timeoutMs: llm.timeoutMs + 5_000,
    logFile: llm.logFile,
    ...extra,
  });
}
