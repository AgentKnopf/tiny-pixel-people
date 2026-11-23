/**
 * Live-run attribution: did a check pass on real LLM output or on a deterministic fallback?
 *
 * Uses the per-item provenance tags from src/shared/types.ts (DayPlan.source, ConversationMessage
 * .source, VillageEvent.source, DoorNote.replySource), which say 'llm' only when the model's answer
 * parsed. The optional tags may be missing (older saves, servers without them); without a tag the
 * per-task queue stats are the only evidence, and they are one-sided: zero successful calls proves
 * a fallback, but a successful call can still fail to parse and fall back, so that case is
 * "unknown".
 */
import type { StatsMsg } from '../../src/shared/protocol.ts';
import type { Provenance as Source } from '../../src/shared/types.ts';
import type { CheckResult } from './checks.ts';

export type Via = 'llm' | 'fallback' | 'mixed' | 'unknown' | 'n/a';

export interface Provenance {
  via: Via;
  detail: string;
}

export type TaskStats = NonNullable<StatsMsg['queue']['byTask']>;

type Tagged = { source?: Source; text?: string } | null;

/**
 * Combine per-item tags; `undefined` when no item carries one. With `anyOf` (checks that one
 * qualifying item satisfies, like AC3 and AC5) a single LLM-tagged item makes the pass an LLM pass.
 */
export function fromTags(items: readonly Tagged[], noun: string, anyOf = false): Provenance | undefined {
  const known = items.filter((i) => i?.source !== undefined);
  if (known.length === 0) return undefined;
  const llmItems = known.filter((i) => i!.source === 'llm');
  const llm = llmItems.length;
  const via: Via = llm === known.length || (anyOf && llm > 0) ? 'llm' : llm === 0 ? 'fallback' : 'mixed';
  const untagged = items.length - known.length;
  const example = anyOf && llmItems[0]?.text ? `; first llm: "${llmItems[0].text.slice(0, 80)}"` : '';
  return {
    via,
    detail: `${llm}/${known.length} ${noun} tagged llm${untagged ? `, ${untagged} untagged` : ''}${example}`,
  };
}

/** Evidence from queue stats for the tasks that could have produced the output. */
export function fromTaskStats(stats: TaskStats | undefined, tasks: readonly string[]): Provenance {
  if (!stats) return { via: 'unknown', detail: 'no per-task queue stats' };
  const parts = tasks.map((t) => {
    const s = stats[t];
    return { task: t, done: s?.done ?? 0, failed: s?.failed ?? 0 };
  });
  const text = parts.map((p) => `${p.task} ${p.done} ok/${p.failed} failed`).join(', ');
  return parts.every((p) => p.done === 0)
    ? { via: 'fallback', detail: `no successful LLM call (${text})` }
    : { via: 'unknown', detail: `untagged; ${text} (a successful call may still have fallen back)` };
}

export interface ProvenanceInput {
  /** Plans judged by AC2 (midday snapshot). */
  plans: readonly Tagged[];
  /** Conversation lines that satisfied AC3. */
  gossipHits: readonly Tagged[];
  /** The note AC4 judged. */
  note: { replySource?: Source } | undefined;
  /** Events that satisfied AC5 (done, enough attendees). */
  goodEvents: readonly Tagged[];
  taskStats: TaskStats | undefined;
}

export function provenance(id: string, input: ProvenanceInput): Provenance {
  switch (id) {
    case 'AC2': {
      const p = fromTags(input.plans, 'plans');
      return p ?? { via: 'unknown', detail: 'no plans' };
    }
    case 'AC3':
      if (input.gossipHits.length === 0) return { via: 'n/a', detail: 'no qualifying line' };
      return (
        fromTags(input.gossipHits, 'gossip lines', true) ?? fromTaskStats(input.taskStats, ['convo.turn'])
      );
    case 'AC4': {
      if (!input.note) return { via: 'n/a', detail: 'no note' };
      const s = input.note.replySource;
      if (s) return { via: s, detail: `note reply tagged ${s}` };
      return fromTaskStats(input.taskStats, ['note.reply']);
    }
    case 'AC5':
      if (input.goodEvents.length === 0) return { via: 'n/a', detail: 'no qualifying event' };
      return (
        fromTags(input.goodEvents, 'events', true) ??
        fromTaskStats(input.taskStats, ['event.propose', 'plan.day'])
      );
    default:
      return { via: 'n/a', detail: 'not model output' };
  }
}

export function attachProvenance(results: CheckResult[], input: ProvenanceInput): CheckResult[] {
  return results.map((r) => ({ ...r, via: provenance(r.id, input) }));
}
