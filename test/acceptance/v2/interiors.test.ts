/** AC14: the player can enter houses at any time; owners greet and remember; snooping lowers affinity. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatRequest } from '../../../src/server/llm/types.ts';
import { MockChatProvider, mockAnswer } from '../../../src/server/llm/providers/mock.ts';
import { findPath } from '../../../src/server/sim/pathfinding.ts';
import { dayOf } from '../../../src/shared/time.ts';
import {
  PLAYER_ID,
  type GameMinutes,
  type HouseVisit,
  type Location,
  type PlayerInside,
  type Point,
  type VillagerId,
  type VillagerProfile,
  type WorldMap,
} from '../../../src/shared/types.ts';
import { featurePath, readyV2, repoPath, waitingForV2 } from '../../helpers/features.ts';
import { dist, loc, V2, walkPlayerTo } from '../../helpers/v2.ts';
import { createTestWorld, type TestWorld } from '../../helpers/world.ts';

const F = [...V2.interiors];
const NOTE = 'Thanks for the lovely tulips, could you save me a few seeds?';
const VISIT_TEXT = /came to visit me at home/i;
const SNOOP_TEXT = /someone was in my house while i was out/i;
const WITNESS_TEXT = /go into .*house/i;

type House = Location & { door: Point; ownerIds: VillagerId[] };

function houses(w: TestWorld): House[] {
  return w.engine.map.locations.filter(
    (l): l is House => l.kind === 'house' && !!l.interiorId && !!l.door && !!l.ownerIds?.length,
  );
}

const present = (w: TestWorld, id: VillagerId) => w.state().villagers.find((v) => v.id === id);

function ownerHomeAwake(w: TestWorld, h: House): VillagerId | undefined {
  return h.ownerIds.find((id) => {
    const v = present(w, id);
    return !!v && v.locationId === h.id && v.status !== 'sleeping' && v.status !== 'talking';
  });
}

const nobodyHome = (w: TestWorld, h: House) => h.ownerIds.every((id) => present(w, id)?.locationId !== h.id);
const affinityToPlayer = (w: TestWorld, id: VillagerId) =>
  w.villager(id).relationships[PLAYER_ID]?.affinity ?? 0;
const visitsFor = (w: TestWorld, houseId: string, since: GameMinutes): HouseVisit[] =>
  (w.state().houseVisits ?? []).filter((v) => v.houseId === houseId && v.at >= since);
const greetCalls = (w: TestWorld, houseId: string) =>
  w.provider.calls.filter((c) => c.task === 'visit.greet' && c.meta?.houseId === houseId).length;

/** Walk the player to the entry (next to the door) of the nearest house that satisfies `ok`. */
async function goToHouse(w: TestWorld, ok: (h: House) => boolean, attempts = 8): Promise<House | null> {
  for (let i = 0; i < attempts; i++) {
    const p = w.state().player.pos;
    const h = houses(w)
      .filter(ok)
      .sort((a, b) => dist(a.entry, p) - dist(b.entry, p))[0];
    if (!h) {
      await w.advance(15);
      continue;
    }
    if ((await walkPlayerTo(w, h.entry)) && ok(h)) return h;
  }
  return null;
}

/**
 * A controlled cast, derived from the map: `greet` is a single-owner house whose owner stays home;
 * `snoop` is a single-owner house whose owner is out until 20:00; the witness lives next door and
 * walks past the snooped door at WITNESS_LEAVES on the way to `errand`.
 */
interface Cast {
  greet: House;
  snoop: House;
  witness: VillagerId;
  errand: string;
  away: string;
}

const WITNESS_LEAVES = '09:00';
const OWNER_BACK = '20:00';

function pickCast(): Cast {
  const m = JSON.parse(readFileSync(repoPath(featurePath('villageMap')), 'utf8')) as WorldMap;
  const roster = (JSON.parse(readFileSync(repoPath(featurePath('villagers')), 'utf8')) as VillagerProfile[])
    .slice(0, 12)
    .map((p) => p.id);
  const singles = m.locations.filter(
    (l): l is House =>
      l.kind === 'house' &&
      !!l.interiorId &&
      !!l.door &&
      l.ownerIds?.length === 1 &&
      roster.includes(l.ownerIds[0]!),
  );
  const open = m.locations.filter((l) => l.kind !== 'house' && !l.hours);
  for (const snoop of singles)
    for (const next of singles) {
      if (next === snoop || dist(next.door, snoop.door) > 6.5) continue;
      for (const errand of open) {
        const path = findPath(m, next.entry, errand.entry);
        if (!path || path.length < 12 || !path.some((p) => dist(p, snoop.door) <= 4)) continue;
        const greet = singles.find((h) => h !== snoop && h !== next);
        if (!greet) continue;
        const away = [...open].sort((a, b) => dist(b.entry, snoop.door) - dist(a.entry, snoop.door))[0]!;
        return { greet, snoop, witness: next.ownerIds[0]!, errand: errand.id, away: away.id };
      }
    }
  throw new Error('map has no single-owner house next door to another one on a through path');
}

