/** Self-test of the headless harness and the shared acceptance checks against a fake engine. */
import { describe, expect, it } from 'vitest';
import type { ConversationMessageMsg } from '../../src/shared/protocol.ts';
import {
  PLAYER_ID,
  type AnimalState,
  type VillageEvent,
  type VillagerState,
  type WorldMap,
  type WorldSnapshot,
} from '../../src/shared/types.ts';
import type { SaveData } from '../../src/server/persistence/types.ts';
import { at } from '../../src/shared/time.ts';
import {
  checkEvents,
  checkGossip,
  checkInspector,
  checkNote,
  checkPlans,
  formatReport,
  isFollowing,
  planAdherence,
  replyOverlap,
  type AdherenceSample,
} from '../helpers/checks.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { ready } from '../helpers/features.ts';
import {
  animalCapProblems,
  animalPenProblems,
  hourlyInvariants,
  invariantProblems,
  populationProblems,
  villagerTileProblems,
  walkable,
} from '../helpers/invariants.ts';
import {
  applyAffinities,
  createTestWorld,
  mutualAffinity,
  sleep,
  stubMind,
  testConfig,
} from '../helpers/world.ts';

describe('test harness', () => {
  it('builds an isolated mock config', () => {
    const cfg = testConfig({ villagers: 4, config: { sim: { seed: 9 } } });
    expect(cfg.llm.provider).toBe('mock');
    expect(cfg.embeddings.provider).toBe('mock');
    expect(cfg.sim).toMatchObject({ villagers: 4, seed: 9 });
    expect(cfg.debug).toBe(true);
    expect(cfg.persistence.loadOnStart).toBe(false);
    expect(testConfig({ embeddings: false }).embeddings.provider).toBe('none');
  });

  it('drives a day, samples it and judges AC2/AC4/AC6 with the shared checks', async () => {
    const w = await createTestWorld({ engineFactory: createFakeEngine, startAt: '06:00' });
    const samples: AdherenceSample[] = [];
    await w.advanceTo('08:00', {
      onStep: ({ time, snapshot }) => samples.push({ time, villagers: snapshot().villagers }),
    });
    expect(w.now()).toBe(at(0, '08:00'));
    expect(w.ticks).toBe(120);
    w.command({ type: 'note.post', houseId: 'house_0', text: 'Please feed the ducks in the pond' });
    expect(w.of('note.updated')).toHaveLength(1);
    const reachedSquare = await w.until((x) => x.villager('v0').locationId === 'square', 120);
    expect(reachedSquare).toBe(true);
    expect(w.now()).toBe(at(0, '09:01'));
    await w.advanceTo('20:00', {
      onStep: ({ time, snapshot }) => samples.push({ time, villagers: snapshot().villagers }),
    });
    const inspected = w.state().villagers.map((v) => ({ id: v.id, msg: w.inspect(v.id) }));
    expect(checkInspector(inspected).pass).toBe(true);
    const adherence = planAdherence(samples, w.engine.map.locations);
    expect(adherence.every((a) => a.ratio === 1)).toBe(true);
    expect(checkPlans(w.state(), adherence).pass).toBe(true);
    const note = w.state().notes[0];
    expect(note?.readAt).toBe(at(0, '17:01'));
    expect(checkNote(note).pass).toBe(true);
    // advanceTo goes to the next occurrence of a clock time
    await w.advanceTo('07:00');
    expect(w.now()).toBe(at(1, '07:00'));
    expect(w.errors()).toEqual([]);
    expect(w.command({ type: 'save' })[0]?.type).toBe('error');
    w.dispose();
  });
});

const villager = (over: Partial<VillagerState>): VillagerState => ({
  id: 'a',
  pos: { x: 0, y: 0 },
  facing: 'down',
  path: [],
  locationId: null,
  status: 'acting',
  activity: { text: 'x', emoji: '', locationId: null, since: 0 },
  thought: '',
  needs: { hunger: 50, energy: 50, social: 50, fun: 50 },
  relationships: {},
  plan: {
    day: 0,
    summary: '',
    revision: 0,
    source: 'llm',
    createdAt: 0,
    blocks: [{ start: 600, end: 700, locationId: 'square', activity: 'x' }],
  },
  ...over,
});
const LOCS = [
  {
    id: 'square',
    name: 'Square',
    kind: 'public' as const,
    area: { x: 10, y: 10, w: 4, h: 4 },
    entry: { x: 12, y: 14 },
  },
];

