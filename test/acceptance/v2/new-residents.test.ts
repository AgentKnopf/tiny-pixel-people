/** AC24: Laude and Franzi live on the bakery road; Laude goes to bake-offs. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/server/config.ts';
import type { SaveData } from '../../../src/server/persistence/types.ts';
import { findPath } from '../../../src/server/sim/pathfinding.ts';
import { loadMap } from '../../../src/server/sim/world.ts';
import { at } from '../../../src/shared/time.ts';
import type { Rect, VillageEvent, VillagerProfile } from '../../../src/shared/types.ts';
import { featurePath, readyV2, repoPath, waitingForV2 } from '../../helpers/features.ts';
import { loc, V2 } from '../../helpers/v2.ts';
import { createTestWorld, type TestWorld } from '../../helpers/world.ts';

const F = [...V2.sim, 'villagers' as const, 'romanceData' as const, 'saveV1Fixture' as const];
const BAKE = /bak(e|ing)/i;
/** The bakery's road: the v1 top road extended east (spec v2 §2.1). */
const BAKERY_ROAD_Y = { from: 6, to: 8 };
/** "Next to": the rects share rows (or columns) and at most 2 tiles lie between them. */
const MAX_NEIGHBOUR_GAP = 2;

function gap(a: Rect, b: Rect): { dx: number; dy: number } {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return { dx, dy };
}

describe.skipIf(!readyV2(...F))(`AC24: Laude and Franzi${waitingForV2(...F)}`, () => {
  let w: TestWorld;
  const events = new Map<string, VillageEvent>();

  beforeAll(async () => {
    w = await createTestWorld({ villagers: DEFAULT_CONFIG.sim.villagers, seed: 24, startAt: '06:00' });
    w.engine.onMessage((m) => {
      if (m.type === 'event.updated') events.set(m.event.id, m.event);
    });
    await w.advanceTo(at(0, '22:00'));
    for (const e of w.state().events) events.set(e.id, e);
  }, 300_000);

  afterAll(() => w?.dispose());

  it('the defaults (12 villagers) include laude and franzi at indices 10 and 11, living in their houses', () => {
    expect(DEFAULT_CONFIG.sim.villagers).toBe(12);
    expect(w.engine.profiles.map((p) => p.id).slice(10, 12)).toEqual(['laude', 'franzi']);
    expect(w.profile('laude').homeId).toBe('house_laude');
    expect(w.profile('franzi').homeId).toBe('house_franzi');
    expect(loc(w.engine.map, 'house_laude').ownerIds).toContain('laude');
    expect(loc(w.engine.map, 'house_franzi').ownerIds).toContain('franzi');
    const ids = w.state().villagers.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(['laude', 'franzi']));
  });

  it('house_franzi is adjacent to post_office', () => {
    const map = loadMap();
    const { dx, dy } = gap(loc(map, 'house_franzi').area, loc(map, 'post_office').area);
    expect(Math.min(dx, dy)).toBe(0);
    expect(Math.max(dx, dy)).toBeLessThanOrEqual(MAX_NEIGHBOUR_GAP);
  });

  it('both houses face the bakery road (entries on y 6–8)', () => {
    const map = loadMap();
    for (const id of ['house_laude', 'house_franzi']) {
      const { y } = loc(map, id).entry;
      expect(y, `${id} entry y`).toBeGreaterThanOrEqual(BAKERY_ROAD_Y.from);
      expect(y, `${id} entry y`).toBeLessThanOrEqual(BAKERY_ROAD_Y.to);
    }
  });

  it('both house entries are reachable from the bakery entry by A* (no distance bound)', () => {
    const map = loadMap();
    const bakery = loc(map, 'bakery').entry;
    for (const id of ['house_laude', 'house_franzi'])
      expect(findPath(map, bakery, loc(map, id).entry), `${id} from the bakery`).not.toBeNull();
  });

  it('with villagers: 10, the v1 set is unchanged', async () => {
    const v1 = JSON.parse(readFileSync(repoPath(featurePath('saveV1Fixture')), 'utf8')) as SaveData;
    const v1Ids = v1.villagers.map((v) => v.id);
    const all = JSON.parse(readFileSync(repoPath('data/villagers.json'), 'utf8')) as VillagerProfile[];
    const ten = await createTestWorld({ villagers: 10, seed: 24, startAt: '06:00' });
    try {
      expect(ten.engine.profiles.map((p) => p.id)).toEqual(v1Ids);
      expect(
        ten
          .state()
          .villagers.map((v) => v.id)
          .sort(),
      ).toEqual([...v1Ids].sort());
      const brief = (p: VillagerProfile) => ({ id: p.id, name: p.name, homeId: p.homeId, age: p.age });
      expect(ten.engine.profiles.map(brief)).toEqual(all.slice(0, 10).map(brief));
      for (const p of ten.engine.profiles) expect(p.homeId).not.toMatch(/house_(laude|franzi)/);
    } finally {
      ten.dispose();
    }
  });

  it('on a mock day, the default bake-off has Laude among its invitees and attendees', () => {
    const bakeOffs = [...events.values()].filter(
      (e) => e.kind !== 'date' && (BAKE.test(e.title) || BAKE.test(e.description)),
    );
    expect(bakeOffs.length).toBeGreaterThanOrEqual(1);
    const withLaude = bakeOffs.filter((e) => e.hostId === 'laude' || e.invitees.includes('laude'));
    expect(withLaude.length).toBeGreaterThanOrEqual(1);
    const held = withLaude.filter((e) => e.status === 'done' || e.status === 'happening');
    expect(held.length).toBeGreaterThanOrEqual(1);
    expect(held.some((e) => e.attendees.includes('laude'))).toBe(true);
    for (const e of withLaude) if (e.hostId !== 'laude') expect(e.declined).not.toContain('laude');
  });
});
