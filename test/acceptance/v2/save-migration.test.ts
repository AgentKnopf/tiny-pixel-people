/** AC17: v1 saves load into v2; v2 saves round-trip every v2 field (spec v2 §15). */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JsonSaveStore } from '../../../src/server/persistence/json-store.ts';
import { SAVE_SCHEMA_VERSION, type SaveData } from '../../../src/server/persistence/types.ts';
import { at } from '../../../src/shared/time.ts';
import { FARM_SPECIES, ZOO_SPECIES, type WorldSnapshot } from '../../../src/shared/types.ts';
import { readyV2, repoPath, waitingForV2, type Feature } from '../../helpers/features.ts';
import { farmCounts, hourlyInvariants } from '../../helpers/invariants.ts';
import { loc, V2, walkPlayerTo } from '../../helpers/v2.ts';
import { createTestWorld, type TestWorld } from '../../helpers/world.ts';

const FIXTURE = repoPath('test/fixtures/save-v1');
const NEW_RESIDENTS = { laude: 'house_laude', franzi: 'house_franzi' } as const;

const MIGRATION: Feature[] = [
  ...V2.sim,
  'persistence',
  'saveV1Fixture',
  'animals',
  'zooData',
  'romance',
  'romanceData',
  'villagers',
];
const ROUND_TRIP: Feature[] = [
  ...MIGRATION,
  'player',
  'train',
  'visitors',
  'hotel',
  'visitorProfiles',
  'houseVisits',
  'farmEconomy',
  'postOffice',
];

const V2_KEYS = [
  'animals',
  'farm',
  'train',
  'visitors',
  'hotel',
  'romances',
  'houseVisits',
  'stock',
  'letters',
  'notices',
  'keep',
] as const satisfies readonly (keyof SaveData)[];

const SNAPSHOT_KEYS = [
  'train',
  'visitors',
  'hotel',
  'romances',
  'houseVisits',
  'stock',
  'letters',
  'notices',
  'keepSize',
] as const satisfies readonly (keyof WorldSnapshot)[];

function copyFixture(): JsonSaveStore {
  const dir = mkdtempSync(join(tmpdir(), 'tpp-ac17-'));
  cpSync(FIXTURE, join(dir, 'save-v1'), { recursive: true });
  return new JsonSaveStore({ dir, slot: 'save-v1' });
}

const rawWorld = () => JSON.parse(readFileSync(join(FIXTURE, 'world.json'), 'utf8')) as SaveData;
const viaJson = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const savedAnimals = (s: WorldSnapshot) => (s.animals ?? []).filter((a) => a.group !== 'ambient');

