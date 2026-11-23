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

  constructor(
    readonly villagerId: VillagerId,
    private readonly opts: MemoryStoreOptions,
  ) {}

  /** Restore from a snapshot (keeps ids, continues the id sequence). */
  load(memories: readonly Memory[]): void {
    this.memories = memories.map((m) => ({ ...m, meta: { ...m.meta }, keywords: [...m.keywords] }));
    this.byId = new Map(this.memories.map((m) => [m.id, m]));
    for (const m of this.memories) {
      const n = Number(/-m(\d+)$/.exec(m.id)?.[1] ?? 0);
      if (n > this.seq) this.seq = n;
      if (!m.embedding) this.opts.embedder?.request(m);
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
    if (embedding) for (const m of candidates) if (!m.embedding) this.opts.embedder?.request(m);
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
   * Nightly pruning (spec §7.9): observations older than 2 days with importance <= 3 are archived
   * (kept in the save, excluded from retrieval). Returns the number archived.
   */
  /** Archive post office log memories (`meta.keepId`) older than `maxAge` game minutes. */
  archiveLog(now: GameMinutes, maxAge: number): number {
    let n = 0;
    for (const m of this.memories) {
      if (m.meta.archived || !m.meta.keepId || now - m.createdAt < maxAge) continue;
      m.meta.archived = true;
      n++;
    }
    return n;
  }

  archiveOld(now: GameMinutes): number {
    let n = 0;
    for (const m of this.memories) {
      if (m.meta.archived || m.kind !== 'observation' || m.importance > 3) continue;
      if (dayOf(now) - dayOf(m.createdAt) >= 2 || now - m.createdAt >= 2 * 1440) {
        m.meta.archived = true;
        n++;
      }
    }
    return n;
  }
}
