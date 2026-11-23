import { describe, expect, it } from 'vitest';
import { MockChatProvider, MockEmbeddingProvider } from '../../src/server/llm/providers/mock.ts';

describe('mock provider', () => {
  it('returns JSON per task and supports scripted answers', async () => {
    const p = new MockChatProvider('mock-model');
    const r = await p.chat({ task: 'event.decide', messages: [{ role: 'user', content: 'x' }] });
    expect(JSON.parse(r.text)).toMatchObject({ accept: true });
    expect(r.model).toBe('mock-model');
    p.setScript('note.reply', () => JSON.stringify({ reply: 'scripted' }));
    const s = await p.chat({ task: 'note.reply', messages: [] });
    expect(JSON.parse(s.text)).toEqual({ reply: 'scripted' });
  });

  it('produces deterministic unit-length embeddings', async () => {
    const e = new MockEmbeddingProvider();
    const [a, b] = await e.embed(['the bakery smells nice', 'the bakery smells nice']);
    expect(a).toEqual(b);
    expect(Math.hypot(...a!)).toBeCloseTo(1);
  });
});
