/** Archived memories (and earlier days' plans) are never retrieved, so they keep no embedding. */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Memory } from '../../../src/shared/types.ts';
import { type Embedder, MemoryStore } from '../../../src/server/cognition/memory.ts';
import { QueueEmbedder } from '../../../src/server/cognition/village.ts';
import { MockChatProvider, MockEmbeddingProvider } from '../../../src/server/llm/providers/mock.ts';
import { JsonSaveStore } from '../../../src/server/persistence/json-store.ts';
import { createTestWorld } from '../../helpers/world.ts';
import { DirectQueue } from './helpers.ts';

const weights = { recency: 1, importance: 1, relevance: 1 };
const DAY = 1440;
const vec = () => [0.6, 0.8, 0];

function spyEmbedder(): Embedder & { requested: Memory[] } {
  const requested: Memory[] = [];
  return {
    requested,
    request: (m) => {
      requested.push(m);
      m.embedding = vec();
    },
    embedQuery: async () => vec(),
  };
}

function mem(id: string, kind: Memory['kind'], at: number, meta: Memory['meta'] = {}): Memory {
  return {
    id: `ada-m${id}`,
    villagerId: 'ada',
    kind,
    text: `${kind} ${id} about bread`,
    createdAt: at,
    lastAccessedAt: at,
    importance: 3,
    keywords: ['bread'],
    meta,
    embedding: vec(),
  };
}

describe('embeddings of memories that are never retrieved', () => {
  it('archiving drops the embedding; memories still retrieved keep theirs', () => {
    const e = spyEmbedder();
    const s = new MemoryStore('ada', { weights, defaultK: 5, embedder: e });
    const trivial = s.add({ at: 0, kind: 'observation', text: 'Ben is walking by', importance: 2 });
    const event = s.add({ at: 0, kind: 'event', text: 'Bread festival happened', importance: 6 });
    const log = s.add({ at: 0, kind: 'note', text: '📒 Note: milk', importance: 3, meta: { keepId: 'k1' } });
    const fresh = s.add({
      at: 2.5 * DAY,
      kind: 'note',
      text: '📒 Note: eggs',
      importance: 3,
      meta: { keepId: 'k2' },
    });
    expect(s.archiveOld(3 * DAY)).toBe(1);
    s.archiveLog(3 * DAY, DAY);
    for (const m of [trivial, log]) expect(m.meta.archived && m.embedding).toBeUndefined();
    for (const m of [event, fresh]) expect(m.embedding).toEqual(vec());
  });

  it('releases the embeddings of earlier days’ plans at night, not today’s', () => {
    const s = new MemoryStore('ada', { weights, defaultK: 5, embedder: spyEmbedder() });
    const old = s.add({ at: 400, kind: 'plan', text: 'My plan for day 1: bake' });
    const today = s.add({ at: DAY + 400, kind: 'plan', text: 'My plan for day 2: sell' });
    expect(s.releaseEmbeddings(DAY + 500)).toBe(1);
    expect(old.embedding).toBeUndefined();
    expect(today.embedding).toEqual(vec());
  });

  it('loads an old save without those embeddings and never sends them to be embedded', () => {
    const e = spyEmbedder();
    const s = new MemoryStore('ada', { weights, defaultK: 5, embedder: e });
    const snapshot = [
      mem('1', 'observation', 0, { archived: true }),
      mem('2', 'note', 0, { archived: true, keepId: 'k1' }),
      mem('3', 'plan', 400),
      mem('4', 'event', 0),
      { ...mem('5', 'heard', 0), embedding: undefined },
      { ...mem('6', 'observation', 0, { archived: true }), embedding: undefined },
    ];
    s.load(snapshot, 3 * DAY);
    const by = (id: string) => s.get(`ada-m${id}`)!;
    for (const id of ['1', '2', '3', '6']) {
      expect(by(id).embedding, id).toBeUndefined();
      expect('embedding' in by(id), id).toBe(false);
    }
    expect(by('4').embedding).toEqual(vec());
    // Only the retrievable memory without a vector is (re-)embedded.
    expect(e.requested.map((m) => m.id)).toEqual(['ada-m5']);
    // The snapshot itself is not modified.
    expect(snapshot[0]!.embedding).toEqual(vec());
  });

  it('a vector that arrives after the memory was archived is not kept', async () => {
    const queue = new DirectQueue(new MockChatProvider(), new MockEmbeddingProvider());
    const s = new MemoryStore('ada', { weights, defaultK: 5, embedder: new QueueEmbedder(queue) });
    const m = s.add({ at: 0, kind: 'observation', text: 'Ben is walking by', importance: 2 });
    s.archiveOld(3 * DAY);
    await queue.drain();
    expect(m.embedding).toBeUndefined();
    // Nor is an archived memory sent to be embedded again.
    const calls = vi.spyOn(queue, 'embed');
    new QueueEmbedder(queue).request(m);
    expect(calls).not.toHaveBeenCalled();
  });

  it('retrieval that includes archived memories ranks them by keywords and does not re-embed them', async () => {
    const e = spyEmbedder();
    const s = new MemoryStore('ada', { weights, defaultK: 5, embedder: e });
    s.add({ at: 0, kind: 'observation', text: 'Ben is walking to the farm', importance: 2 });
    s.add({ at: 0, kind: 'event', text: 'Bread festival happened', importance: 6 });
    s.archiveOld(3 * DAY);
    e.requested.length = 0;
    const got = await s.retrieve('walking farm', 3 * DAY, { includeArchived: true });
    expect(got.map((m) => m.kind)).toContain('observation');
    expect(e.requested).toEqual([]);
    expect(s.all().find((m) => m.kind === 'observation')!.embedding).toBeUndefined();
  });
});

