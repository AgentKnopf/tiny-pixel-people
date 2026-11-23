import type { LearnedFact } from '../cognition/types.ts';
import { PLAYER_ID, type Memory, type Rumor, type RumorHop, type VillagerId } from '../../shared/types.ts';
import type { Ctx } from './context.ts';
import type { RumorTracker } from './types.ts';

/** Villager-started rumors: `heard` memories at least this important (spec §7.12). */
export const RUMOR_MIN_IMPORTANCE = 7;

/** Gossip tracker (spec §7.12). Hops arrive from conversation summaries via `recordHop`. */
export class Rumors implements RumorTracker {
  private rumors: Rumor[] = [];

  constructor(
    private readonly ctx: Ctx,
    restored?: Rumor[],
  ) {
    if (restored) this.rumors = structuredClone(restored);
  }

  start(
    text: string,
    startedBy: VillagerId,
    originMemoryId: string,
    at: number,
    knownBy: VillagerId[] = [],
  ): Rumor {
    const existing = this.byOrigin(originMemoryId);
    if (existing) return existing;
    const rumor: Rumor = {
      id: this.ctx.id('rumor'),
      originMemoryId,
      text,
      startedBy,
      startedAt: at,
      knownBy: [...new Set(knownBy.filter((v) => v !== PLAYER_ID))],
      hops: [],
    };
    this.rumors.push(rumor);
    this.broadcast(rumor);
    return rumor;
  }

  /** Track a learned fact from a conversation (`MindWorld.recordLearned`). */
  recordLearned(fact: LearnedFact): Rumor | null {
    return this.recordHop(fact.originId, {
      from: fact.from,
      to: fact.to,
      at: fact.at,
      text: fact.said ?? fact.text,
      ...(fact.conversationId ? { conversationId: fact.conversationId } : {}),
    });
  }

  /** Optional: auto-track important `heard` facts no rumor covers yet. Returns the new rumor, if any. */
  considerMemory(memory: Memory): Rumor | null {
    if (memory.kind !== 'heard' || memory.importance < RUMOR_MIN_IMPORTANCE) return null;
    const origin = memory.meta.originId ?? memory.id;
    if (this.byOrigin(origin)) return null;
    const from = memory.meta.heardFrom ?? memory.villagerId;
    const rumor = this.start(memory.text, from, origin, memory.createdAt, [from, memory.villagerId]);
    return rumor;
  }

  recordHop(originMemoryId: string, hop: RumorHop): Rumor | null {
    const rumor = this.byOrigin(originMemoryId);
    if (!rumor || hop.from === hop.to) return null;
    if (rumor.hops.some((h) => h.from === hop.from && h.to === hop.to)) return null;
    rumor.hops.push({ ...hop });
    for (const id of [hop.from, hop.to]) {
      if (id !== PLAYER_ID && !rumor.knownBy.includes(id)) rumor.knownBy.push(id);
    }
    this.broadcast(rumor);
    return rumor;
  }

  byOrigin(originMemoryId: string): Rumor | undefined {
    return this.rumors.find((r) => r.originMemoryId === originMemoryId);
  }

  all(): readonly Rumor[] {
    return this.rumors;
  }

  private broadcast(rumor: Rumor): void {
    this.ctx.emit({ type: 'rumor.updated', rumor: structuredClone(rumor) });
  }
}
