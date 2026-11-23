/** AC15: crushes, dates at fun places and couples; dates are gossip-worthy; couples show in the inspector. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, dayOf } from '../../../src/shared/time.ts';
import type {
  GameMinutes,
  Memory,
  Romance,
  VillageEvent,
  VillagerId,
  WorldEvent,
} from '../../../src/shared/types.ts';
import { ready, readyV2, waitingFor, waitingForV2 } from '../../helpers/features.ts';
import { V2 } from '../../helpers/v2.ts';
import { createTestWorld, inArea, mutualAffinity, presetTalks, type TestWorld } from '../../helpers/world.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import { createTestVillage, V2_LOCATIONS } from '../../unit/cognition/helpers.ts';

const F = [...V2.romance];
const A = 'sam';
const B = 'ivy';
/** Under 18 (16): preset to a high mutual affinity so the age rule is what keeps them apart. */
const MINOR = 'leo';
const MINOR_FRIEND = 'lily';
/**
 * Dates have no AC deadline, so the run goes on until the pair is a couple (plus a day for the
 * gossip). This only bounds a run that never gets there; progress is logged every day.
 */
const MAX_DAYS = 21;
/** The first nightly crush draw (§7, 02:00) after the 06:00 start on day 0. */
const FIRST_DRAW = at(1, '02:00');

/** The preset pair (spec v2 AC15): every AC15 bullet is about Sam and Ivy only. */
const PAIR = [A, B].sort() as [VillagerId, VillagerId];

const isPair = (r: Romance) => r.pair[0] === PAIR[0] && r.pair[1] === PAIR[1];

/** Two finished A–B conversations before the first draw, so the §7 crush conditions hold on night 1. */
const PRESET_TALKS = [at(0, '00:30'), at(0, '01:20')];

