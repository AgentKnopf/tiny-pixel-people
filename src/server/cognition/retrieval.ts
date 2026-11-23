/** Retrieval scoring (spec §7.2): recency + importance + relevance, each min-max normalised. */
import { dayOf } from '../../shared/time.ts';
import type { GameMinutes, Memory, MemoryKind } from '../../shared/types.ts';
import { bm25Scores, cosine } from './keywords.ts';

export const RECENCY_DECAY_PER_HOUR = 0.995;

export interface ScoreWeights {
  recency: number;
  importance: number;
  relevance: number;
}

export interface Scored {
  memory: Memory;
  score: number;
  recency: number;
  importance: number;
  relevance: number;
}

export function isRetrievable(
  m: Memory,
  now: GameMinutes,
  opts: { kinds?: MemoryKind[]; includeArchived?: boolean } = {},
): boolean {
  if (m.meta.archived && !opts.includeArchived) return false;
  if (opts.kinds && !opts.kinds.includes(m.kind)) return false;
  if (m.kind === 'plan' && dayOf(m.createdAt) < dayOf(now)) return false;
  return true;
}

function normalise(xs: number[]): number[] {
  if (xs.length === 0) return xs;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  if (hi - lo < 1e-9) return xs.map(() => (hi > 0 ? 1 : 0));
  return xs.map((x) => (x - lo) / (hi - lo));
}

/**
 * Score candidates for a query. Relevance uses cosine similarity when both the query and the memory
 * have embeddings, otherwise a BM25-lite keyword score (normalised to 0..1 by the best match).
 */
export function scoreMemories(
  candidates: readonly Memory[],
  now: GameMinutes,
  queryKeywords: readonly string[],
  queryEmbedding: readonly number[] | null,
  weights: ScoreWeights,
): Scored[] {
  if (candidates.length === 0) return [];
  const rec = candidates.map((m) =>
    Math.pow(RECENCY_DECAY_PER_HOUR, Math.max(0, now - m.lastAccessedAt) / 60),
  );
  const imp = candidates.map((m) => m.importance / 10);
  const kw = bm25Scores(
    queryKeywords,
    candidates.map((m) => m.keywords),
  );
  const kwMax = Math.max(...kw, 0);
  const rel = candidates.map((m, i) => {
    if (queryEmbedding && m.embedding && m.embedding.length)
      return Math.max(0, cosine(queryEmbedding, m.embedding));
    return kwMax > 0 ? kw[i]! / kwMax : 0;
  });
  const nRec = normalise(rec);
  const nImp = normalise(imp);
  const nRel = normalise(rel);
  return candidates
    .map((memory, i) => ({
      memory,
      recency: nRec[i]!,
      importance: nImp[i]!,
      relevance: nRel[i]!,
      score: weights.recency * nRec[i]! + weights.importance * nImp[i]! + weights.relevance * nRel[i]!,
    }))
    .sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt);
}
