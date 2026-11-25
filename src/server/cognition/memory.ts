/** Per-villager memory stream (spec §7.1–§7.2). */
import { dayOf } from '../../shared/time.ts';
import type { GameMinutes, Memory, MemoryId, VillagerId } from '../../shared/types.ts';
import type { MemoryStream, Observation, RetrieveOptions } from './types.ts';
import { heuristicImportance } from './importance.ts';
import { extractKeywords } from './keywords.ts';
import { isRetrievable, scoreMemories, type ScoreWeights } from './retrieval.ts';

/** Async embedding service shared by all minds (batched, cached). */
export interface Embedder {
  /** Queue a memory for embedding; sets `memory.embedding` when done. */
  request(memory: Memory): void;
  /** Embedding for a query string, or null when embeddings are unavailable. */
  embedQuery(text: string): Promise<number[] | null>;
}

export interface MemoryStoreOptions {
  weights: ScoreWeights;
  defaultK: number;
  embedder?: Embedder | null;
  /** Called after a memory is added (importance bookkeeping, rating, re-plan triggers). */
  onAdded?: (m: Memory) => void;
}

export class MemoryStore implements MemoryStream {
  private memories: Memory[] = [];
  private byId = new Map<MemoryId, Memory>();
  private seq = 0;
  private deferred: Memory[] = [];
  /** `since` cursor: every memory before `at` was created before `from`. */
  private sinceCursor = { from: -Infinity, at: 0 };

  constructor(
    readonly villagerId: VillagerId,
    private readonly opts: MemoryStoreOptions,
  ) {}

  /**
   * Restore from a snapshot (keeps ids, continues the id sequence). Memories that can never be
   * retrieved again at `now` load without their embedding and are not sent to be embedded: older
   * saves kept the vectors of every archived memory.
   */
  load(memories: readonly Memory[], now: GameMinutes = -Infinity): void {
    this.memories = memories.map((m) => {
      const copy = { ...m, meta: { ...m.meta }, keywords: [...m.keywords] };
      if (isRetrievable(copy, now)) return copy;
      const { embedding: _dropped, ...rest } = copy;
      return rest;
    });
    this.byId = new Map(this.memories.map((m) => [m.id, m]));
    this.sinceCursor = { from: -Infinity, at: 0 };
    for (const m of this.memories) {
      const n = Number(/-m(\d+)$/.exec(m.id)?.[1] ?? 0);
      if (n > this.seq) this.seq = n;
      if (!m.embedding && isRetrievable(m, now)) this.opts.embedder?.request(m);
    }
  }

  nextId(): MemoryId {
    return `${this.villagerId}-m${++this.seq}`;
  }

  /** `deferEmbedding`: hold the embedding request until `flushEmbeddings` (batched log memories). */
  add(obs: Observation, opts: { deferEmbedding?: boolean } = {}): Memory {
    const id = this.nextId();
    const text = obs.text.trim();
    const memory: Memory = {
      id,
      villagerId: this.villagerId,
      createdAt: obs.at,
      lastAccessedAt: obs.at,
      kind: obs.kind,
      text,
      importance: Math.max(
        1,
        Math.min(10, Math.round(obs.importance ?? heuristicImportance(obs.kind, text))),
      ),
      keywords: extractKeywords(text),
      meta: { ...obs.meta, originId: obs.meta?.originId ?? id },
    };
    this.memories.push(memory);
    this.byId.set(id, memory);
    if (opts.deferEmbedding) this.deferred.push(memory);
    else this.opts.embedder?.request(memory);
    this.opts.onAdded?.(memory);
    return memory;
  }

  /** Request the deferred embeddings at once (the queue batches requests made in one tick). */
  flushEmbeddings(): number {
    const n = this.deferred.length;
    for (const m of this.deferred) this.opts.embedder?.request(m);
    this.deferred = [];
    return n;
  }

  get deferredEmbeddings(): number {
    return this.deferred.length;
  }

  get(id: MemoryId): Memory | undefined {
    return this.byId.get(id);
  }