describe.skipIf(!readyV2(...F))(`AC15: romance${waitingForV2(...F)}`, () => {
  let w: TestWorld;
  const romances: { at: GameMinutes; romance: Romance }[] = [];
  const events = new Map<string, VillageEvent>();
  const toasts: string[] = [];
  const worldEvents: WorldEvent[] = [];
  const visitorIds = new Set<VillagerId>();
  const departedAt = new Map<VillagerId, GameMinutes>();
  let coupleAt: GameMinutes | null = null;

  const isVenue = (id: string) =>
    ['zoo_gate', 'burger_joint', 'park', 'forest_grove', 'forest_lake'].includes(id) ||
    id.startsWith('ice_cream_truck_') ||
    w.location(id)?.kind === 'ride';
  const dateEvents = () =>
    [...events.values()].filter(
      (e) =>
        e.kind === 'date' &&
        PAIR.includes(e.hostId) &&
        e.invitees.length === 1 &&
        PAIR.includes(e.invitees[0]!) &&
        e.invitees[0] !== e.hostId,
    );
  const pairRomance = () => (w.state().romances ?? []).find(isPair);

  beforeAll(async () => {
    w = await createTestWorld({
      villagers: 12,
      seed: 15,
      startAt: '06:00',
      affinities: [...mutualAffinity(A, B, 7), ...mutualAffinity(MINOR, MINOR_FRIEND, 9)],
      patchSave: (s) => presetTalks(s, A, B, PRESET_TALKS, 'ac15'),
    });
    w.engine.onMessage((m) => {
      const now = w.now();
      if (m.type === 'romance.updated') {
        if (isPair(m.romance) && m.romance.stage === 'couple' && coupleAt === null) coupleAt = now;
        romances.push({ at: now, romance: m.romance });
      } else if (m.type === 'event.updated') events.set(m.event.id, m.event);
      else if (m.type === 'toast') toasts.push(m.text);
      else if (m.type === 'world.event') worldEvents.push(m.event);
      else if (m.type === 'villagers.changed') {
        for (const p of m.added) if (p.visitor) visitorIds.add(p.id);
        for (const id of m.removed) if (visitorIds.has(id) && !departedAt.has(id)) departedAt.set(id, now);
      }
    });
    for (let day = 0; day < MAX_DAYS; day++) {
      await w.advanceTo(at(day + 1, '06:00'), {
        onStep: ({ snapshot }) => {
          for (const v of snapshot().visitors ?? []) visitorIds.add(v.villagerId);
        },
      });
      const r = pairRomance();
      console.info(
        `[AC15] day ${day}: ${r ? `${r.stage}, crushFrom [${r.crushFrom.join(',')}], dates [${r.dates.map((d) => d.status).join(',')}]` : 'no romance'}`,
      );
      // One extra day after the couple forms, so the last date's gossip has time to spread.
      if (coupleAt !== null && dayOf(w.now()) > dayOf(coupleAt) + 1) break;
    }
    for (const e of w.state().events) events.set(e.id, e);
  }, 3_600_000);

  it('the fixture gives the pair two recent talks before the first draw, and no preset romance', () => {
    for (const [self, other] of [
      [A, B],
      [B, A],
    ] as const) {
      const talks = w
        .memories(self)
        .filter(
          (m) =>
            m.kind === 'conversation' &&
            m.createdAt < FIRST_DRAW &&
            m.createdAt >= FIRST_DRAW - 3 * 24 * 60 &&
            m.text.startsWith(`Talked with ${w.profile(other).name}:`),
        );
      expect(new Set(talks.map((m) => m.meta.conversationId)).size).toBe(2);
    }
    expect(romances.filter((r) => isPair(r.romance) && r.at < FIRST_DRAW)).toEqual([]);
  });

  afterAll(() => w?.dispose());

  it('a crush forms within 3 nights, not before the first draw', () => {
    const first = romances.find((r) => isPair(r.romance) && r.romance.crushFrom.length > 0);
    expect(first).toBeDefined();
    expect(first!.at).toBeGreaterThanOrEqual(FIRST_DRAW);
    expect(first!.at).toBeLessThanOrEqual(at(3, '03:00'));
    const who = first!.romance.crushFrom[0]!;
    const other = who === PAIR[0] ? PAIR[1] : PAIR[0];
    expect(
      w
        .memories(who)
        .some((m) => m.importance === 7 && /crush/i.test(m.text) && m.text.includes(w.profile(other).name)),
    ).toBe(true);
  });

  it('date.ask and date.decide produce a 90-minute date event at a §7 venue', () => {
    const asks = w.provider.calls.filter(
      (c) => c.task === 'date.ask' && PAIR.includes(String(c.meta?.villagerId)),
    );
    const decides = w.provider.calls.filter(
      (c) => c.task === 'date.decide' && PAIR.includes(String(c.meta?.villagerId)),
    );
    expect(asks.length).toBeGreaterThanOrEqual(1);
    expect(decides.length).toBeGreaterThanOrEqual(1);
    const dates = dateEvents();
    expect(dates.length).toBeGreaterThanOrEqual(1);
    for (const e of dates) {
      expect(e.invitees).toEqual([e.hostId === PAIR[0] ? PAIR[1] : PAIR[0]]);
      expect(isVenue(e.locationId), e.locationId).toBe(true);
      expect(e.end - e.start).toBe(90);
    }
  });

  it('both attend and the date is done', () => {
    const done = dateEvents().filter((e) => e.status === 'done');
    expect(done.length).toBeGreaterThanOrEqual(1);
    expect(done[0]!.attendees).toEqual(expect.arrayContaining(PAIR));
    expect(pairRomance()?.dates.some((d) => d.status === 'done')).toBe(true);
  });

  it('a third villager remembers the date and it spreads to a fourth through conversation', () => {
    const names = PAIR.map((id) => w.profile(id).name);
    const others = w.state().villagers.filter((v) => !PAIR.includes(v.id));
    const seen: Memory[] = others.flatMap((v) =>
      w
        .memories(v.id)
        .filter((m) => m.kind !== 'heard' && /date/i.test(m.text) && names.every((n) => m.text.includes(n))),
    );
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const origins = new Set(seen.map((m) => m.meta.originId ?? m.id));
    const spread = others.filter((v) =>
      w
        .memories(v.id)
        .some(
          (m) =>
            m.kind === 'heard' &&
            origins.has(m.meta.originId ?? '') &&
            !!m.meta.heardFrom &&
            !PAIR.includes(m.meta.heardFrom),
        ),
    );
    expect(spread.length).toBeGreaterThanOrEqual(1);
  });

  it('after the second date the pair becomes a couple, with a toast and a world.event', () => {
    const r = pairRomance();
    expect(r?.stage).toBe('couple');
    expect(r!.dates.filter((d) => d.status === 'done').length).toBeGreaterThanOrEqual(
      w.config.romance.datesForCouple,
    );
    const [na, nb] = [w.profile(PAIR[0]).name, w.profile(PAIR[1]).name];
    expect(toasts.some((t) => /couple/i.test(t) && t.includes(na) && t.includes(nb))).toBe(true);
    expect(worldEvents.some((e) => e.kind === 'couple')).toBe(true);
  });

  it('inspect.data shows the couple', () => {
    expect(w.inspect(PAIR[0])?.romance?.stage).toBe('couple');
    expect(w.inspect(PAIR[1])?.romance?.stage).toBe('couple');
  });

  it('nobody has more than one crush or more than one partner at a time', () => {
    const problems: string[] = [];
    const check = (list: readonly Romance[], when: string) => {
      const crushes = new Map<VillagerId, string[]>();
      const partners = new Map<VillagerId, string[]>();
      for (const r of list) {
        if (r.stage === 'ended') continue;
        for (const id of r.crushFrom) crushes.set(id, [...(crushes.get(id) ?? []), r.pair.join('+')]);
        if (r.stage === 'couple')
          for (const id of r.pair) partners.set(id, [...(partners.get(id) ?? []), r.pair.join('+')]);
      }
      for (const [id, ps] of crushes)
        if (ps.length > 1) problems.push(`${when}: ${id} has crushes ${ps.join(', ')}`);
      for (const [id, ps] of partners)
        if (ps.length > 1) problems.push(`${when}: ${id} is in couples ${ps.join(', ')}`);
    };
    const latest = new Map<string, Romance>();
    for (const { at: t, romance } of romances) {
      latest.set(romance.pair.join('+'), romance);
      check([...latest.values()], `t=${t}`);
    }
    check(w.state().romances ?? [], 'end');
    expect([...new Set(problems)].slice(0, 10)).toEqual([]);
  });

  it('a villager under 18 never gets a crush', () => {
    expect(w.profile(MINOR).age).toBeLessThan(w.config.romance.minAge);
    const all = [...romances.map((r) => r.romance), ...(w.state().romances ?? [])];
    const minors = new Set(w.engine.profiles.filter((p) => p.age < w.config.romance.minAge).map((p) => p.id));
    expect(all.filter((r) => r.crushFrom.some((id) => minors.has(id)))).toEqual([]);
    expect(all.filter((r) => r.pair.some((id) => minors.has(id)) && r.stage !== 'ended')).toEqual([]);
  });

  it("a departed visitor's romances end and no new crush involves them", () => {
    expect(departedAt.size, 'no visitor left during the run').toBeGreaterThan(0);
    /** Cognition notices a departure on its next steps; two game hours is generous. */
    const SLACK = 120;
    const problems: string[] = [];
    for (const { at: t, romance } of romances)
      for (const id of romance.pair) {
        const left = departedAt.get(id);
        if (left !== undefined && t > left + SLACK && romance.stage !== 'ended')
          problems.push(`t=${t}: ${romance.pair.join('+')} ${romance.stage} after ${id} left at ${left}`);
      }
    for (const r of w.state().romances ?? [])
      if (r.pair.some((id) => departedAt.has(id)) && r.stage !== 'ended')
        problems.push(`end: ${r.pair.join('+')} still ${r.stage}`);
    expect(problems.slice(0, 10).join('\n')).toBe('');
  });

  it('a visitor never becomes part of a couple', () => {
    expect(visitorIds.size).toBeGreaterThan(0);
    const all = [...romances.map((r) => r.romance), ...(w.state().romances ?? [])];
    expect(all.filter((r) => r.stage === 'couple' && r.pair.some((id) => visitorIds.has(id)))).toEqual([]);
  });
});

