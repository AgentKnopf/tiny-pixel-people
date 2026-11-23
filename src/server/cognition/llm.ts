import { createLogger } from '../log.ts';
import type { Provenance } from '../../shared/types.ts';
import { TASK_PRIORITY, type ChatMessage, type LlmQueue, type LlmTask } from '../llm/types.ts';
import { parseJsonLoose } from './json.ts';

const log = createLogger('cognition');

export interface AskSpec<T> {
  task: LlmTask;
  system: string;
  user: string;
  /** Validate/coerce the parsed JSON; return null when unusable. */
  parse: (raw: unknown) => T | null;
  /** Deterministic answer used when the model fails (the sim never stalls). */
  fallback: () => T;
  /** Accept a plain-text answer when no JSON is found (dialogue lines, replies). */
  acceptText?: (text: string) => T | null;
  /** Short JSON example shown in the repair prompt. */
  shape: string;
  meta?: Record<string, unknown>;
  dedupeKey?: string;
  expiresAt?: number;
  temperature?: number;
  maxTokens?: number;
  /** Queue priority (default: TASK_PRIORITY of the task). */
  priority?: number;
  /** Game clock; enables load tracking and `deadline`. */
  now?: () => number;
  /** Game time after which the call is abandoned (queued or running) and the fallback is used. */
  deadline?: number;
  /** Skip the repair round (cheap calls where the fallback is good enough). */
  noRepair?: boolean;
  /** Do not call the model at all (load shedding): answer with the fallback. */
  offline?: boolean;
}

export interface AskResult<T> {
  value: T;
  source: Provenance;
}

export type LoadLevel = 'normal' | 'busy' | 'overloaded';

/** Per task: answers that came from the model vs. from the deterministic fallback. */
export type FallbackStats = Record<string, { llm: number; fallback: number }>;

/** Offline (shed) answers and unparseable model output both count as fallback. */
const stats = new WeakMap<LlmQueue, FallbackStats>();

export function fallbackStats(queue: LlmQueue): FallbackStats {
  let s = stats.get(queue);
  if (!s) {
    s = {};
    stats.set(queue, s);
  }
  return s;
}

function record(queue: LlmQueue, task: LlmTask, source: Provenance): void {
  const s = fallbackStats(queue);
  const entry = (s[task] ??= { llm: 0, fallback: 0 });
  entry[source]++;
}

export function statsLine(s: FallbackStats): string {
  const parts = Object.keys(s)
    .sort()
    .map((task) => `${task} ${s[task]!.llm}/${s[task]!.fallback}`);
  return parts.length ? parts.join(', ') : 'none';
}

/**
 * How far behind the model is, in game minutes, per queue. Measured in game time so a fast model,
 * a slow model and the virtual-clock harness (where calls finish within a step) all read correctly.
 */
export class LoadTracker {
  /** Smoothed game minutes from enqueue to answer. */
  lag = 0;
  private lagAt = 0;
  private readonly inflight = new Map<number, number>();
  private seq = 0;

  /** Set the lag directly (tests, or a caller that knows the model is slow). */
  seed(lag: number, now: number): void {
    this.lag = lag;
    this.lagAt = now;
  }

  start(now: number): number {
    const id = ++this.seq;
    this.inflight.set(id, now);
    return id;
  }

  finish(id: number, now: number): void {
    const t0 = this.inflight.get(id);
    this.inflight.delete(id);
    if (t0 === undefined) return;
    const dt = Math.max(0, now - t0);
    this.lag = this.decayed(now) * 0.8 + dt * 0.2;
    this.lagAt = now;
  }

  /** Lag, raised by the oldest call still waiting so a stalled model is noticed before it answers. */
  current(now: number): number {
    let oldest = 0;
    for (const t0 of this.inflight.values()) oldest = Math.max(oldest, now - t0);
    return Math.max(this.decayed(now), oldest * 0.5);
  }

  /** Halves per idle game hour, so the level recovers even when little is being asked. */
  private decayed(now: number): number {
    return this.lag * 0.5 ** (Math.max(0, now - this.lagAt) / 60);
  }

  level(now: number): LoadLevel {
    const lag = this.current(now);
    return lag >= LAG_OVERLOADED ? 'overloaded' : lag >= LAG_BUSY ? 'busy' : 'normal';
  }
}

/** Game minutes of lag at which optional LLM work is skipped / only essentials are asked. */
export const LAG_BUSY = 12;
export const LAG_OVERLOADED = 35;