  all(): readonly Memory[] {
    return this.memories;
  }

  /** Newest first. */
  recent(n: number): Memory[] {
    return this.memories.slice(-n).reverse();
  }

  /**
   * A superset of the memories created at or after `from`, in stream order: it skips only a prefix
   * known to be older. Memories are appended roughly in time order, so for a recent `from` this is
   * a short tail; repeated calls with a non-decreasing `from` resume where the last one stopped.
   */
  since(from: GameMinutes): readonly Memory[] {
    const c = this.sinceCursor;
    if (from < c.from) c.at = 0;
    c.from = from;
    while (c.at < this.memories.length && this.memories[c.at]!.createdAt < from) c.at++;
    return this.memories.slice(c.at);
  }

  /** Memories created in [from, to). */
  between(from: GameMinutes, to: GameMinutes): Memory[] {
    return this.memories.filter((m) => m.createdAt >= from && m.createdAt < to);
  }

  hasOrigin(originId: MemoryId): boolean {
    return this.memories.some((m) => m.meta.originId === originId);
  }

  /** `giveUp`: once it settles, stop waiting for the query embedding and rank by keywords. */
  async retrieve(
    query: string,
    now: GameMinutes,
    opts: RetrieveOptions = {},
    giveUp?: Promise<unknown>,
  ): Promise<Memory[]> {
    const k = opts.k ?? this.opts.defaultK;
    const candidates = this.memories.filter((m) => isRetrievable(m, now, opts));
    if (candidates.length === 0) return [];
    const pending = this.opts.embedder ? this.opts.embedder.embedQuery(query) : null;
    const embedding = pending
      ? await (giveUp
          ? Promise.race([
              pending,
              giveUp.then(
                () => null,
                () => null,
              ),
            ])
          : pending)
      : null;
    // Memories whose embedding batch failed transiently get another try.
    if (embedding)
      for (const m of candidates) if (!m.embedding && !m.meta.archived) this.opts.embedder?.request(m);
    const top = scoreMemories(
      candidates,
      now,
      extractKeywords(query, 64),
      embedding,
      this.opts.weights,
    ).slice(0, k);
    for (const s of top) s.memory.lastAccessedAt = Math.max(s.memory.lastAccessedAt, now);
    return top.map((s) => s.memory);
  }

  /**
   * Archive post office log memories (`meta.keepId`) older than `maxAge` game minutes. Returns
   * when the next remaining one is due (Infinity when none is left).
   */
  archiveLog(now: GameMinutes, maxAge: number): GameMinutes {
    let next = Infinity;
    for (const m of this.memories) {
      if (m.meta.archived || !m.meta.keepId) continue;
      if (now - m.createdAt < maxAge) next = Math.min(next, m.createdAt + maxAge);
      else archive(m);
    }
    return next;
  }

  /**
   * Nightly pruning (spec §7.9): observations older than 2 days with importance <= 3 are archived
   * (kept in the save, excluded from retrieval). Returns the number archived.
   */
  archiveOld(now: GameMinutes): number {
    let n = 0;
    for (const m of this.memories) {
      if (m.meta.archived || m.kind !== 'observation' || m.importance > 3) continue;
      if (dayOf(now) - dayOf(m.createdAt) >= 2 || now - m.createdAt >= 2 * 1440) {
        archive(m);
        n++;
      }
    }
    return n;
  }

  /** Drop the embeddings no retrieval can use any more (earlier days' plans). Returns how many. */
  releaseEmbeddings(now: GameMinutes): number {
    let n = 0;
    for (const m of this.memories) {
      if (!m.embedding || isRetrievable(m, now)) continue;
      m.embedding = undefined;
      n++;
    }
    return n;
  }
}

/**
 * Archiving is one-way and archived memories are never retrieved, so the embedding goes: it is most
 * of a memory's size. Assigning (rather than deleting) keeps V8's compact object shape.
 */
function archive(m: Memory): void {
  m.meta.archived = true;
  m.embedding = undefined;
}
