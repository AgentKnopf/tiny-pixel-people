/** Ids made after a restore never repeat one already in the save (conversations, notes, memories). */
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMind, type Mind } from '../../src/server/cognition/mind.ts';
import { MockChatProvider } from '../../src/server/llm/providers/mock.ts';
import { JsonSaveStore } from '../../src/server/persistence/json-store.ts';
import type { SaveData } from '../../src/server/persistence/types.ts';
import { createSimEngine, maxEngineSeq, type Engine } from '../../src/server/sim/engine.ts';
import { StubMind, createStubMind } from '../../src/server/sim/stub-mind.ts';
import { at } from '../../src/shared/time.ts';
import { repoPath } from '../helpers/features.ts';
import { testConfig } from '../helpers/sim.ts';

const config = testConfig({ needs: { enabled: false }, sim: { villagers: 4 } });

function world(restore?: SaveData): { engine: Engine; minds: Map<string, Mind> } {
  const minds = new Map<string, Mind>();
  const engine = createSimEngine({
    config,
    providers: { chat: new MockChatProvider(), embeddings: null },
    createMind: (p, d) => {
      const m = createMind(p, d) as Mind;
      minds.set(p.id, m);
      return m;
    },
    ...(restore ? { restore } : { startAt: at(0, '09:00') }),
  });
  return { engine, minds };
}

/** Forces one chat between mia and tom and runs the clock until it has ended. */
async function chat(engine: Engine): Promise<string> {
  const id = engine.startConversation('mia', 'tom', true);
  expect(id).not.toBeNull();
  for (let i = 0; i < 60; i++) {
    await engine.advance(1);
    const c = engine.toSaveData().conversations.find((x) => x.id === id);
    if (c && c.status !== 'active') return id!;
  }
  throw new Error(`conversation ${id} never ended`);
}

async function saveAndLoad(engine: Engine, dir: string): Promise<SaveData> {
  const store = new JsonSaveStore({ dir, slot: 'slot' });
  await store.save(engine.toSaveData());
  engine.stop();
  return (await store.load())!;
}

const ids = (save: SaveData) => new Set(save.conversations.map((c) => c.id));

describe('ids after a restore', () => {
  it('reads the highest engine id anywhere in a save', () => {
    expect(maxEngineSeq({})).toBe(0);
    expect(
      maxEngineSeq({
        conversations: [{ id: 'c7' }],
        notes: [{ id: 'n12' }],
        rumors: [{ originId: 'fact_600_9' }],
        minds: [{ memories: [{ id: 'mia-m40', meta: { conversationId: 'c15' } }] }],
        villagers: [{ id: 'c' }, { id: 'cat9x' }],
      }),
    ).toBe(15);
  });

  it('keeps conversation ids unique and talk counts whole across a real save/load, twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpp-ids-'));
    let { engine, minds } = world();
    const made: string[] = [];
    made.push(await chat(engine), await chat(engine));
    expect(minds.get('mia')!.romance.talks('tom')).toBe(2);

    for (let round = 1; round <= 2; round++) {
      const save = await saveAndLoad(engine, dir);
      const before = ids(save);
      ({ engine, minds } = world(save));
      expect(minds.get('mia')!.romance.talks('tom')).toBe(made.length);
      const next = await chat(engine);
      expect(before.has(next)).toBe(false);
      made.push(next);
      expect(new Set(made).size).toBe(made.length);
      expect(minds.get('mia')!.romance.talks('tom')).toBe(made.length);
      expect(minds.get('tom')!.romance.talks('mia')).toBe(made.length);
    }
    engine.stop();
  });

  it('continues past the ids of an old v1 save that stores no counter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpp-ids-v1-'));
    cpSync(repoPath('test/fixtures/save-v1'), join(dir, 'save-v1'), { recursive: true });
    const restore = (await new JsonSaveStore({ dir, slot: 'save-v1' }).load())!;
    const saved = maxEngineSeq(restore);
    const engine = createSimEngine({
      config: testConfig(),
      providers: { chat: new MockChatProvider(), embeddings: null },
      createMind: createStubMind,
      restore,
    });
    const id = engine.startConversation('mia', 'tom', true)!;
    expect(id).toBe(`c${saved + 1}`);
    expect(ids(restore).has(id)).toBe(false);
    engine.stop();
  });

  it('numbers stub memories past the highest restored memory id', () => {
    const { engine } = world();
    const profile = engine.profiles.find((p) => p.id === 'mia')!;
    const memory = { villagerId: 'mia', createdAt: 0, lastAccessedAt: 0, kind: 'observation' as const };
    const mind = new StubMind(profile, {
      now: () => 0,
      world: {} as never,
      snapshot: {
        villagerId: 'mia',
        memories: [{ ...memory, id: 'mia-m9', text: 'a', importance: 1, keywords: [], meta: {} }],
      },
    } as never);
    mind.observe({ at: 1, kind: 'observation', text: 'b' });
    expect(mind.serialize().memories.map((m) => m.id)).toEqual(['mia-m9', 'mia-m10']);
    engine.stop();
  });
});
