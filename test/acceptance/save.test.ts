/** §14.1 Save replay / persistence: save writes world, memories and replay; a reload round-trips. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SaveData, SaveStore } from '../../src/server/persistence/types.ts';
import { ready, SIM_FEATURES, waitingFor } from '../helpers/features.ts';
import { awake, createTestWorld, importRepo, type TestWorld } from '../helpers/world.ts';

const FEATURES = [...SIM_FEATURES, 'persistence'] as const;
type StoreModule = { JsonSaveStore: new (o: { dir: string; slot: string }) => SaveStore };

const worlds: TestWorld[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.dispose();
});

describe.skipIf(!ready(...FEATURES))(`§14.1 save and reload${waitingFor(...FEATURES)}`, () => {
  it('round-trips the world through JsonSaveStore and keeps running', async () => {
    const { JsonSaveStore } = await importRepo<StoreModule>('src/server/persistence/json-store.ts');
    const w = await createTestWorld({ startAt: '06:00' });
    worlds.push(w);
    await w.advanceTo('12:00');
    const store = new JsonSaveStore({ dir: w.config.persistence.dir, slot: 'roundtrip' });
    const data = w.engine.toSaveData();
    await store.save(data);
    const loaded = (await store.load()) as SaveData;
    expect(loaded.time).toBe(w.now());

    const w2 = await createTestWorld({ restore: loaded });
    worlds.push(w2);
    const a = w.state();
    const b = w2.state();
    expect(b.time).toBe(a.time);
    expect(b.player).toEqual(a.player);
    expect(b.rumors).toEqual(a.rumors);
    expect(b.weather).toEqual(a.weather);
    expect(b.events).toEqual(a.events);
    expect(b.notes).toEqual(a.notes);
    for (const v of a.villagers) {
      const v2 = b.villagers.find((x) => x.id === v.id)!;
      expect(v2.pos, v.id).toEqual(v.pos);
      expect(v2.plan, v.id).toEqual(v.plan);
      expect(
        w2.memories(v.id).map((m) => m.id),
        v.id,
      ).toEqual(w.memories(v.id).map((m) => m.id));
    }
    await w2.advance(60);
    expect(w2.errors()).toEqual([]);
  }, 120_000);

  it('the save command writes world.json, memories and replay.jsonl', async () => {
    const w = await createTestWorld({ startAt: '06:00' });
    worlds.push(w);
    await w.advanceTo('10:00');
    const v = w.state().villagers.find(awake)!;
    w.command({ type: 'note.post', houseId: w.profile(v.id).homeId, text: 'Hello from the save test!' });
    await w.advance(30);
    w.command({ type: 'save' });
    const slot = join(w.config.persistence.dir, w.config.persistence.slot);
    const deadline = Date.now() + 5000;
    while (!existsSync(join(slot, 'world.json')) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(slot, 'world.json'))).toBe(true);
    expect(readdirSync(join(slot, 'memories')).length).toBe(w.state().villagers.length);
    await new Promise((r) => setTimeout(r, 200));
    const replay = readFileSync(join(slot, 'replay.jsonl'), 'utf8').trim().split('\n');
    expect(replay.some((l) => l.includes('note.updated'))).toBe(true);
  }, 120_000);
});