describe('an old save with archived embeddings, through the engine and the save store', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads, drops them without embedding calls, and saves and reloads smaller files', async () => {
    const w = await createTestWorld({ villagers: 6, startAt: '06:00' });
    await w.advanceTo(3 * DAY + 360, { chunk: 10 });
    const save = w.engine.toSaveData();
    w.dispose();
    // What older code saved: every archived memory and old plan still has its vector.
    let stale = 0;
    for (const mind of save.minds)
      for (const m of mind.memories)
        if (m.meta.archived || (m.kind === 'plan' && m.createdAt < 3 * DAY)) {
          m.embedding = [...vec(), ...new Array<number>(61).fill(0)];
          stale++;
        }
    expect(stale).toBeGreaterThan(50);
    const dir = mkdtempSync(join(tmpdir(), 'tpp-arch-'));
    const size = (slot: string) =>
      readdirSync(join(dir, slot, 'memories')).reduce(
        (n, f) => n + readFileSync(join(dir, slot, 'memories', f)).length,
        0,
      );
    await new JsonSaveStore({ dir, slot: 'old' }).save(save);
    const loaded = (await new JsonSaveStore({ dir, slot: 'old' }).load())!;
    expect(loaded.minds.flatMap((m) => m.memories).filter((m) => m.meta.archived && m.embedding).length).toBe(
      save.minds.flatMap((m) => m.memories).filter((m) => m.meta.archived).length,
    );

    const archivedIds = new Set(
      loaded.minds.flatMap((m) => m.memories.filter((x) => x.meta.archived).map((x) => x.id)),
    );
    expect(archivedIds.size).toBeGreaterThan(50);
    const requested: string[] = [];
    const real = QueueEmbedder.prototype.request;
    vi.spyOn(QueueEmbedder.prototype, 'request').mockImplementation(function (this: QueueEmbedder, m) {
      requested.push(m.id);
      real.call(this, m);
    });
    const embedCalls = vi.spyOn(MockEmbeddingProvider.prototype, 'embed');
    const w2 = await createTestWorld({ villagers: 6, restore: loaded });
    await w2.advance(60);
    expect(requested.filter((id) => archivedIds.has(id))).toEqual([]);
    // The embedding lane only sees new memories and queries, not the backlog of archived ones.
    expect(embedCalls.mock.calls.length).toBeLessThan(archivedIds.size);
    for (const p of w2.engine.profiles)
      for (const m of w2.memories(p.id)) if (m.meta.archived) expect(m.embedding, m.id).toBeUndefined();
    // Retrievable memories kept their vectors through the round trip.
    expect(w2.memories(w2.engine.profiles[0]!.id).some((m) => !m.meta.archived && m.embedding?.length)).toBe(
      true,
    );

    const resaved = w2.engine.toSaveData();
    w2.dispose();
    await new JsonSaveStore({ dir, slot: 'new' }).save(resaved);
    expect(size('new')).toBeLessThan(size('old'));
    const files = readdirSync(join(dir, 'new', 'memories')).map(
      (f) =>
        JSON.parse(readFileSync(join(dir, 'new', 'memories', f), 'utf8')) as {
          memories: Record<string, unknown>[];
        },
    );
    const stored = files.flatMap((f) => f.memories);
    expect(stored.filter((m) => (m.meta as Memory['meta']).archived && m.embeddingB64)).toEqual([]);
    const again = (await new JsonSaveStore({ dir, slot: 'new' }).load())!;
    expect(again.minds.flatMap((m) => m.memories).length).toBe(stored.length);
  }, 120_000);
});
