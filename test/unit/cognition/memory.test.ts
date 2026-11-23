import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../../src/server/cognition/memory.ts';
import { MockEmbeddingProvider } from '../../../src/server/llm/providers/mock.ts';
import { QueueEmbedder } from '../../../src/server/cognition/village.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import { DirectQueue } from './helpers.ts';

const weights = { recency: 1, importance: 1, relevance: 1 };

describe('MemoryStore', () => {
  it('assigns ids, keywords, heuristic importance and originId', () => {
    const s = new MemoryStore('ada', { weights, defaultK: 3 });
    const a = s.add({ at: 10, kind: 'observation', text: 'Ben is walking to the farm' });
    const b = s.add({ at: 11, kind: 'note', text: 'A note about the festival' });
    const c = s.add({ at: 12, kind: 'heard', text: 'x', meta: { originId: 'fact_1', heardFrom: 'player' } });
    expect(a.id).toBe('ada-m1');
    expect(a.importance).toBe(2);
    expect(b.importance).toBeGreaterThanOrEqual(8);
    expect(a.meta.originId).toBe(a.id);
    expect(c.meta.originId).toBe('fact_1');
    expect(s.recent(2).map((m) => m.id)).toEqual([c.id, b.id]);
  });

  it('retrieves by keyword relevance and updates lastAccessedAt', async () => {
    const s = new MemoryStore('ada', { weights, defaultK: 2 });
    s.add({ at: 0, kind: 'observation', text: 'I watered the tomatoes on the farm', importance: 3 });
    s.add({
      at: 5,
      kind: 'observation',
      text: 'Mia said the bake-off is at the plaza at 15:00',
      importance: 3,
    });
    s.add({ at: 9, kind: 'observation', text: 'The sky is blue', importance: 3 });
    const top = await s.retrieve('when is the bake-off?', 120, { k: 1 });
    expect(top[0]!.text).toContain('bake-off');
    expect(top[0]!.lastAccessedAt).toBe(120);
  });

  it('excludes archived memories and old plans; archiveOld prunes trivial old observations', async () => {
    const s = new MemoryStore('ada', { weights, defaultK: 10 });
    s.add({ at: 0, kind: 'plan', text: 'My plan for day 1: bake bread' });
    s.add({ at: 0, kind: 'observation', text: 'Ben is walking by', importance: 2 });
    s.add({ at: 0, kind: 'event', text: 'Bread festival happened', importance: 6 });
    expect(s.archiveOld(3 * 1440)).toBe(1);
    const got = await s.retrieve('bread', 3 * 1440);
    expect(got.map((m) => m.kind)).toEqual(['event']);
    expect((await s.retrieve('walking', 3 * 1440, { includeArchived: true })).length).toBe(2);
  });

  it('uses embeddings when available', async () => {
    const queue = new DirectQueue(new MockChatProvider(), new MockEmbeddingProvider());
    const embedder = new QueueEmbedder(queue);
    const s = new MemoryStore('ada', {
      weights: { recency: 0, importance: 0, relevance: 1 },
      defaultK: 1,
      embedder,
    });
    s.add({ at: 0, kind: 'observation', text: 'apple pie recipe from grandma' });
    s.add({ at: 0, kind: 'observation', text: 'the fountain is broken' });
    await queue.drain();
    expect(s.all().every((m) => m.embedding?.length === 64)).toBe(true);
    const [top] = await s.retrieve('apple pie', 10);
    expect(top!.text).toContain('apple pie');
  });

  it('falls back to keywords when embeddings are off', async () => {
    const queue = new DirectQueue(new MockChatProvider(), null);
    const embedder = new QueueEmbedder(queue);
    const s = new MemoryStore('ada', { weights, defaultK: 1, embedder });
    s.add({ at: 0, kind: 'observation', text: 'the fountain is broken', importance: 3 });
    s.add({ at: 0, kind: 'observation', text: 'apple pie recipe', importance: 3 });
    await queue.drain();
    const [top] = await s.retrieve('apple pie', 10);
    expect(top!.text).toContain('apple');
    expect(embedder.enabled).toBe(false);
  });
});
