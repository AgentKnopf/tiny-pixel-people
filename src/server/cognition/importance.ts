/** Importance heuristics (spec §7.1). LLM ratings arrive later in batches and replace these. */
import type { MemoryKind } from '../../shared/types.ts';

export const KIND_IMPORTANCE: Record<MemoryKind, number> = {
  note: 8,
  heard: 5,
  event: 6,
  conversation: 4,
  observation: 2,
  reflection: 7,
  plan: 3,
  summary: 5,
};

const TRIVIAL = /\b(is|are) (walking|idle|standing|sleeping|resting|wandering|strolling|heading)\b/i;
const EXCITING =
  /\b(birthday|party|wedding|married|engaged|pregnant|baby|died|death|fire|sick|ill|hurt|injur\w*|secret|love|crush|fight|stolen|thief|lost|festival|bake-?off|contest|competition|won|winner|surprise|stranger|accident|news|announce\w*)\b/i;

/** True for perception that never needs an LLM rating ("X is walking"). */
export function isTrivialObservation(kind: MemoryKind, text: string): boolean {
  return kind === 'observation' && TRIVIAL.test(text) && !EXCITING.test(text);
}

export function heuristicImportance(kind: MemoryKind, text: string): number {
  let v = KIND_IMPORTANCE[kind];
  if (isTrivialObservation(kind, text)) return 2;
  if (EXCITING.test(text)) v += 2;
  return Math.max(1, Math.min(10, v));
}
