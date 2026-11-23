/** §14.1 Map / Home scenes and world content: the map and roster data the engine loads. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLAYER_HOME_ID, PLAYER_ID, type VillagerProfile, type WorldMap } from '../../src/shared/types.ts';
import { parseClock } from '../../src/shared/time.ts';
import { featurePath, ready, repoPath, waitingFor } from '../helpers/features.ts';

const readJson = (rel: string): unknown => JSON.parse(readFileSync(repoPath(rel), 'utf8'));

describe.skipIf(!ready('villageMap'))(`§14.1 map and scenes${waitingFor('villageMap')}`, () => {
  const map = () => readJson(featurePath('villageMap')) as WorldMap;

  it('has consistent layer, collision and size data', () => {
    const m = map();
    const n = m.width * m.height;
    expect(m.width).toBeGreaterThanOrEqual(40);
    expect(m.height).toBeGreaterThanOrEqual(30);
    expect(m.collision).toHaveLength(n);
    for (const layer of ['ground', 'decor', 'overhead'] as const)
      expect(m.layers[layer], layer).toHaveLength(n);
  });

  it('has the five required scenes with rects inside the map', () => {
    const m = map();
    const ids = m.scenes.map((s) => s.id);
    for (const id of ['plaza', 'farm', 'shop_street', 'park', 'home']) expect(ids).toContain(id);
    for (const s of m.scenes) {
      expect(s.rect.x, s.id).toBeGreaterThanOrEqual(0);
      expect(s.rect.y, s.id).toBeGreaterThanOrEqual(0);
      expect(s.rect.w, s.id).toBeGreaterThan(0);
      expect(s.rect.h, s.id).toBeGreaterThan(0);
      expect(s.rect.x + s.rect.w, s.id).toBeLessThanOrEqual(m.width);
      expect(s.rect.y + s.rect.h, s.id).toBeLessThanOrEqual(m.height);
      expect(s.name, s.id).toBeTruthy();
    }
  });

  it('has unique locations with walkable entries inside the map', () => {
    const m = map();
    const ids = m.locations.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of m.locations) {
      const { x, y } = l.entry;
      expect(x >= 0 && x < m.width && y >= 0 && y < m.height, `${l.id} entry inside map`).toBe(true);
      expect(m.collision[y * m.width + x], `${l.id} entry walkable`).toBe(0);
      if (l.kind === 'house') expect(l.door, `${l.id} door`).toBeDefined();
    }
  });

  it("has the player's home with a door and decoration slots", () => {
    const home = map().locations.find((l) => l.id === PLAYER_HOME_ID);
    expect(home).toBeDefined();
    expect(home!.ownerIds).toContain(PLAYER_ID);
    expect(home!.door).toBeDefined();
    expect(home!.decorSlots?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('has public places for socialising and events', () => {
    const kinds = map().locations.map((l) => l.kind);
    expect(kinds.filter((k) => k === 'house').length).toBeGreaterThanOrEqual(11);
    expect(kinds).toContain('public');
    expect(kinds).toContain('shop');
    expect(kinds).toContain('nature');
  });
});

describe.skipIf(!ready('villagers', 'villageMap'))(
  `§5 villager roster${waitingFor('villagers', 'villageMap')}`,
  () => {
    const roster = (): VillagerProfile[] => {
      const raw = readJson(featurePath('villagers'));
      return (
        Array.isArray(raw) ? raw : (raw as { villagers: VillagerProfile[] }).villagers
      ) as VillagerProfile[];
    };

    it('has 10-20 complete profiles with homes on the map', () => {
      const r = roster();
      const map = readJson(featurePath('villageMap')) as WorldMap;
      expect(r.length).toBeGreaterThanOrEqual(10);
      expect(r.length).toBeLessThanOrEqual(20);
      expect(new Set(r.map((p) => p.id)).size).toBe(r.length);
      for (const p of r) {
        expect(p.name, p.id).toBeTruthy();
        expect(p.bio.length, `${p.id} bio`).toBeGreaterThan(40);
        const home = map.locations.find((l) => l.id === p.homeId);
        expect(home?.kind, `${p.id} home ${p.homeId}`).toBe('house');
        expect(parseClock(p.wakeTime)).toBeLessThan(parseClock(p.sleepTime));
        expect(p.likes?.length ?? 0, `${p.id} likes`).toBeGreaterThan(0);
        for (const other of Object.keys(p.initialRelationships ?? {}))
          expect(
            r.some((q) => q.id === other),
            `${p.id} knows ${other}`,
          ).toBe(true);
      }
    });

    it('includes a likely event host (the baker)', () => {
      expect(roster().some((p) => /bak/i.test(p.occupation) || /bake-?off/i.test(p.bio))).toBe(true);
    });
  },
);
