import { describe, expect, it } from 'vitest';
import { findPath } from '../../src/server/sim/pathfinding.ts';
import { loadMap, loadProfiles } from '../../src/server/sim/world.ts';
import { PLAYER_HOME_ID, PLAYER_ID } from '../../src/shared/types.ts';
import { parseClock } from '../../src/shared/time.ts';

const map = loadMap();
const profiles = loadProfiles(map);

describe('map data (data/map/village.json)', () => {
  it('is a 48x30 map with consistent layers', () => {
    expect(map.width).toBe(48);
    expect(map.height).toBe(30);
    expect(map.collision).toHaveLength(48 * 30);
    for (const layer of Object.values(map.layers)) expect(layer).toHaveLength(48 * 30);
  });

  it('has the reference locations and camera scenes inside the map', () => {
    const ids = map.locations.map((l) => l.id);
    for (const id of ['square', 'bakery', 'shop', 'farm', 'park', PLAYER_HOME_ID]) expect(ids).toContain(id);
    expect(
      map.locations.filter((l) => l.kind === 'house' && l.id !== PLAYER_HOME_ID).length,
    ).toBeGreaterThanOrEqual(10);
    const scenes = map.scenes.map((s) => s.id);
    for (const id of ['plaza', 'farm', 'shop_street', 'park', 'home']) expect(scenes).toContain(id);
    for (const s of map.scenes) {
      expect(s.rect.x).toBeGreaterThanOrEqual(0);
      expect(s.rect.y).toBeGreaterThanOrEqual(0);
      expect(s.rect.x + s.rect.w).toBeLessThanOrEqual(map.width);
      expect(s.rect.y + s.rect.h).toBeLessThanOrEqual(map.height);
    }
  });

  it('can reach every entry and spot from the player cottage', () => {
    const start = map.locations.find((l) => l.id === PLAYER_HOME_ID)!.entry;
    for (const loc of map.locations) {
      for (const p of [loc.entry, ...(loc.spots ?? [])]) {
        expect(findPath(map, start, p), `${loc.id} ${p.x},${p.y}`).not.toBeNull();
      }
    }
  });

  it('gives the player home decoration slots and every house a door', () => {
    const home = map.locations.find((l) => l.id === PLAYER_HOME_ID)!;
    expect(home.ownerIds).toEqual([PLAYER_ID]);
    expect(home.decorSlots?.length).toBeGreaterThanOrEqual(10);
    for (const h of map.locations.filter((l) => l.kind === 'house')) expect(h.door).toBeDefined();
  });
});

describe('villager roster (data/villagers.json)', () => {
  it('has 10–20 complete profiles', () => {
    expect(profiles.length).toBeGreaterThanOrEqual(10);
    expect(profiles.length).toBeLessThanOrEqual(20);
    for (const p of profiles) {
      expect(p.bio.split(/(?<=\.)\s/).length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.traits.length).toBeGreaterThan(0);
      expect(p.likes?.length).toBeGreaterThan(0);
      expect(parseClock(p.wakeTime)).toBeLessThan(parseClock(p.sleepTime));
      expect(p.sprite).toMatch(/^characters\/villager-\d\d\.png$/);
    }
    expect(new Set(profiles.map((p) => p.sprite)).size).toBe(profiles.length);
  });

  it('matches house ownerIds and has valid relationships', () => {
    const ids = new Set(profiles.map((p) => p.id));
    for (const p of profiles) {
      const home = map.locations.find((l) => l.id === p.homeId)!;
      expect(home.kind).toBe('house');
      expect(home.ownerIds).toContain(p.id);
      for (const [other, a] of Object.entries(p.initialRelationships ?? {})) {
        expect(ids.has(other), `${p.id} -> ${other}`).toBe(true);
        expect(Math.abs(a)).toBeLessThanOrEqual(10);
      }
    }
    for (const h of map.locations.filter((l) => l.kind === 'house' && l.id !== PLAYER_HOME_ID)) {
      for (const o of h.ownerIds ?? []) expect(ids.has(o)).toBe(true);
    }
  });

  it('starts with a baker likely to host a bake-off', () => {
    const first10 = profiles.slice(0, 10);
    expect(first10.some((p) => /bak/i.test(p.occupation) && /bake-off/i.test(p.bio))).toBe(true);
  });
});