describe('acceptance checks', () => {
  it('isFollowing: at location, en route, off plan, excused', () => {
    expect(isFollowing(villager({ locationId: 'square' }), 650, LOCS)).toBe(true);
    expect(isFollowing(villager({ status: 'walking', path: [{ x: 12, y: 14 }] }), 650, LOCS)).toBe(true);
    expect(isFollowing(villager({ status: 'walking', path: [{ x: 1, y: 1 }] }), 650, LOCS)).toBe(false);
    expect(isFollowing(villager({ locationId: 'cafe' }), 650, LOCS)).toBe(false);
    expect(isFollowing(villager({ pos: { x: 11, y: 11 } }), 650, LOCS)).toBe(true);
    expect(isFollowing(villager({ status: 'talking' }), 650, LOCS)).toBeNull();
    expect(isFollowing(villager({ status: 'sleeping' }), 650, LOCS)).toBeNull();
    expect(isFollowing(villager({}), 800, LOCS)).toBeNull();
  });

  it('checkPlans fails on fallback plans and low adherence', () => {
    const snap = { villagers: [villager({ plan: { ...villager({}).plan!, source: 'fallback' } })] } as never;
    expect(checkPlans(snap, []).pass).toBe(false);
    const samples = [600, 610, 620, 630].map((t, i) => ({
      time: t,
      villagers: [villager({ locationId: i ? 'cafe' : 'square' })],
    }));
    const adh = planAdherence(samples, LOCS);
    expect(adh[0]).toMatchObject({ samples: 4, following: 1, ratio: 0.25 });
    expect(checkPlans({ villagers: [villager({})] } as never, adh).detail).toContain('adherence 25%');
  });

  it('checkGossip ignores the source and messages outside the window', () => {
    const m = (speakerId: string, text: string, time: number): ConversationMessageMsg => ({
      type: 'conversation.message',
      conversationId: 'c',
      speakerId,
      listenerId: 'x',
      text,
      time,
    });
    expect(checkGossip([m('a', 'Biscuit!', 500)], 'biscuit', 'a', 480, 1200).pass).toBe(false);
    expect(checkGossip([m('b', 'Biscuit!', 1300)], 'biscuit', 'a', 480, 1200).pass).toBe(false);
    expect(
      checkGossip([m('b', 'Did you hear about biscuit?', 900)], 'Biscuit', 'a', 480, 1200),
    ).toMatchObject({ pass: true });
  });

  it('replyOverlap / checkNote need real content overlap', () => {
    expect(replyOverlap('Water the sunflowers', 'I will water your sunflowers!').shared).toEqual([
      'water',
      'sunflowers',
    ]);
    const note = {
      id: 'n',
      houseId: 'h',
      ownerId: 'a',
      authorId: 'player',
      text: 'Water the sunflowers',
      postedAt: 0,
      status: 'replied' as const,
    };
    expect(checkNote({ ...note, reply: 'Thanks!' }).pass).toBe(false);
    expect(checkNote({ ...note, status: 'read' }).pass).toBe(false);
    expect(checkNote(undefined).pass).toBe(false);
  });

  it('checkEvents counts distinct attendees of done events', () => {
    const ev = (status: VillageEvent['status'], attendees: string[]): VillageEvent => ({
      id: 'e',
      title: 'Bake-off',
      description: '',
      hostId: 'a',
      locationId: 'square',
      start: 900,
      end: 1020,
      invitees: [],
      accepted: [],
      declined: [],
      attendees,
      status,
    });
    expect(checkEvents([ev('done', ['a', 'a', 'b'])]).pass).toBe(false);
    expect(checkEvents([ev('happening', ['a', 'b', 'c'])]).pass).toBe(false);
    expect(checkEvents([ev('done', ['a', 'b', 'c'])]).pass).toBe(true);
  });

  it('checkInspector flags missing plans, too many memories and embeddings', () => {
    expect(checkInspector([{ id: 'a', msg: undefined }]).pass).toBe(false);
    const mem = (i: number) => ({
      id: `m${i}`,
      villagerId: 'a',
      createdAt: 100 - i,
      lastAccessedAt: 0,
      kind: 'observation' as const,
      text: '',
      importance: 1,
      keywords: [],
      meta: {},
    });
    const msg = {
      type: 'inspect.data' as const,
      villagerId: 'a',
      state: villager({}),
      plan: villager({}).plan,
      relationships: {},
      memories: Array.from({ length: 11 }, (_, i) => mem(i)),
    };
    expect(checkInspector([{ id: 'a', msg }]).detail).toContain('max 10');
    expect(
      checkInspector([{ id: 'a', msg: { ...msg, memories: [{ ...mem(0), embedding: [1] } as never] } }])
        .detail,
    ).toContain('embeddings');
    expect(formatReport([{ id: 'AC6', title: 't', pass: true, detail: 'd' }])).toContain('1/1 checks passed');
  });
});

