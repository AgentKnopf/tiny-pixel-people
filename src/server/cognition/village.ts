/**
 * State shared by all minds of one engine. Minds only receive per-villager deps, so the shared
 * part is keyed by the engine's LlmQueue (one queue per engine).
 */
import { dayOf } from '../../shared/time.ts';
import type { GameMinutes, Memory, VillagerId, VillagerProfile } from '../../shared/types.ts';
import type { LlmQueue } from '../llm/types.ts';
import type { Embedder } from './memory.ts';

interface MindLike {
  readonly id: VillagerId;
  readonly profile: VillagerProfile;
}

const HOSTY =
  /bak|cook|chef|host|party|social|organi|festiv|cheer|outgoing|friendly|mayor|music|baker|caf|garden|teacher|event|fun/gi;

export function hostScore(p: VillagerProfile): number {
  const text = `${p.occupation} ${p.occupation} ${p.bio} ${p.traits.join(' ')}`;
  return (text.match(HOSTY) ?? []).length;
}

export class Village<M extends MindLike = MindLike> {
  readonly minds = new Map<VillagerId, M>();
  readonly embedder: QueueEmbedder;
  private proposals = new Map<number, number>();
  private claims = new Map<number, VillagerId>();

  constructor(queue: LlmQueue) {
    this.embedder = new QueueEmbedder(queue);
  }

  register(mind: M): void {
    this.minds.set(mind.id, mind);
  }

  /** Who should make sure a daily event exists (most "hosty" resident; ties by id). */
  bestHost(): VillagerId | null {
    let best: { id: VillagerId; s: number } | null = null;
    for (const m of [...this.minds.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (m.profile.transient) continue;
      const s = hostScore(m.profile);
      if (!best || s > best.s) best = { id: m.id, s };
    }
    return best?.id ?? null;
  }

  proposalsOn(day: number): number {
    return this.proposals.get(day) ?? 0;
  }

  countProposal(t: GameMinutes): void {
    const d = dayOf(t);
    this.proposals.set(d, this.proposalsOn(d) + 1);
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

/** Batched, cached embeddings through the queue's embedding lane. */
export class QueueEmbedder implements Embedder {
  private disabled = false;
  private pending: Memory[] = [];
  private scheduled = false;
  private cache = new Map<string, number[]>();

  constructor(private readonly queue: LlmQueue) {}

  get enabled(): boolean {
    return !this.disabled;
  }

  request(memory: Memory): void {
    if (this.disabled || memory.embedding) return;
    this.pending.push(memory);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => void this.flush());
    }
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    while (this.pending.length > 0 && !this.disabled) {
      const batch = this.pending.splice(0, 16);
      try {
        const vecs = await this.queue.embed(batch.map((m) => m.text));
        if (vecs === null) {
          this.disabled = true;
          this.pending = [];
          return;
        }
        batch.forEach((m, i) => {
          const v = vecs[i];
          if (v && v.length) m.embedding = v;
        });
      } catch {
        // Embedding failures leave those memories on keyword relevance.
      }
    }
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
      const vecs = await this.queue.embed([key]);
      if (vecs === null) {
        this.disabled = true;
        return null;
      }
      const v = vecs[0];
      if (!v || v.length === 0) return null;
      this.cache.set(key, v);
      if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
      return v;
    } catch {
      return null;
    }
  }
}
