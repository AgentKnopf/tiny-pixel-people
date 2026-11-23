import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  Autosaver,
  createReplayRecorder,
  decodeEmbedding,
  encodeEmbedding,
  JsonSaveStore,
  memoryFileName,
  SAVE_SCHEMA_VERSION,
  SaveFormatError,
  type ReplayLine,
  type SaveData,
} from '../../src/server/persistence/index.ts';
import { createPlaceholderSnapshot } from '../../src/server/sim/placeholder.ts';
import type { Memory } from '../../src/shared/types.ts';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tpp-save-'));
}

function memory(id: string, villagerId: string, embedding?: number[]): Memory {
  return {
    id,
    villagerId,
    createdAt: 400,
    lastAccessedAt: 410,
    kind: 'heard',
    text: `memory ${id}`,
    importance: 7,
    keywords: ['cat', 'biscuit'],
    meta: { heardFrom: 'player', originId: 'm0', toldTo: ['bob'] },
    ...(embedding ? { embedding } : {}),
  };
}

function sampleSave(): SaveData {
  const snap = createPlaceholderSnapshot(480, 1);
  snap.player.gold = 77;
  snap.player.inventory = [{ itemId: 'flower', count: 3 }];
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    savedAt: new Date(0).toISOString(),
    time: 480,
    rngState: 12345,
    villagers: [],
    minds: [
      {
        villagerId: 'ada',
        memories: [memory('m1', 'ada', [0.1, -0.5, 0.25, 1]), memory('m2', 'ada')],
        bookkeeping: { importanceSinceReflection: 12, lastReflectionAt: null, lastPlanAt: 360 },
      },
      {
        villagerId: 'bob',
        memories: [],
        bookkeeping: { importanceSinceReflection: 0, lastReflectionAt: 300, lastPlanAt: null },
      },
    ],
    events: [],
    notes: [
      {
        id: 'n1',
        houseId: 'house_ada',
        ownerId: 'ada',
        authorId: 'player',
        text: 'hi',
        postedAt: 400,
        status: 'unread',
      },
    ],
    conversations: [],
    player: snap.player,
    rumors: [
      {
        id: 'r1',
        originMemoryId: 'm0',
        text: 'The cat is named Biscuit',
        startedBy: 'player',
        startedAt: 420,
        knownBy: ['ada', 'bob'],
        hops: [{ from: 'ada', to: 'bob', at: 450, text: 'Did you hear about Biscuit?' }],
      },
    ],
    weather: { state: 'rain', since: 450, until: 600 },
    items: [{ id: 'g1', itemId: 'flower', pos: { x: 3, y: 4 } }],
    worldEvents: [{ id: 'w1', kind: 'rain', startedAt: 450, endsAt: 600, data: {} }],
    strangers: [],
  };
}

describe('embedding codec', () => {
  it('round-trips at float32 precision', () => {
    const v = [0.1, -0.5, 0.25, 1, 1e-7];
    const back = decodeEmbedding(encodeEmbedding(v));
    expect(back).toHaveLength(v.length);
    back.forEach((x, i) => expect(x).toBeCloseTo(v[i]!, 6));
  });

  it('rejects corrupt data', () => {
    expect(() => decodeEmbedding(Buffer.from([1, 2, 3]).toString('base64'))).toThrow(/Corrupt/);
  });
});