describe('v2 harness helpers', () => {
  it('neverAnswer hangs the mock and stops draining the LLM queue', async () => {
    const seen: (boolean | undefined)[] = [];
    const factory: typeof createFakeEngine = (o) => {
      const e = createFakeEngine(o);
      const advance = e.advance.bind(e);
      e.advance = (m, opts) => {
        seen.push(opts?.drainLlm);
        return advance(m, opts);
      };
      return e;
    };
    const w = await createTestWorld({ engineFactory: factory, neverAnswer: true });
    await w.advance(10);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((d) => d === false)).toBe(true);
    const ctrl = new AbortController();
    const req = w.provider.chat({ task: 'visit.greet', messages: [], signal: ctrl.signal });
    await sleep(10);
    expect(w.provider.hanging).toBe(1);
    ctrl.abort();
    await expect(req).rejects.toMatchObject({ kind: 'timeout' });
    w.dispose();
    const normal = await createTestWorld({ engineFactory: factory });
    seen.length = 0;
    await normal.advance(5);
    expect(seen.every((d) => d === true)).toBe(true);
    normal.dispose();
  });

  it('applyAffinities presets relationships and rejects unknown ids', () => {
    const save = {
      villagers: [
        { id: 'a', relationships: {} },
        { id: 'b', relationships: { a: { affinity: 1, lastTalkedAt: 5 } } },
      ],
    } as never as SaveData;
    applyAffinities(save, [...mutualAffinity('a', 'b', 7), { from: 'a', to: PLAYER_ID, affinity: 99 }]);
    expect(save.villagers[0]!.relationships).toEqual({ b: { affinity: 7 }, [PLAYER_ID]: { affinity: 10 } });
    expect(save.villagers[1]!.relationships.a).toEqual({ affinity: 7, lastTalkedAt: 5 });
    expect(() => applyAffinities(save, [{ from: 'zz', to: 'a', affinity: 1 }])).toThrow(/zz/);
    expect(() => applyAffinities(save, [{ from: 'a', to: 'zz', affinity: 1 }])).toThrow(/zz/);
  });

  it.skipIf(!ready('engine'))(
    'scripted affinities reach the real engine through a save round-trip',
    async () => {
      const probe = await createTestWorld({ villagers: 3, createMind: stubMind });
      const [a, b] = probe.state().villagers.map((v) => v.id);
      probe.dispose();
      const w = await createTestWorld({
        villagers: 3,
        createMind: stubMind,
        affinities: mutualAffinity(a!, b!, 7),
        startAt: '08:00',
      });
      expect(w.villager(a!).relationships[b!]?.affinity).toBe(7);
      expect(w.villager(b!).relationships[a!]?.affinity).toBe(7);
      await w.advance(30);
      expect(w.villager(a!).relationships[b!]?.affinity).toBe(7);
      w.dispose();
    },
  );
});