const trackers = new WeakMap<LlmQueue, LoadTracker>();

export function loadTracker(queue: LlmQueue): LoadTracker {
  let t = trackers.get(queue);
  if (!t) {
    t = new LoadTracker();
    trackers.set(queue, t);
  }
  return t;
}

/**
 * Ask the queue for a JSON answer: tolerant parse, one repair retry, then the fallback.
 * Never throws.
 */
export async function ask<T>(queue: LlmQueue, spec: AskSpec<T>): Promise<AskResult<T>> {
  if (spec.offline) {
    record(queue, spec.task, 'fallback');
    return { value: spec.fallback(), source: 'fallback' };
  }
  const tracker = spec.now ? loadTracker(queue) : null;
  const id = tracker && spec.now ? tracker.start(spec.now()) : 0;
  try {
    const res = await askInner(queue, spec);
    record(queue, spec.task, res.source);
    return res;
  } finally {
    if (tracker && spec.now) tracker.finish(id, spec.now());
  }
}

async function askInner<T>(queue: LlmQueue, spec: AskSpec<T>): Promise<AskResult<T>> {
  const messages: ChatMessage[] = [
    { role: 'system', content: spec.system },
    { role: 'user', content: spec.user },
  ];
  const priority = spec.priority ?? TASK_PRIORITY[spec.task];
  const expiresAt =
    spec.deadline !== undefined ? Math.min(spec.deadline, spec.expiresAt ?? Infinity) : spec.expiresAt;
  const opts = {
    priority,
    ...(spec.dedupeKey ? { dedupeKey: spec.dedupeKey } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
  const abort = spec.deadline !== undefined && spec.now ? watchDeadline(spec.now, spec.deadline) : null;
  const base = {
    task: spec.task,
    json: true,
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
    ...(spec.meta ? { meta: spec.meta } : {}),
    ...(abort ? { signal: abort.signal } : {}),
  };
  try {
    let text: string;
    try {
      text = (await queue.enqueue({ ...base, messages }, opts)).text;
    } catch (err) {
      log.debug(`${spec.task}: request failed (${(err as Error).message}); using fallback`);
      return { value: spec.fallback(), source: 'fallback' };
    }
    const first = safeParse(spec, text);
    if (first !== null) return { value: first, source: 'llm' };
    if (spec.noRepair || abort?.signal.aborted) return { value: spec.fallback(), source: 'fallback' };
    try {
      const repaired = await queue.enqueue(
        {
          ...base,
          temperature: 0,
          messages: [
            ...messages,
            { role: 'assistant', content: text.slice(0, 2000) },
            {
              role: 'user',
              content: `That was not valid. Return ONLY one JSON object, no other text, like:\n${spec.shape}`,
            },
          ],
        },
        { priority, ...(expiresAt !== undefined ? { expiresAt } : {}) },
      );
      const second = safeParse(spec, repaired.text);
      if (second !== null) return { value: second, source: 'llm' };
    } catch (err) {
      log.debug(`${spec.task}: repair request failed (${(err as Error).message})`);
    }
    log.debug(`${spec.task}: unusable model output; using fallback`);
    return { value: spec.fallback(), source: 'fallback' };
  } finally {
    abort?.stop();
  }
}

/** Resolves once the game clock reaches `until` (polled; the clock only moves between sim steps). */
export function gameTimer(now: () => number, until: number): { done: Promise<void>; stop: () => void } {
  const w = watchDeadline(now, until);
  const done = new Promise<void>((resolve) => {
    if (w.signal.aborted) resolve();
    else w.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  return { done, stop: w.stop };
}

/** Abort once the game clock passes `deadline` (polled; the clock only moves between sim steps). */
function watchDeadline(now: () => number, deadline: number): { signal: AbortSignal; stop: () => void } {
  const ctl = new AbortController();
  if (now() >= deadline) {
    ctl.abort();
    return { signal: ctl.signal, stop: () => {} };
  }
  const timer = setInterval(() => {
    if (now() >= deadline) {
      clearInterval(timer);
      ctl.abort();
    }
  }, 100);
  timer.unref?.();
  return { signal: ctl.signal, stop: () => clearInterval(timer) };
}

function safeParse<T>(spec: AskSpec<T>, text: string): T | null {
  const raw = parseJsonLoose(text);
  if (raw === undefined) return spec.acceptText && text.trim() ? spec.acceptText(text.trim()) : null;
  try {
    return spec.parse(raw);
  } catch {
    return null;
  }
}
