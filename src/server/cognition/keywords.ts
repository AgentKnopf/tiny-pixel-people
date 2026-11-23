/** Keyword extraction and BM25-lite relevance, used when embeddings are off or missing. */

const STOPWORDS = new Set(
  (
    'a an the and or but if then so of to in on at by for with from up down out over under about into ' +
    'is are was were be been being am do does did done have has had having i me my mine we us our you your ' +
    'he him his she her hers it its they them their this that these those there here what which who whom ' +
    'when where why how all any both each few more most other some such no nor not only own same than too ' +
    'very can will just should would could might must shall may also as get got go going went s t d ll m ' +
    're ve oh yes yeah hi hello hey okay ok really just like well today now'
  ).split(/\s+/),
);

/** Very light stemmer: strips common English suffixes so "baking"/"bakes"/"baked" share a stem. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  for (const suf of ['ing', 'ed', 'es', 's', 'ly']) {
    if (w.length > suf.length + 2 && w.endsWith(suf)) {
      w = w.slice(0, -suf.length);
      break;
    }
  }
  if (w.length > 3 && w.at(-1) === w.at(-2) && !'aeiouls'.includes(w.at(-1)!)) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9\u00c0-\u024f]+(?:'[a-z]+)?/g) ?? [];
  const out: string[] = [];
  for (const raw of words) {
    const w = raw.replace(/'[a-z]+$/, '');
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

/** Unique keywords, in order of first appearance. */
export function extractKeywords(text: string, max = 24): string[] {
  return [...new Set(tokenize(text))].slice(0, max);
}

/** Fraction of `a`'s keywords also present in `b` (0..1). */
export function keywordOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return 0;
  const set = new Set(b);
  let hit = 0;
  for (const k of a) if (set.has(k)) hit++;
  return hit / a.length;
}

/**
 * BM25-lite score of each document's keywords against the query keywords.
 * `docs` are keyword lists; returns raw (unnormalised) scores.
 */
export function bm25Scores(query: readonly string[], docs: readonly (readonly string[])[]): number[] {
  const q = [...new Set(query)];
  if (q.length === 0 || docs.length === 0) return docs.map(() => 0);
  const n = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / n || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  return docs.map((d) => {
    if (d.length === 0) return 0;
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.length) / avgLen));
    }
    return score;
  });
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