describe('v2 invariants', () => {
  const W = 6;
  const H = 4;
  // column 5 is a wall
  const collision = Array.from({ length: W * H }, (_, i) => (i % W === 5 ? 1 : 0)) as (0 | 1)[];
  const map = {
    width: W,
    height: H,
    collision,
    locations: [
      {
        id: 'pasture',
        name: 'P',
        kind: 'farm',
        area: { x: 0, y: 0, w: 3, h: 3 },
        entry: { x: 0, y: 0 },
        pen: { x: 0, y: 0, w: 2, h: 2 },
      },
      { id: 'house_a', name: 'H', kind: 'house', area: { x: 4, y: 0, w: 2, h: 2 }, entry: { x: 4, y: 2 } },
      {
        id: 'post_office',
        name: 'Post',
        kind: 'post',
        area: { x: 3, y: 3, w: 1, h: 1 },
        entry: { x: 3, y: 3 },
        perch: [{ x: 3, y: 3 }],
      },
    ],
  } as never as WorldMap;
  const cow = (i: number, x = 0, y = 0, status = 'idle'): AnimalState =>
    ({
      id: `cow${i}`,
      species: 'cow',
      group: 'farm',
      homeId: 'pasture',
      pos: { x, y },
      facing: 'down',
      status,
    }) as AnimalState;
  const snap = (over: Partial<WorldSnapshot>): WorldSnapshot =>
    ({ time: at(1, '10:00'), villagers: [], animals: [], ...over }) as never as WorldSnapshot;

  it('flags more than the cap of farm animals per species', () => {
    const animals = Array.from({ length: 11 }, (_, i) => cow(i));
    expect(animalCapProblems(snap({ animals }))).toEqual(['cow: 11 alive (cap 10)']);
    expect(animalCapProblems(snap({ animals: animals.slice(0, 10) }))).toEqual([]);
    expect(animalCapProblems(snap({ animals: animals.slice(0, 5) }), 4)).toHaveLength(1);
  });

  it('flags animals outside their pen, except leaving ones; the crow stays near the post office', () => {
    const crow = (x: number, y: number) =>
      ({
        id: 'crow',
        species: 'crow',
        group: 'ambient',
        homeId: 'post_office',
        pos: { x, y },
        facing: 'down',
        status: 'flying',
      }) as AnimalState;
    expect(animalPenProblems(snap({ animals: [cow(0, 1, 1), crow(3, 3)] }), map)).toEqual([]);
    expect(animalPenProblems(snap({ animals: [cow(1, 2.6, 0)] }), map)[0]).toContain('outside pasture');
    expect(animalPenProblems(snap({ animals: [cow(2, 4, 3, 'leaving')] }), map)).toEqual([]);
    expect(animalPenProblems(snap({ animals: [crow(20, 3)] }), map)[0]).toContain('more than 6 tiles');
  });

  it('flags villagers on blocked tiles unless they are indoors, and the population cap', () => {
    const v = (id: string, x: number, y: number, locationId: string | null = null) =>
      ({ id, pos: { x, y }, locationId }) as VillagerState;
    expect(villagerTileProblems(snap({ villagers: [v('a', 1, 1), v('b', 5, 1, 'house_a')] }), map)).toEqual(
      [],
    );
    expect(villagerTileProblems(snap({ villagers: [v('c', 5, 3)] }), map)).toEqual([
      'c on blocked tile (5.0, 3.0)',
    ]);
    expect(walkable(map, { x: -1, y: 0 })).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => v(`v${i}`, 0, 0));
    expect(populationProblems(snap({ villagers: many }))).toEqual(['21 villagers (max 20)']);
  });

  it('hourlyInvariants checks once per game hour and stamps the time', async () => {
    const h = hourlyInvariants(map);
    const bad = snap({ animals: Array.from({ length: 11 }, (_, i) => cow(i)) });
    for (let t = at(1, '10:00'); t < at(1, '12:00'); t += 5)
      h.onStep({ time: t, snapshot: () => ({ ...bad, time: t }) });
    expect(h.checks).toBe(2);
    expect(h.problems).toEqual([
      'day 1 10:00: cow: 11 alive (cap 10)',
      'day 1 11:00: cow: 11 alive (cap 10)',
    ]);
    const hotel = {
      locationId: 'hotel',
      rooms: [
        { id: 'r1', guestId: 'x', since: 0 },
        { id: 'r2', guestId: 'x', since: 0 },
      ],
    };
    expect(invariantProblems(snap({ hotel }), map)).toEqual(['day 1 10:00: a guest holds two rooms']);
  });
});
