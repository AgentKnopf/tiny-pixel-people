import { describe, expect, it } from 'vitest';
import type { GameMinutes, Memory } from '../../../src/shared/types.ts';
import {
  RECENCY_DECAY_PER_HOUR,
  scoreMemories,
  type ScoreWeights,
} from '../../../src/server/cognition/retrieval.ts';
import { bm25Scores, cosine } from '../../../src/server/cognition/keywords.ts';

const WEIGHTS: ScoreWeights = { recency: 1, importance: 1.5, relevance: 2 };

/** scoreMemories as it was before the fast paths: the reference results must stay identical. */
function reference(
  candidates: readonly Memory[],
  now: GameMinutes,
  queryKeywords: readonly string[],
  queryEmbedding: readonly number[] | null,
  weights: ScoreWeights,
) {
  if (candidates.length === 0) return [];
  const normalise = (xs: number[]) => {
    if (xs.length === 0) return xs;
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    if (hi - lo < 1e-9) return xs.map(() => (hi > 0 ? 1 : 0));
    return xs.map((x) => (x - lo) / (hi - lo));
  };
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

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const WORDS = ['bread', 'bakery', 'rumor', 'heron', 'market', 'kite', 'festival', 'letter', 'cat', 'rain'];

function memories(r: () => number, n: number, embedded: number): Memory[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `v-m${i}`,
    villagerId: 'v',
    kind: 'observation',
    text: '',
    createdAt: i * 7,
    lastAccessedAt: i * 7 + Math.floor(r() * 500),
    importance: 1 + Math.floor(r() * 10),
    keywords: Array.from({ length: 1 + Math.floor(r() * 5) }, () => WORDS[Math.floor(r() * WORDS.length)]!),
    meta: {},
    ...(r() < embedded ? { embedding: Array.from({ length: 8 }, () => r() * 2 - 1) } : {}),
  }));
}

describe('scoreMemories', () => {
  it('gives exactly the old scores and order, with and without embeddings', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = rng(seed);
      for (const embedded of [0, 0.5, 0.99, 1]) {
        const ms = memories(r, 1 + Math.floor(r() * 300), embedded);
        const now = ms.length * 7 + 200;
        const kw = Array.from({ length: Math.floor(r() * 4) }, () => WORDS[Math.floor(r() * WORDS.length)]!);
        for (const q of [null, Array.from({ length: 8 }, () => r() * 2 - 1)])
          expect(scoreMemories(ms, now, kw, q, WEIGHTS)).toEqual(reference(ms, now, kw, q, WEIGHTS));
      }
    }
    // Ties everywhere (one memory, identical memories, zero vectors).
    const one = memories(rng(9), 1, 1);
    expect(scoreMemories(one, 50, ['bread'], [1, 0, 0, 0, 0, 0, 0, 0], WEIGHTS)).toEqual(
      reference(one, 50, ['bread'], [1, 0, 0, 0, 0, 0, 0, 0], WEIGHTS),
    );
    const same = Array.from({ length: 5 }, (_, i) => ({
      ...one[0]!,
      id: `s${i}`,
      embedding: new Array(8).fill(0),
    }));
    expect(scoreMemories(same, 50, [], new Array(8).fill(0), WEIGHTS)).toEqual(
      reference(same, 50, [], new Array(8).fill(0), WEIGHTS),
    );
  });

  it('skips keyword scoring when every candidate is ranked by embedding', () => {
    let reads = 0;
    const ms = memories(rng(7), 50, 1).map((m) => {
      const kw = m.keywords;
      return Object.defineProperty({ ...m }, 'keywords', {
        get: () => (reads++, kw),
      }) as Memory;
    });
    scoreMemories(
      ms,
      1000,
      ['bread'],
      Array.from({ length: 8 }, () => 0.5),
      WEIGHTS,
    );
    expect(reads).toBe(0);
    scoreMemories(ms, 1000, ['bread'], null, WEIGHTS);
    expect(reads).toBeGreaterThan(0);
  });

  it('handles more candidates than a spread call can take', () => {
    const ms = Array.from({ length: 200_000 }, (_, i) => ({
      id: `v-m${i}`,
      villagerId: 'v',
      kind: 'observation' as const,
      text: '',
      createdAt: i,
      lastAccessedAt: i,
      importance: 1 + (i % 10),
      keywords: i % 1000 === 0 ? ['bread'] : [],
      meta: {},
    }));
    const top = scoreMemories(ms, 200_000, ['bread'], null, WEIGHTS);
    expect(top).toHaveLength(200_000);
    expect(top[0]!.memory.keywords).toEqual(['bread']);
  });
});
