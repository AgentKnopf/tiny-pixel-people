/**
 * Live-run attribution: did a check pass on real LLM output or on a deterministic fallback?
 *
 * Uses the per-item `source` tag where the shared types carry one (DayPlan.source today; optional
 * tags on conversation lines, events and note replies are read when present). Without a tag the
 * per-task queue stats are the only evidence, and they are one-sided: zero successful calls proves
 * a fallback, but a successful call can still fail to parse and fall back, so that case is
 * "unknown".
 */
import type { StatsMsg } from '../../src/shared/protocol.ts';
import type { CheckResult } from './checks.ts';

export type Via = 'llm' | 'fallback' | 'mixed' | 'unknown' | 'n/a';

export interface Provenance {
  via: Via;
  detail: string;
}

export type TaskStats = NonNullable<StatsMsg['queue']['byTask']>;

type Tagged = { source?: unknown };

function tagOf(x: unknown): 'llm' | 'fallback' | undefined {
  const s = (x as Tagged | null | undefined)?.source;
  return s === 'llm' || s === 'fallback' ? s : undefined;
}

/** Combine per-item tags; `undefined` when no item carries one. */
export function fromTags(tags: readonly ('llm' | 'fallback' | undefined)[], noun: string): Provenance | undefined {
  const known = tags.filter((t): t is 'llm' | 'fallback' => t !== undefined);
  if (known.length === 0) return undefined;
  const llm = known.filter((t) => t === 'llm').length;
  const via: Via = llm === known.length ? 'llm' : llm === 0 ? 'fallback' : 'mixed';
  const untagged = tags.length - known.length;
  return {
    via,
    detail: `${llm}/${known.length} ${noun} tagged llm${untagged ? `, ${untagged} untagged` : ''}`,
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
  plans: readonly ({ source?: unknown } | null)[];
  /** Conversation lines that satisfied AC3. */
  gossipHits: readonly unknown[];
  /** The note AC4 judged. */
  note: object | undefined;
  /** Events that satisfied AC5 (done, enough attendees). */
  goodEvents: readonly unknown[];
  taskStats: TaskStats | undefined;
}

export function provenance(id: string, input: ProvenanceInput): Provenance {
  switch (id) {
    case 'AC2': {
      const p = fromTags(input.plans.map(tagOf), 'plans');
      return p ?? { via: 'unknown', detail: 'no plans' };
    }
    case 'AC3':
      if (input.gossipHits.length === 0) return { via: 'n/a', detail: 'no qualifying line' };
      return (
        fromTags(input.gossipHits.map(tagOf), 'gossip lines') ??
        fromTaskStats(input.taskStats, ['convo.turn'])
      );
    case 'AC4': {
      if (!input.note) return { via: 'n/a', detail: 'no note' };
      const s = (input.note as { replySource?: unknown }).replySource;
      if (s === 'llm' || s === 'fallback') return { via: s, detail: `note reply tagged ${s}` };
      return fromTaskStats(input.taskStats, ['note.reply']);
    }
    case 'AC5':
      if (input.goodEvents.length === 0) return { via: 'n/a', detail: 'no qualifying event' };
      return (
        fromTags(input.goodEvents.map(tagOf), 'events') ??
        fromTaskStats(input.taskStats, ['event.propose', 'plan.day'])
      );
    default:
      return { via: 'n/a', detail: 'not model output' };
  }
}

export function attachProvenance(results: CheckResult[], input: ProvenanceInput): CheckResult[] {
  return results.map((r) => ({ ...r, via: provenance(r.id, input) }));
}
