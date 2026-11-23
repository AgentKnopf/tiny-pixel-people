import { afterEach, describe, expect, it } from 'vitest';
import { at } from '../../../src/shared/time.ts';
import type { EmbeddingProvider } from '../../../src/server/llm/types.ts';
import type { DoorNote } from '../../../src/shared/types.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import { EMBED_QUERY_TIMEOUT } from '../../../src/server/cognition/village.ts';
import { createTestVillage } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function note(over: Partial<DoorNote> = {}): DoorNote {
  return {
    id: 'note1',
    houseId: 'house_mia',
    ownerId: 'mia',
    authorId: 'player',
    text: 'Could you bake a blueberry pie for the festival?',
    postedAt: at(0, '17:00'),
    status: 'unread',
    ...over,
  };
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(10);
}

describe('door note replies are never lost', () => {
  const saved = EMBED_QUERY_TIMEOUT.ms;
  afterEach(() => {
    EMBED_QUERY_TIMEOUT.ms = saved;
  });

  it('asks for the reply even when the query embedding never comes back', async () => {
    EMBED_QUERY_TIMEOUT.ms = 50;
    const stuck: EmbeddingProvider = {
      kind: 'mock',
      model: 'stuck',
      embed: () => new Promise<number[][]>(() => {}),
    } as unknown as EmbeddingProvider;
    const p = new MockChatProvider();
    p.setScript('note.reply', () => 'Of course, one blueberry pie coming up!');
    const v = createTestVillage({ start: at(0, '18:00'), provider: p, embeddings: stuck });
    v.notes.push(note());
    v.minds.get('mia')!.onArrive(v.view('mia'), 'house_mia');
    expect(v.notes[0]!.status).toBe('read');
    await until(() => v.notes[0]!.status === 'replied');
    expect(v.queue.count('note.reply')).toBe(1);
    expect(v.notes[0]).toMatchObject({ status: 'replied', replySource: 'llm' });
  });

  it('stops waiting for the query embedding after a few game minutes', async () => {
    EMBED_QUERY_TIMEOUT.ms = 60_000;
    const stuck: EmbeddingProvider = {
      kind: 'mock',
      model: 'stuck',
      embed: () => new Promise<number[][]>(() => {}),
    } as unknown as EmbeddingProvider;
    const p = new MockChatProvider();
    p.setScript('note.reply', () => 'Of course, one blueberry pie coming up!');
    const v = createTestVillage({ start: at(0, '18:00'), provider: p, embeddings: stuck });
    v.notes.push(note());
    v.minds.get('mia')!.onArrive(v.view('mia'), 'house_mia');
    await sleep(150);
    expect(v.queue.count('note.reply')).toBe(0);
    v.time.now = at(0, '18:15');
    await until(() => v.notes[0]!.status === 'replied');
    expect(v.queue.count('note.reply')).toBe(1);
  });

  it('posts a fallback reply when the model does not answer in time', async () => {
    const p = new MockChatProvider();
    p.setScript('note.reply', () => new Promise<string>(() => {}));
    const v = createTestVillage({ start: at(0, '18:00'), provider: p });
    v.notes.push(note());
    v.minds.get('mia')!.onArrive(v.view('mia'), 'house_mia');
    await until(() => v.queue.count('note.reply') === 1);
    expect(v.notes[0]!.status).toBe('read');
    v.time.now = at(0, '21:30');
    await until(() => v.notes[0]!.status === 'replied');
    expect(v.notes[0]).toMatchObject({ status: 'replied', replySource: 'fallback' });
    expect(v.notes[0]!.reply).toMatch(/blueberry pie/i);
  });

  it('answers a note that was read but never replied to (e.g. restored from a save)', async () => {
    const p = new MockChatProvider();
    p.setScript('note.reply', () => 'Of course, one blueberry pie coming up!');
    const v = createTestVillage({ start: at(0, '18:00'), provider: p });
    v.notes.push(note({ status: 'read', readAt: at(0, '12:00') }));
    await v.advanceTo(at(0, '18:02'));
    expect(v.queue.count('note.reply')).toBe(1);
    expect(v.notes[0]).toMatchObject({ status: 'replied', replySource: 'llm' });
    await v.advanceTo(at(0, '18:10'));
    expect(v.queue.count('note.reply')).toBe(1);
  });
});
