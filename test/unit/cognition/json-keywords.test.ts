import { describe, expect, it } from 'vitest';
import { parseClockLoose, parseJsonLoose } from '../../../src/server/cognition/json.ts';
import { bm25Scores, extractKeywords, stem } from '../../../src/server/cognition/keywords.ts';

describe('parseJsonLoose', () => {
  it('handles fences, prose, trailing commas, single quotes, unquoted keys and truncation', () => {
    expect(parseJsonLoose('```json\n{"a": 1,}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Sure! Here is the plan: {"say": "hi", "end": false} Hope it helps.')).toEqual({
      say: 'hi',
      end: false,
    });
    expect(parseJsonLoose("{'reply': 'Thanks!'}")).toEqual({ reply: 'Thanks!' });
    expect(parseJsonLoose('{accept: true, reason: "fun"}')).toEqual({ accept: true, reason: 'fun' });
    expect(parseJsonLoose('{"accept": True}')).toEqual({ accept: true });
    expect(parseJsonLoose('{"ratings": [3, 5, 7')).toEqual({ ratings: [3, 5, 7] });
    expect(parseJsonLoose('“{“say”: “hello”}”')).toEqual({ say: 'hello' });
    expect(parseJsonLoose('no json here')).toBeUndefined();
  });

  it('parses times the way small models write them', () => {
    expect(parseClockLoose('09:30')).toBe(570);
    expect(parseClockLoose('9am')).toBe(540);
    expect(parseClockLoose('2:15 PM')).toBe(14 * 60 + 15);
    expect(parseClockLoose(14)).toBe(840);
    expect(parseClockLoose('12 am')).toBe(0);
    expect(parseClockLoose('noonish')).toBeUndefined();
  });
});

describe('keywords', () => {
  it('stems and drops stopwords', () => {
    expect(stem('baking')).toBe(stem('baked'));
    expect(extractKeywords('The mayor’s cat is named Biscuit')).toEqual(['mayor', 'cat', 'nam', 'biscuit']);
  });

  it('BM25 ranks the matching document first', () => {
    const docs = [
      extractKeywords('I watered the tomatoes'),
      extractKeywords('Mia is hosting a bake-off at the plaza'),
      [],
    ];
    const s = bm25Scores(extractKeywords('bake-off plaza'), docs);
    expect(s[1]).toBeGreaterThan(s[0]!);
    expect(s[2]).toBe(0);
  });
});