/**
 * Dates at a ride (spec v2 §7: rides are date venues). The model picks the Ferris wheel at 17:00 and
 * the invitee says yes. With both partners free the date is attended by both and counts as done;
 * as a negative control, the same date with the invitee held where they are (never reaching the
 * ride) must be missed, not done.
 */
describe.skipIf(!readyV2(...F))(`AC15: a date at a ride${waitingForV2(...F)}`, () => {
  const RIDE = 'ferris_wheel';
  const HOST = A;
  const GUEST = B;

  interface RideDateRun {
    w: TestWorld;
    event: VillageEvent | undefined;
    guestAtRide: boolean;
  }

  async function rideDate(holdGuest: boolean): Promise<RideDateRun> {
    const { Mind } = await import('../../../src/server/cognition/mind.ts');
    let date: VillageEvent | undefined;
    const provider = new MockChatProvider('mock');
    provider.setScript('date.ask', () =>
      JSON.stringify({ text: 'Shall we ride the Ferris wheel together?', locationId: RIDE, start: '17:00' }),
    );
    provider.setScript('date.decide', () => JSON.stringify({ accept: true, reply: 'I would love to!' }));
    const w = await createTestWorld({
      villagers: 12,
      seed: 15,
      startAt: '06:00',
      provider,
      affinities: mutualAffinity(HOST, GUEST, 7),
      patchSave: (s) => {
        s.romances = [
          ...(s.romances ?? []),
          {
            id: `romance-${[HOST, GUEST].sort().join('-')}`,
            pair: [HOST, GUEST].sort() as [VillagerId, VillagerId],
            stage: 'crush',
            since: 0,
            crushFrom: [HOST],
            dates: [],
            updatedAt: 0,
          },
        ];
      },
      createMind: (profile, deps) => {
        const mind = new Mind(profile, deps);
        if (holdGuest && profile.id === GUEST) {
          const update = mind.update.bind(mind);
          mind.update = (view) => {
            const intent = update(view);
            return date && view.now <= date.end + 10 ? ({ type: 'wait' } as typeof intent) : intent;
          };
        }
        return mind;
      },
    });
    w.engine.onMessage((m) => {
      if (m.type !== 'event.updated' || m.event.kind !== 'date') return;
      if (m.event.hostId === HOST && m.event.invitees.includes(GUEST) && m.event.locationId === RIDE)
        date = m.event;
    });
    const ride = w.location(RIDE)!;
    let guestAtRide = false;
    for (let d = 0; d < 3 && !(date && w.now() > date.end + 30); d++)
      await w.advanceTo(at(d + 1, '06:00'), {
        onStep: ({ time, snapshot }) => {
          if (!date || time < date.start || time > date.end) return;
          const g = snapshot().villagers.find((v) => v.id === GUEST);
          if (g && (g.locationId === RIDE || inArea(g.pos, ride))) guestAtRide = true;
        },
      });
    return { w, event: date && (w.state().events.find((e) => e.id === date!.id) ?? date), guestAtRide };
  }

  describe('both partners free', () => {
    let run: RideDateRun;
    beforeAll(async () => {
      run = await rideDate(false);
    }, 600_000);
    afterAll(() => run?.w.dispose());

    it('the date is planned at the ride', () => {
      expect(run.event, 'no date at the ride').toBeDefined();
      expect(run.w.location(run.event!.locationId)?.kind).toBe('ride');
    });

    it('both partners attend and the date counts as done', () => {
      expect(run.event!.status).toBe('done');
      expect(run.event!.attendees).toEqual(expect.arrayContaining([HOST, GUEST]));
      const rec = (run.w.state().romances ?? [])
        .find((r) => r.pair.includes(HOST) && r.pair.includes(GUEST))
        ?.dates.find((d) => d.eventId === run.event!.id);
      expect(rec?.status).toBe('done');
    });
  });

  describe('negative control: the invitee never reaches the ride', () => {
    let run: RideDateRun;
    beforeAll(async () => {
      run = await rideDate(true);
    }, 600_000);
    afterAll(() => run?.w.dispose());

    it('the date is planned at the ride and the invitee stays away', () => {
      expect(run.event, 'no date at the ride').toBeDefined();
      expect(run.guestAtRide, 'the held invitee was at the ride during the date').toBe(false);
    });

    it('the invitee is not an attendee and the date record is missed', () => {
      expect(run.event!.attendees).not.toContain(GUEST);
      const rec = (run.w.state().romances ?? [])
        .find((r) => r.pair.includes(HOST) && r.pair.includes(GUEST))
        ?.dates.find((d) => d.eventId === run.event!.id);
      expect(rec?.status).toBe('missed');
    });
  });
});