function planDay(meta: Record<string, unknown>): number {
  if (typeof meta.day === 'number') return meta.day;
  return typeof meta.now === 'number' ? dayOf(meta.now) : 0;
}

/** Day-0 plans for the cast; everybody else gets the default mock plan. */
function castPlans(cast: Cast) {
  const block = (start: string, end: string, location: string, activity: string) => ({
    start,
    end,
    location,
    activity,
    emoji: '🙂',
  });
  return (req: ChatRequest): string => {
    const meta = req.meta ?? {};
    const p = meta.profile as VillagerProfile | undefined;
    if (!p || planDay(meta) !== 0) return mockAnswer(req);
    let blocks;
    if (p.id === cast.greet.ownerIds[0]) blocks = [block('06:00', '22:00', p.homeId, 'A quiet day at home')];
    else if (p.id === cast.snoop.ownerIds[0])
      blocks = [
        block('06:00', OWNER_BACK, cast.away, 'A long day out'),
        block(OWNER_BACK, '22:00', p.homeId, 'Back home'),
      ];
    else if (p.id === cast.witness)
      blocks = [
        block('06:00', WITNESS_LEAVES, p.homeId, 'Breakfast at home'),
        block(WITNESS_LEAVES, '20:00', cast.errand, 'Running errands'),
        block('20:00', '22:00', p.homeId, 'Back home'),
      ];
    else return mockAnswer(req);
    return JSON.stringify({ summary: `${p.name} has a planned day`, blocks });
  };
}
describe.skipIf(!readyV2(...F))(`AC14: house interiors${waitingForV2(...F)}`, () => {
  let w: TestWorld;
  const bubbles: { villagerId: VillagerId; text: string }[] = [];

  const visit = {
    house: null as House | null,
    owner: '' as VillagerId,
    enteredAt: 0 as GameMinutes,
    insideAfterEnter: null as PlayerInside | null | undefined,
    broadcastInside: null as PlayerInside | null | undefined,
    ownerStatuses: new Set<string>(),
    affinityBefore: 0,
    affinityAfterFirst: 0,
    affinityAfterSecond: 0,
    memoriesAfterFirst: 0,
    memoriesAfterSecond: 0,
    sameDay: false,
    exitPos: null as Point | null,
    exitInside: null as PlayerInside | null | undefined,
  };

  const publicEntries: Record<string, { inside: string | null; visits: number; greets: number }> = {};

  const snoop = {
    house: null as House | null,
    enteredAt: 0 as GameMinutes,
    expectedWitnesses: [] as VillagerId[],
    affinityBefore: new Map<VillagerId, number>(),
    returnedOwner: null as VillagerId | null,
    noteCreated: false,
    noteStatusBefore: '' as string,
  };

  let cast: Cast;

  beforeAll(async () => {
    cast = pickCast();
    const provider = new MockChatProvider('mock');
    provider.setScript('plan.day', castPlans(cast));
    w = await createTestWorld({ villagers: 12, seed: 14, startAt: '06:00', provider });
    w.engine.onMessage((m) => {
      if (m.type === 'tick')
        for (const f of m.villagers) if (f.bubble) bubbles.push({ villagerId: f.id, text: f.bubble });
    });
    await w.advanceTo('06:30');

    // (a) owner home and awake
    const h = await goToHouse(w, (x) => x.id === cast.greet.id && !!ownerHomeAwake(w, x));
    if (!h) throw new Error(`could not reach ${cast.greet.id} with its owner home and awake`);
    visit.house = h;
    visit.owner = ownerHomeAwake(w, h)!;
    visit.affinityBefore = affinityToPlayer(w, visit.owner);
    visit.enteredAt = w.now();
    w.command({ type: 'player.enter', locationId: h.id });
    visit.insideAfterEnter = w.state().player.inside;
    visit.broadcastInside = w.of('player.updated').at(-1)?.player.inside;
    for (let i = 0; i < 10; i++) {
      await w.advance(1, { chunk: 1 });
      visit.ownerStatuses.add(w.villager(visit.owner).status);
    }
    await w.until((x) => visitsFor(x, h.id, visit.enteredAt).some((v) => !!v.greeting), 50);
    visit.affinityAfterFirst = affinityToPlayer(w, visit.owner);
    visit.memoriesAfterFirst = w.memories(visit.owner).filter((m) => VISIT_TEXT.test(m.text)).length;

    // (c) exit puts the player on the door tile
    w.command({ type: 'player.exit' });
    visit.exitPos = { ...w.state().player.pos };
    visit.exitInside = w.state().player.inside;

    // second visit the same day
    const day = dayOf(w.now());
    w.command({ type: 'player.enter', locationId: h.id });
    await w.advance(15);
    visit.sameDay = dayOf(w.now()) === day;
    visit.affinityAfterSecond = affinityToPlayer(w, visit.owner);
    visit.memoriesAfterSecond = w.memories(visit.owner).filter((m) => VISIT_TEXT.test(m.text)).length;
    w.command({ type: 'player.exit' });

    // (b) owner away; the neighbour walks past the door on the way out
    const s = cast.snoop;
    if (!(await walkPlayerTo(w, s.entry))) throw new Error(`player could not reach ${s.id}`);
    const nearDoor = () =>
      w
        .state()
        .villagers.filter(
          (v) => !s.ownerIds.includes(v.id) && v.status !== 'sleeping' && dist(v.pos, s.door) <= 6,
        )
        .map((v) => v.id);
    const passing = () => w.villager(cast.witness).status === 'walking' && nearDoor().includes(cast.witness);
    if (!(await w.until(() => nobodyHome(w, s) && passing(), 4 * 60)))
      throw new Error(`${cast.witness} never walked past ${s.id} while it was empty`);
    snoop.house = s;
    snoop.expectedWitnesses = nearDoor();
    for (const id of s.ownerIds) if (present(w, id)) snoop.affinityBefore.set(id, affinityToPlayer(w, id));
    snoop.enteredAt = w.now();
    w.command({ type: 'player.enter', locationId: s.id });
    await w.advance(2, { chunk: 1 });
    w.command({ type: 'player.exit' });
    // (f) a v1 door note from outside
    w.command({ type: 'note.post', houseId: s.id, text: NOTE });
    const note = w.state().notes.find((n) => n.houseId === s.id && n.text === NOTE);
    snoop.noteCreated = !!note;
    snoop.noteStatusBefore = note?.status ?? 'missing';

    // (d) public interiors (the post office opens at 08:00)
    for (const id of ['hotel', 'post_office']) {
      const target = loc(w.engine.map, id);
      if (!(await walkPlayerTo(w, target.entry))) throw new Error(`player could not reach ${id}`);
      const since = w.now();
      const greets = w.provider.callCount('visit.greet');
      w.command({ type: 'player.enter', locationId: id });
      const inside = w.state().player.inside?.locationId ?? null;
      await w.advance(10);
      publicEntries[id] = {
        inside,
        visits: visitsFor(w, id, since).length,
        greets: w.provider.callCount('visit.greet') - greets,
      };
      w.command({ type: 'player.exit' });
    }

    await w.advance(10);
    const home = await w.until((x) => !nobodyHome(x, s), 14 * 60);
    if (home) {
      snoop.returnedOwner = s.ownerIds.find((id) => present(w, id)?.locationId === s.id) ?? null;
      await w.advance(30);
    }
  }, 600_000);

  afterAll(() => w?.dispose());

  describe('(a) owner home and awake', () => {
    it('sets player.inside and broadcasts it in player.updated', () => {
      expect(visit.insideAfterEnter?.locationId).toBe(visit.house!.id);
      expect(visit.broadcastInside?.locationId).toBe(visit.house!.id);
    });

    it('records a visit greeted by the owner through visit.greet', () => {
      const v = visitsFor(w, visit.house!.id, visit.enteredAt)[0];
      expect(v?.kind).toBe('visit');
      expect(v?.greetedBy).toBe(visit.owner);
      expect(v?.greeting?.length ?? 0).toBeGreaterThan(0);
      expect(v?.greetingSource).toBeDefined();
      expect(greetCalls(w, visit.house!.id)).toBeGreaterThanOrEqual(1);
      expect(w.of('visit.updated').some((m) => m.visit.houseId === visit.house!.id)).toBe(true);
    });

    it('the owner stops to greet with a speech bubble', () => {
      expect(visit.ownerStatuses.has('talking')).toBe(true);
      const greeting = visitsFor(w, visit.house!.id, visit.enteredAt)[0]?.greeting ?? '';
      const said = bubbles.filter((b) => b.villagerId === visit.owner).map((b) => b.text);
      expect(
        said.some((t) => t === greeting || (greeting.length > 0 && t.includes(greeting.slice(0, 20)))),
      ).toBe(true);
    });

    it('the owner remembers the visit (importance 5) and affinity rises by visitAffinity', () => {
      const mem = w
        .memories(visit.owner)
        .find((m) => VISIT_TEXT.test(m.text) && m.createdAt >= visit.enteredAt);
      expect(mem?.importance).toBe(5);
      expect(visit.memoriesAfterFirst).toBe(1);
      expect(visit.affinityAfterFirst - visit.affinityBefore).toBe(w.config.interiors.visitAffinity);
    });

    it('a second visit the same day adds nothing', () => {
      expect(visit.sameDay).toBe(true);
      expect(visit.memoriesAfterSecond).toBe(visit.memoriesAfterFirst);
      expect(visit.affinityAfterSecond).toBe(visit.affinityAfterFirst);
    });
  });

  describe('(b) owner away: snooping', () => {
    it('records a snoop visit without a greeting', () => {
      const v = visitsFor(w, snoop.house!.id, snoop.enteredAt)[0];
      expect(v?.kind).toBe('snoop');
      expect(v?.greeting).toBeUndefined();
      expect(greetCalls(w, snoop.house!.id)).toBe(0);
    });

    it('a witness within 6 tiles of the door gets an observation', () => {
      const v = visitsFor(w, snoop.house!.id, snoop.enteredAt)[0]!;
      expect(snoop.expectedWitnesses.length).toBeGreaterThan(0);
      expect(v.witnesses.some((id) => snoop.expectedWitnesses.includes(id))).toBe(true);
      for (const id of v.witnesses) {
        const seen = w
          .memories(id)
          .find(
            (m) => m.createdAt >= snoop.enteredAt && m.kind === 'observation' && WITNESS_TEXT.test(m.text),
          );
        expect(seen, `${id} has no witness observation`).toBeDefined();
        expect(seen!.importance).toBe(6);
      }
    });

    it('on return home the owner gets a snooping memory (importance 7) and affinity drops by snoopAffinity', () => {
      const owner = snoop.returnedOwner;
      expect(owner).not.toBeNull();
      const mem = w.memories(owner!).find((m) => SNOOP_TEXT.test(m.text) && m.createdAt >= snoop.enteredAt);
      expect(mem?.importance).toBe(7);
      expect(affinityToPlayer(w, owner!) - snoop.affinityBefore.get(owner!)!).toBe(
        w.config.interiors.snoopAffinity,
      );
      const v = visitsFor(w, snoop.house!.id, snoop.enteredAt)[0]!;
      expect(v.noticedAt ?? null).not.toBeNull();
    });
  });

  it('(c) player.exit puts the player on the door tile', () => {
    expect(visit.exitInside ?? null).toBeNull();
    expect(dist(visit.exitPos!, visit.house!.door)).toBeLessThan(0.6);
  });

  it('(d) the hotel lobby and the post office can be entered, with no reaction', () => {
    for (const id of ['hotel', 'post_office']) {
      expect(publicEntries[id], id).toEqual({ inside: id, visits: 0, greets: 0 });
    }
  });

  it('(f) v1 door notes still work from outside', () => {
    expect(snoop.noteCreated).toBe(true);
    expect(snoop.noteStatusBefore).toBe('unread');
    expect(w.of('note.updated').some((m) => m.note.text === NOTE)).toBe(true);
    const note = w.state().notes.find((n) => n.houseId === snoop.house!.id && n.text === NOTE);
    expect(note?.status).not.toBe('unread');
  });

  describe('(e) with a model that never answers', () => {
    let hung: TestWorld;
    let house: House | null = null;
    let enteredAt: GameMinutes = 0;
    let greetedAfter: number | null = null;

    beforeAll(async () => {
      hung = await createTestWorld({
        villagers: 12,
        seed: 14,
        startAt: '06:30',
        neverAnswer: true,
        config: { sim: { wakeUpTimeoutSec: 0 }, llm: { timeoutMs: 5_000 } },
      });
      house = await goToHouse(hung, (x) => !!ownerHomeAwake(hung, x));
      if (!house) throw new Error('could not reach a house with its owner home and awake');
      const id = house.id;
      enteredAt = hung.now();
      hung.command({ type: 'player.enter', locationId: id });
      const ok = await hung.until((x) => visitsFor(x, id, enteredAt).some((v) => !!v.greeting), 61);
      if (ok) greetedAfter = hung.now() - enteredAt;
    }, 300_000);

    afterAll(() => hung?.dispose());

    it('the greeting falls back within 60 game minutes', () => {
      expect(greetedAfter).not.toBeNull();
      expect(greetedAfter!).toBeLessThanOrEqual(60);
      const v = visitsFor(hung, house!.id, enteredAt)[0]!;
      expect(v.kind).toBe('visit');
      expect(v.greetingSource).toBe('fallback');
      expect(v.greeting!.length).toBeGreaterThan(0);
    });
  });
});
