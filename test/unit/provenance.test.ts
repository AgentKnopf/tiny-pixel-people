import { describe, expect, it } from 'vitest';
import { formatReport, type CheckResult } from '../helpers/checks.ts';
import { attachProvenance, fromTaskStats, provenance, type ProvenanceInput } from '../helpers/provenance.ts';

const base: ProvenanceInput = { plans: [], gossipHits: [], note: undefined, goodEvents: [], taskStats: {} };

describe('live provenance', () => {
  it('AC2 counts plan sources', () => {
    const p = (source: string) => ({ source });
    expect(provenance('AC2', { ...base, plans: [p('llm'), p('llm')] }).via).toBe('llm');
    expect(provenance('AC2', { ...base, plans: [p('fallback'), null] }).via).toBe('fallback');
    const mixed = provenance('AC2', { ...base, plans: [p('llm'), p('fallback'), p('llm')] });
    expect(mixed).toEqual({ via: 'mixed', detail: '2/3 plans tagged llm' });
  });

  it('prefers per-item tags over queue stats', () => {
    const stats = { 'convo.turn': { done: 0, failed: 4, avgLatencyMs: 0 } };
    const hits = [{ text: 'Biscuit!', source: 'llm' }];
    expect(provenance('AC3', { ...base, gossipHits: hits, taskStats: stats }).via).toBe('llm');
    expect(provenance('AC4', { ...base, note: { replySource: 'fallback' } }).via).toBe('fallback');
  });

  it('untagged output: zero successful calls means fallback, otherwise unknown', () => {
    const none = { 'event.propose': { done: 0, failed: 2, avgLatencyMs: 0 } };
    expect(provenance('AC5', { ...base, goodEvents: [{}], taskStats: none }).via).toBe('fallback');
    const some = { 'note.reply': { done: 1, failed: 0, avgLatencyMs: 5 } };
    expect(provenance('AC4', { ...base, note: {}, taskStats: some }).via).toBe('unknown');
    expect(fromTaskStats(undefined, ['convo.turn']).via).toBe('unknown');
  });

  it('non-model checks and failed checks are n/a', () => {
    expect(provenance('AC1', base).via).toBe('n/a');
    expect(provenance('AC3', base).via).toBe('n/a');
  });

  it('formatReport prints the source and an LLM tally', () => {
    const results: CheckResult[] = [
      { id: 'AC1', title: 'up', pass: true, detail: 'ok' },
      { id: 'AC3', title: 'gossip', pass: true, detail: 'heard' },
      { id: 'AC5', title: 'event', pass: true, detail: 'done' },
    ];
    const out = formatReport(
      attachProvenance(results, {
        ...base,
        gossipHits: [{ source: 'llm' }],
        goodEvents: [{}],
        taskStats: { 'event.propose': { done: 0, failed: 0, avgLatencyMs: 0 } },
      }),
    );
    expect(out).toContain('via llm: 1/1 gossip lines tagged llm');
    expect(out).toContain('via fallback: no successful LLM call');
    expect(out).toContain('3/3 checks passed (model-output checks: 1 via LLM, 1 via fallback, 0 unknown)');
  });
});