describe.skipIf(!readyV2(...MIGRATION))(`AC17: v1 saves load into v2${waitingForV2(...MIGRATION)}`, () => {
  let w: TestWorld;
  let raw: SaveData;
  let restore: SaveData;
  let start: WorldSnapshot;
  let afterStart: WorldSnapshot;
  let seededFlag: boolean | undefined;
  let inv: ReturnType<typeof hourlyInvariants>;

  beforeAll(async () => {
    raw = rawWorld();
    restore = (await copyFixture().load())!;
    w = await createTestWorld({ villagers: 12, restore, embeddings: false });
    start = w.state();
    seededFlag = w.engine.toSaveData().farm?.seeded;
    await w.advance(5);
    afterStart = w.state();
    inv = hourlyInvariants(w.engine.map, {
      farmCap: w.config.farm.capPerSpecies,
      hotelRooms: w.config.hotel.rooms,
      maxNotices: w.config.post.maxNotices,
    });
    await w.advance(24 * 60, { onStep: inv.onStep });
  }, 600_000);

  afterAll(() => w?.dispose());

  it('loads the committed v1 fixture as schemaVersion 2', () => {
    expect(raw.schemaVersion).toBe(1);
    expect(restore.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(SAVE_SCHEMA_VERSION).toBe(2);
    expect(w.now()).toBeGreaterThan(raw.time);
  });

  it('keeps villagers, memories, notes, rumors, gold and decorations unchanged', () => {
    for (const v of raw.villagers) {
      const now = start.villagers.find((x) => x.id === v.id);
      expect(now, v.id).toBeDefined();
      expect(now!.pos, v.id).toEqual(v.pos);
      for (const [other, rel] of Object.entries(v.relationships))
        expect(now!.relationships[other], `${v.id}->${other}`).toEqual(rel);
      const saved = restore.minds.find((m) => m.villagerId === v.id)!.memories.map((m) => m.id);
      const loaded = new Set(w.memories(v.id).map((m) => m.id));
      for (const id of saved) expect(loaded.has(id), `${v.id} memory ${id}`).toBe(true);
    }
    expect(start.notes).toEqual(raw.notes);
    expect(start.rumors).toEqual(raw.rumors);
    expect(start.player.gold).toBe(raw.player.gold);
    expect(start.player.ownedDecorations).toEqual(raw.player.ownedDecorations);
    expect(start.player.placedDecorations).toEqual(raw.player.placedDecorations);
  });

  it('seeds the farm and the zoo on load', () => {
    expect(seededFlag).toBe(true);
    const counts = farmCounts(start.animals ?? []);
    for (const s of FARM_SPECIES) {
      expect(counts[s], s).toBeGreaterThan(0);
      expect(counts[s], s).toBeLessThanOrEqual(w.config.farm.capPerSpecies);
    }
    for (const s of ZOO_SPECIES)
      expect(
        (start.animals ?? []).filter((a) => a.group === 'zoo' && a.species === s).length,
        s,
      ).toBeGreaterThanOrEqual(1);
  });

  it('moves Laude and Franzi in at home, with a toast', () => {
    for (const [id, home] of Object.entries(NEW_RESIDENTS)) {
      expect(raw.villagers.some((v) => v.id === id)).toBe(false);
      const v = start.villagers.find((x) => x.id === id);
      expect(v, id).toBeDefined();
      expect(w.profile(id).homeId).toBe(home);
      expect(v!.locationId, id).toBe(home);
    }
    expect(
      w.of('toast').some((t) => /laude/i.test(t.text) && /franzi/i.test(t.text) && /moved in/i.test(t.text)),
      'move-in toast',
    ).toBe(true);
    expect(afterStart.villagers.some((v) => v.id === 'laude')).toBe(true);
  });

  it('seeds the Laude and Franzi shy-crush romance', () => {
    const r = (start.romances ?? []).find((x) => [...x.pair].sort().join() === 'franzi,laude');
    expect(r, 'laude/franzi romance').toBeDefined();
    expect(r!.stage).toBe('crush');
    expect(r!.shy).toBe(true);
    expect([...r!.crushFrom].sort()).toEqual(['franzi', 'laude']);
  });

  it('runs one game day with every invariant holding', () => {
    expect(w.errors()).toEqual([]);
    expect(inv.checks).toBeGreaterThanOrEqual(24);
    expect(inv.problems).toEqual([]);
    const ids = new Set(w.state().villagers.map((v) => v.id));
    for (const id of [...raw.villagers.map((v) => v.id), ...Object.keys(NEW_RESIDENTS)])
      expect(ids.has(id), id).toBe(true);
  });
});

describe.skipIf(!readyV2(...ROUND_TRIP))(`AC17: v2 save round-trip${waitingForV2(...ROUND_TRIP)}`, () => {
  let w: TestWorld;
  let w2: TestWorld;
  let original: SaveData;
  let loaded: SaveData;
  let resaved: SaveData;
  let before: WorldSnapshot;
  let after: WorldSnapshot;
  /** A mother given a recent birth in the starting save, so `lastBirthAt` is set when we save. */
  let mother: { id: string; lastBirthAt: number } | undefined;

  beforeAll(async () => {
    w = await createTestWorld({
      villagers: 12,
      startAt: '06:00',
      seed: 31,
      patchSave: (save) => {
        const m = (save.animals ?? []).find(
          (a) => a.group === 'farm' && a.sex === 'female' && a.stage === 'adult',
        );
        if (!m) throw new Error('the save has no adult female farm animal');
        m.lastBirthAt = at(0, '06:00') - 60;
        mother = { id: m.id, lastBirthAt: m.lastBirthAt };
      },
    });
    const map = w.engine.map;
    if (!(await walkPlayerTo(w, loc(map, 'post_office').entry)))
      throw new Error('cannot reach the post office');
    w.command({ type: 'letter.send', to: 'mia', text: 'Shall we go and see the penguins on Sunday?' });
    if (!(await walkPlayerTo(w, loc(map, 'notice_board').entry)))
      throw new Error('cannot reach the notice board');
    w.command({ type: 'notice.post', text: 'Free apples by the barn, help yourself!' });
    const house = loc(map, 'house_laude');
    if (!(await walkPlayerTo(w, house.entry))) throw new Error('cannot reach house_laude');
    w.command({ type: 'player.enter', locationId: house.id });
    await w.advance(2);
    w.command({ type: 'player.exit' });
    await w.advanceTo('13:00');

    const store = new JsonSaveStore({ dir: w.config.persistence.dir, slot: 'v2-roundtrip' });
    original = w.engine.toSaveData();
    before = w.state();
    await store.save(original);
    loaded = (await store.load())!;
    w2 = await createTestWorld({ villagers: 12, restore: loaded });
    after = w2.state();
    resaved = w2.engine.toSaveData();
    await w2.advance(60);
  }, 600_000);

  afterAll(() => {
    w?.dispose();
    w2?.dispose();
  });

  it('the save has something in every v2 field', () => {
    expect(loaded.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(loaded.animals?.length).toBeGreaterThan(0);
    expect(loaded.animals!.every((a) => a.group !== 'ambient')).toBe(true);
    expect(loaded.farm?.seeded).toBe(true);
    const m = loaded.animals!.find((a) => a.id === mother?.id);
    expect(m, 'the mother').toBeDefined();
    expect(m!.lastBirthAt, 'mother lastBirthAt').toBeGreaterThanOrEqual(mother!.lastBirthAt);
    expect(loaded.train).toBeTruthy();
    expect(loaded.visitors?.length).toBeGreaterThan(0);
    expect(loaded.hotel?.rooms.some((r) => r.guestId !== null)).toBe(true);
    expect(loaded.romances?.length).toBeGreaterThan(0);
    expect(loaded.houseVisits?.length).toBeGreaterThan(0);
    expect(Object.values(loaded.stock ?? {}).some((items) => Object.values(items).some((n) => n > 0))).toBe(
      true,
    );
    expect(loaded.letters?.length).toBeGreaterThan(0);
    expect(loaded.notices?.length).toBeGreaterThan(0);
    expect(loaded.keep?.length).toBeGreaterThan(0);
  });

  it('round-trips animals, the farm, the train, visitors, the hotel, romances, visits, stock, letters, notices and the Keep', () => {
    for (const k of V2_KEYS) {
      expect(loaded[k], `loaded ${k}`).toEqual(viaJson(original[k]));
      expect(resaved[k], `resaved ${k}`).toEqual(loaded[k]);
    }
    for (const k of SNAPSHOT_KEYS) expect(after[k], `snapshot ${k}`).toEqual(before[k]);
    expect(savedAnimals(after)).toEqual(savedAnimals(before));
  });

  it('the restored world keeps running', () => {
    expect(w2.errors()).toEqual([]);
  });
});

describe.skipIf(!readyV2('persistence'))(
  `AC17: newer saves are rejected${waitingForV2('persistence')}`,
  () => {
    it(`rejects a save with schemaVersion above ${SAVE_SCHEMA_VERSION}`, async () => {
      const store = copyFixture();
      const file = join(store.slotDir, 'world.json');
      writeFileSync(file, JSON.stringify({ ...rawWorld(), schemaVersion: SAVE_SCHEMA_VERSION + 1 }));
      await expect(store.load()).rejects.toThrow(/newer/);
    });
  },
);