/**
 * The §7 crush draw, seeded across many villages (spec v2 AC15, §7 guarantee). Mia and Ben are
 * adults with affinity 7 both ways; Mia has talked with Ben twice (Ben never with Mia, so only Mia
 * can get a crush). Each village has its own seed; the clock jumps between the 02:00 draws.
 */
describe.skipIf(!ready('romance'))(`AC15: nightly crush rate and guarantee${waitingFor('romance')}`, () => {
  const SEEDS = 400;
  const RATE = 0.3;
  /** About 3 standard deviations of a 0.3 rate over the ~280 villages left on night 2. */
  const TOLERANCE = 0.08;
  const MIA = 'mia';
  const BEN = 'ben';

  type Village = ReturnType<typeof createTestVillage>;

  const hasCrush = (v: Village) =>
    v.minds
      .get(MIA)!
      .memory.all()
      .some((m) => m.text.startsWith('I think I have a crush on Ben'));

  function village(
    seed: number,
    night: number,
    snapshots?: Parameters<typeof createTestVillage>[0]['snapshots'],
  ) {
    const v = createTestVillage({
      start: at(night, '01:50'),
      locations: V2_LOCATIONS,
      seed,
      ...(snapshots ? { snapshots } : {}),
    });
    setAffinity(v, 7);
    return v;
  }

  function setAffinity(v: Village, affinity: number) {
    v.worlds.get(MIA)!.relationships[BEN] = { affinity };
    v.worlds.get(BEN)!.relationships[MIA] = { affinity };
  }

  function talked(v: Village, times: number) {
    for (let i = 0; i < times; i++)
      v.minds.get(MIA)!.addMemory({
        kind: 'conversation',
        at: at(0, '15:00') + i * 60,
        text: 'Talked with Ben: we chatted about the weather.',
        meta: { conversationId: `rate-${i}` },
      });
  }

  /** Runs the 02:00 draw of `night` (the clock jumps there from the previous night). */
  async function draw(v: Village, night: number): Promise<boolean> {
    if (v.time.now < at(night, '01:50')) v.time.now = at(night, '01:50');
    await v.advanceTo(at(night, '02:05'));
    return hasCrush(v);
  }

  interface Outcome {
    /** The night of Mia's crush (1–3), or null. */
    night: number | null;
  }

  async function eligibleEveryNight(seed: number): Promise<Outcome> {
    const v = village(seed, 1);
    talked(v, 2);
    for (let night = 1; night <= 3; night++) if (await draw(v, night)) return { night };
    return { night: null };
  }

  const rate = (hits: number, of: number) => (of === 0 ? NaN : hits / of);
  let outcomes: Outcome[] = [];

  beforeAll(async () => {
    outcomes = [];
    for (let seed = 1; seed <= SEEDS; seed++) outcomes.push(await eligibleEveryNight(seed));
  }, 300_000);

  it('nights 1 and 2 stay random at 0.3 (the guarantee does not raise them)', () => {
    const night1 = outcomes.filter((o) => o.night === 1).length;
    const left = SEEDS - night1;
    const night2 = outcomes.filter((o) => o.night === 2).length;
    expect(rate(night1, SEEDS), `night 1: ${night1}/${SEEDS}`).toBeGreaterThanOrEqual(RATE - TOLERANCE);
    expect(rate(night1, SEEDS), `night 1: ${night1}/${SEEDS}`).toBeLessThanOrEqual(RATE + TOLERANCE);
    expect(rate(night2, left), `night 2: ${night2}/${left}`).toBeGreaterThanOrEqual(RATE - TOLERANCE);
    expect(rate(night2, left), `night 2: ${night2}/${left}`).toBeLessThanOrEqual(RATE + TOLERANCE);
  });

  it('a villager eligible 3 nights in a row has a crush by the 3rd night, whatever the seed', () => {
    const none = outcomes.flatMap((o, i) => (o.night === null ? [i + 1] : []));
    expect(none, 'seeds without a crush after 3 eligible nights').toEqual([]);
  });

  it('never gives a crush while the conditions do not hold (one talk only)', async () => {
    const crushed: number[] = [];
    for (let seed = 1; seed <= 100; seed++) {
      const v = village(seed, 1);
      talked(v, 1);
      for (let night = 1; night <= 3; night++) if (await draw(v, night)) crushed.push(seed);
    }
    expect(crushed).toEqual([]);
  }, 120_000);

  it('an ineligible night resets the count, so the 3rd night is random again', async () => {
    let missedFirst = 0;
    let night2 = 0;
    let night3 = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const v = village(seed, 1);
      talked(v, 2);
      if (await draw(v, 1)) continue;
      missedFirst++;
      setAffinity(v, 5);
      if (await draw(v, 2)) night2++;
      setAffinity(v, 7);
      if (await draw(v, 3)) night3++;
    }
    expect(night2, 'crushes on the ineligible night').toBe(0);
    const night3Rate = rate(night3, missedFirst);
    expect(night3Rate, `night 3: ${night3}/${missedFirst}`).toBeGreaterThanOrEqual(RATE - TOLERANCE);
    expect(night3Rate, `night 3: ${night3}/${missedFirst}`).toBeLessThanOrEqual(RATE + TOLERANCE);
  }, 300_000);

  it('the count survives a restore of the mind state', async () => {
    let restoredCount = 0;
    const withoutCrush: number[] = [];
    for (let seed = 1; seed <= SEEDS && restoredCount < 50; seed++) {
      const v = village(seed, 1);
      talked(v, 2);
      if ((await draw(v, 1)) || (await draw(v, 2))) continue;
      const snapshots = Object.fromEntries([...v.minds].map(([id, m]) => [id, m.serialize()]));
      restoredCount++;
      if (!(await draw(village(seed, 3, snapshots), 3))) withoutCrush.push(seed);
    }
    expect(restoredCount).toBeGreaterThanOrEqual(20);
    expect(withoutCrush, 'seeds without a crush on the 3rd night after a restore').toEqual([]);
  }, 300_000);
});