describe('JsonSaveStore', () => {
  it('returns null when the slot does not exist', async () => {
    const store = new JsonSaveStore({ dir: tmpDir(), slot: 'default' });
    expect(await store.exists()).toBe(false);
    expect(await store.load()).toBeNull();
  });

  it('round-trips a full save including player, rumors, weather and memories', async () => {
    const dir = tmpDir();
    const store = new JsonSaveStore({ dir, slot: 'default' });
    const data = sampleSave();
    await store.save(data);
    expect(await store.exists()).toBe(true);

    const loaded = await new JsonSaveStore({ dir, slot: 'default' }).load();
    expect(loaded).not.toBeNull();
    const { minds, ...rest } = loaded!;
    const { minds: origMinds, ...origRest } = data;
    expect(rest).toEqual(origRest);
    expect(minds.map((m) => m.villagerId)).toEqual(['ada', 'bob']);
    expect(minds[0]!.bookkeeping).toEqual(origMinds[0]!.bookkeeping);
    expect(minds[0]!.memories[1]).toEqual(origMinds[0]!.memories[1]);
    const emb = minds[0]!.memories[0]!.embedding!;
    origMinds[0]!.memories[0]!.embedding!.forEach((x, i) => expect(emb[i]).toBeCloseTo(x, 6));
  });

  it('stores memories per villager with base64 embeddings and no temp files', async () => {
    const dir = tmpDir();
    const store = new JsonSaveStore({ dir, slot: 's1' });
    await store.save(sampleSave());
    const files = readdirSync(join(dir, 's1', 'memories')).sort();
    expect(files).toEqual(['ada.json', 'bob.json']);
    const ada = JSON.parse(readFileSync(join(dir, 's1', 'memories', 'ada.json'), 'utf8'));
    expect(typeof ada.memories[0].embeddingB64).toBe('string');
    expect(ada.memories[0].embedding).toBeUndefined();
    const world = JSON.parse(readFileSync(join(dir, 's1', 'world.json'), 'utf8'));
    expect(world.minds[0].memories).toBeUndefined();
    expect(readdirSync(join(dir, 's1')).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('removes memory files of villagers who left (strangers)', async () => {
    const dir = tmpDir();
    const store = new JsonSaveStore({ dir, slot: 'default' });
    await store.save(sampleSave());
    const later = sampleSave();
    later.minds = later.minds.filter((m) => m.villagerId === 'ada');
    await store.save(later);
    expect(readdirSync(join(dir, 'default', 'memories'))).toEqual(['ada.json']);
  });

  it('is not affected by mutations after save() is called', async () => {
    const dir = tmpDir();
    const store = new JsonSaveStore({ dir, slot: 'default' });
    const data = sampleSave();
    const p = store.save(data);
    data.player.gold = 0;
    data.minds[0]!.memories.length = 0;
    await p;
    const loaded = await store.load();
    expect(loaded!.player.gold).toBe(77);
    expect(loaded!.minds[0]!.memories).toHaveLength(2);
  });

  it('serialises concurrent saves (last one wins)', async () => {
    const dir = tmpDir();
    const store = new JsonSaveStore({ dir, slot: 'default' });
    const saves = [1, 2, 3, 4, 5].map((i) => {
      const d = sampleSave();
      d.time = 480 + i;
      return store.save(d);
    });
    await Promise.all(saves);
    expect((await store.load())!.time).toBe(485);
  });

  it('reports corrupt or future-version saves clearly', async () => {
    const dir = tmpDir();
    const store = new JsonSaveStore({ dir, slot: 'default' });
    await store.save(sampleSave());
    const worldPath = join(dir, 'default', 'world.json');
    writeFileSync(worldPath, '{ broken');
    await expect(store.load()).rejects.toThrow(SaveFormatError);
    writeFileSync(worldPath, JSON.stringify({ ...sampleSave(), schemaVersion: SAVE_SCHEMA_VERSION + 1 }));
    await expect(store.load()).rejects.toThrow(/newer than supported/);
    writeFileSync(worldPath, JSON.stringify({ ...sampleSave(), rumors: undefined }));
    await expect(store.load()).rejects.toThrow(/rumors/);
  });

  it('loads with empty memories when a memory file is missing', async () => {
    const dir = tmpDir();
    const store = new JsonSaveStore({ dir, slot: 'default' });
    await store.save(sampleSave());
    const { rmSync } = await import('node:fs');
    rmSync(join(dir, 'default', 'memories', 'ada.json'));
    const loaded = await store.load();
    expect(loaded!.minds[0]!.memories).toEqual([]);
  });

  it('rejects unsafe slot names and encodes odd villager ids', () => {
    expect(() => new JsonSaveStore({ dir: tmpDir(), slot: '../evil' })).toThrow();
    expect(memoryFileName('ada')).toBe('ada.json');
    expect(memoryFileName('../x')).not.toContain('/');
  });

  it('clear() deletes the slot', async () => {
    const dir = tmpDir();
    const store = new JsonSaveStore({ dir, slot: 'default' });
    await store.save(sampleSave());
    await store.clear();
    expect(await store.exists()).toBe(false);
  });
});

describe('replay', () => {
  it('appends only replay-worthy messages as JSONL', async () => {
    const dir = tmpDir();
    const store = new JsonSaveStore({ dir, slot: 'default' });
    const record = createReplayRecorder(store, () => 500);
    record({ type: 'tick', time: 500, speed: 1, villagers: [] });
    record({
      type: 'conversation.message',
      conversationId: 'c1',
      speakerId: 'ada',
      listenerId: 'bob',
      text: 'Hi!',
      time: 500,
    });
    record({ type: 'toast', icon: '📮', text: 'x' });
    record({ type: 'weather.updated', weather: { state: 'rain', since: 500, until: null } });
    await store.save(sampleSave()); // flushes the store's write queue
    const lines = readFileSync(store.replayPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as ReplayLine);
    expect(lines.map((l) => l.msg.type)).toEqual(['conversation.message', 'weather.updated']);
    expect(lines[0]!.time).toBe(500);
  });
});

describe('Autosaver', () => {
  it('saves every N game minutes, never two at once', async () => {
    let resolveSave: () => void = () => {};
    const save = vi.fn(() => new Promise<void>((r) => (resolveSave = r)));
    let time = 0;
    const saver = new Autosaver({
      store: { save },
      intervalGameMinutes: 60,
      collect: () => ({ ...sampleSave(), time }),
    });
    saver.tick(0);
    time = 30;
    saver.tick(30);
    expect(save).not.toHaveBeenCalled();
    time = 61;
    saver.tick(61);
    expect(save).toHaveBeenCalledTimes(1);
    time = 200;
    saver.tick(200); // previous save still in flight
    expect(save).toHaveBeenCalledTimes(1);
    resolveSave();
    await new Promise((r) => setTimeout(r, 0));
    saver.tick(200);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('can be disabled with interval 0', () => {
    const save = vi.fn(async () => {});
    const saver = new Autosaver({ store: { save }, intervalGameMinutes: 0, collect: sampleSave });
    saver.tick(0);
    saver.tick(10_000);
    expect(save).not.toHaveBeenCalled();
  });
});
