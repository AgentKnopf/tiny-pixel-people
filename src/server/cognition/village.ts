/**
 * State shared by all minds of one engine. Minds only receive per-villager deps, so the shared
 * part is keyed by the engine's LlmQueue (one queue per engine).
 */
import { dayOf } from '../../shared/time.ts';
import type { GameMinutes, Memory, VillagerId, VillagerProfile } from '../../shared/types.ts';
import type { LlmQueue } from '../llm/types.ts';
import type { Embedder } from './memory.ts';
import { LetterBudget } from './post.ts';
import { RomanceBook } from './romance.ts';
import { compareIds } from './rng.ts';

interface MindLike {
  readonly id: VillagerId;
  readonly profile: VillagerProfile;
  dawnPlanPending?(): boolean;
  preparingTomorrow?(): boolean;
}

const HOSTY =
  /bak|cook|chef|host|party|social|organi|festiv|cheer|outgoing|friendly|mayor|music|baker|caf|garden|teacher|event|fun/gi;

const hostScores = new WeakMap<VillagerProfile, number>();

export function hostScore(p: VillagerProfile): number {
  const hit = hostScores.get(p);
  if (hit !== undefined) return hit;
  const text = `${p.occupation} ${p.occupation} ${p.bio} ${p.traits.join(' ')}`;
  const s = (text.match(HOSTY) ?? []).length;
  hostScores.set(p, s);
  return s;
}

export class Village<M extends MindLike = MindLike> {
  readonly minds = new Map<VillagerId, M>();
  readonly embedder: QueueEmbedder;
  /** Villager-written letters across the town (spec v2 §8.1). */
  readonly letters = new LetterBudget();
  /** Romance records (spec v2 §7); the engine's copies win when newer. */
  readonly romances = new RomanceBook();
  private proposals = new Map<number, number>();
  private claims = new Map<number, VillagerId>();
  private statsLogged = new Set<number>();
  private host: { id: VillagerId | null } | null = null;

  constructor(queue: LlmQueue) {
    this.embedder = new QueueEmbedder(queue);
  }

  register(mind: M): void {
    this.minds.set(mind.id, mind);
    this.host = null;
  }

  /** Who should make sure a daily event exists (most "hosty" resident; ties by id). */
  bestHost(): VillagerId | null {
    // Every awake mind asks this each minute of the morning; the roster only changes on register.
    if (this.host) return this.host.id;
    let best: { id: VillagerId; s: number } | null = null;
    for (const m of [...this.minds.values()].sort((a, b) => compareIds(a.id, b.id))) {
      if (m.profile.transient) continue;
      const s = hostScore(m.profile);
      if (!best || s > best.s) best = { id: m.id, s };
    }
    this.host = { id: best?.id ?? null };
    return this.host.id;
  }

  /** Some villager is still waiting for this morning's plan: other LLM work stands aside. */
  dawnRush(): boolean {
    for (const m of this.minds.values()) if (m.dawnPlanPending?.()) return true;
    return false;
  }

  /** Minds whose plan for tomorrow is being asked right now. */
  tomorrowPrepares(): number {
    let n = 0;
    for (const m of this.minds.values()) if (m.preparingTomorrow?.()) n++;
    return n;
  }

  proposalsOn(day: number): number {
    return this.proposals.get(day) ?? 0;
  }

  countProposal(t: GameMinutes): void {
    const d = dayOf(t);
    this.proposals.set(d, this.proposalsOn(d) + 1);
  }

  /** One "LLM vs fallback" log line per day across the village. */
  claimStatsLog(day: number): boolean {
    if (this.statsLogged.has(day)) return false;
    this.statsLogged.add(day);
    return true;
  }

  /** One ensure-daily proposal per day across the village. */
  claimDaily(day: number, id: VillagerId): boolean {
    const c = this.claims.get(day);
    if (c && c !== id) return false;
    this.claims.set(day, id);
    return true;
  }
}

const villages = new WeakMap<LlmQueue, Village<MindLike>>();

export function villageFor<M extends MindLike>(queue: LlmQueue): Village<M> {
  let v = villages.get(queue);
  if (!v) {
    v = new Village(queue);
    villages.set(queue, v);
  }
  return v as unknown as Village<M>;
}

/**
 * Embeddings through the queue's embedding lane. Each memory is sent at once (the queue batches
 * calls made in the same tick), so the job is visible to `queue.drain()` immediately.
 */
/**
 * Longest real-time wait for a query embedding. With one local model server the embedding waits
 * behind whole chat generations; past this, retrieval goes on with keyword relevance instead of
 * holding up the reply, plan or line that needs the memories.
 */
export const EMBED_QUERY_TIMEOUT = { ms: 4_000 };

export class QueueEmbedder implements Embedder {
  private disabled = false;
  private consecutiveNulls = 0;
  private inflight = new Set<Memory>();
  private cache = new Map<string, number[]>();

  constructor(private readonly queue: LlmQueue) {}

  get enabled(): boolean {
    return !this.disabled;
  }

  request(memory: Memory): void {
    if (this.disabled || memory.embedding || memory.meta.archived || this.inflight.has(memory)) return;
    this.inflight.add(memory);
    let call: Promise<number[][] | null>;
    try {
      call = this.queue.embed([memory.text]);
    } catch {
      this.inflight.delete(memory);
      return;
    }
    call
      .then((vecs) => {
        if (vecs === null) {
          this.noteNull();
          return;
        }
        this.consecutiveNulls = 0;
        const v = vecs[0];
        // Archived while the call was out: it is never retrieved, so the vector is not kept.
        if (v && v.length && !memory.meta.archived) memory.embedding = v;
      })
      // Embedding failures leave the memory on keyword relevance.
      .catch(() => {})
      .finally(() => this.inflight.delete(memory));
  }
  async embedQuery(text: string): Promise<number[] | null> {
    if (this.disabled) return null;
    const key = text.slice(0, 500);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), EMBED_QUERY_TIMEOUT.ms);
        timer.unref?.();
      });
      const vecs = await Promise.race([this.queue.embed([key]), timeout]).finally(() => clearTimeout(timer));
      if (vecs === 'timeout') return null;
      if (vecs === null) {
        this.noteNull();
        return null;
      }
      this.consecutiveNulls = 0;
      const v = vecs[0];
      if (!v || v.length === 0) return null;
      this.cache.set(key, v);
      if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
      return v;
    } catch {
      return null;
    }
  }

  /**
   * The queue returns null both when embeddings are off for good and when one batch failed, so
   * only stop asking once the queue says embeddings are gone (or after repeated nulls from a queue
   * that does not expose that flag). Returns whether embeddings are now disabled.
   */
  private noteNull(): boolean {
    this.consecutiveNulls++;
    const available = (this.queue as { embeddingsAvailable?: unknown }).embeddingsAvailable;
    if (available === false || (typeof available !== 'boolean' && this.consecutiveNulls >= 3))
      this.disabled = true;
    return this.disabled;
  }
}
