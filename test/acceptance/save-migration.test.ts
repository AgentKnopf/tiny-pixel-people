/**
 * AC17 (spec v2 §15, §18): saves written by v1 (schemaVersion 1) load into v2.
 * The fixture in test/fixtures/save-v1/ was written by v1 main (e769b2b) with JsonSaveStore:
 * 10 villagers at 13:00 on day 0, a door note, a player rumor and a placed decoration.
 */
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonSaveStore } from '../../src/server/persistence/json-store.ts';
import { SAVE_SCHEMA_VERSION, type SaveData } from '../../src/server/persistence/types.ts';
import { createTestWorld, type TestWorld } from '../helpers/world.ts';
import { repoPath } from '../helpers/features.ts';

const FIXTURE = repoPath('test/fixtures/save-v1');
const rawWorld = JSON.parse(readFileSync(join(FIXTURE, 'world.json'), 'utf8')) as SaveData;

function copyFixture(): JsonSaveStore {
  const dir = mkdtempSync(join(tmpdir(), 'tpp-v1save-'));
  cpSync(FIXTURE, join(dir, 'save-v1'), { recursive: true });
  return new JsonSaveStore({ dir, slot: 'save-v1' });
}

describe('AC17: v1 saves load into v2', () => {
  let w: TestWorld | undefined;
  afterEach(() => w?.dispose());

  it('the fixture really is a v1 save', () => {
    expect(rawWorld.schemaVersion).toBe(1);
    expect(rawWorld.villagers).toHaveLength(10);
  });

  it('migrates to the current schema and keeps all v1 state', async () => {
    const data = (await copyFixture().load())!;
    expect(data.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(data.farm).toEqual({ seeded: false, nextSeq: 1, lastLifecycleDay: null, lastButcherDay: null });
    expect(data.animals).toEqual([]);
    expect(data.letters).toEqual([]);
    expect(data.player.inside).toBeNull();
    expect(data.villagers).toEqual(rawWorld.villagers);
    expect(data.notes).toEqual(rawWorld.notes);
    expect(data.rumors).toEqual(rawWorld.rumors);
    expect(data.events).toEqual(rawWorld.events);
    const { inside: _inside, ...player } = data.player;
    expect(player).toEqual(rawWorld.player);
    for (const mind of data.minds) expect(mind.memories.length).toBeGreaterThan(0);
  });

  it('resumes the world from the v1 save and runs a full game day', async () => {
    const restore = (await copyFixture().load())!;
    w = await createTestWorld({ villagers: 10, restore, embeddings: false });
    const start = w.state();
    expect(w.now()).toBe(rawWorld.time);
    expect(start.player.gold).toBe(rawWorld.player.gold);
    expect(start.player.placedDecorations).toEqual(rawWorld.player.placedDecorations);
    expect(start.notes.map((n) => n.id)).toEqual(rawWorld.notes.map((n) => n.id));
    expect(start.rumors.map((r) => r.id)).toEqual(rawWorld.rumors.map((r) => r.id));
    expect(start.villagers.map((v) => v.id).sort()).toEqual(rawWorld.villagers.map((v) => v.id).sort());
    for (const v of rawWorld.villagers)
      expect(w.memories(v.id).length).toBe(restore.minds.find((m) => m.villagerId === v.id)!.memories.length);

    await w.advance(24 * 60);
    expect(w.errors()).toEqual([]);
    expect(w.state().villagers).toHaveLength(10);
  }, 120_000);

  it('writes the resumed world back as the current schema', async () => {
    const store = copyFixture();
    w = await createTestWorld({ villagers: 10, restore: (await store.load())!, embeddings: false });
    await w.advance(60);
    await store.save(w.engine.toSaveData());
    const world = JSON.parse(readFileSync(join(store.slotDir, 'world.json'), 'utf8')) as SaveData;
    expect(world.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    const again = (await store.load())!;
    expect(again.player.gold).toBe(w.state().player.gold);
    expect(again.notes).toEqual(w.state().notes);
  });

  // Needs WP2's restore of the v2 fields (spec v2 §15).
  it.todo('seeds the farm and zoo, moves Laude and Franzi in and seeds their shy crush');
  it.todo(
    'round-trips animals, farm, train, visitors, hotel, romances, visits, stock, letters, notices and the Keep',
  );
});
