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
import { readyV2, waitingForV2 } from '../../helpers/features.ts';
import { V2 } from '../../helpers/v2.ts';
import { createTestWorld, inArea, mutualAffinity, type TestWorld } from '../../helpers/world.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';

const F = [...V2.romance];
const A = 'sam';
const B = 'ivy';
/** Under 18 (16): preset to a high mutual affinity so the age rule is what keeps them apart. */
const MINOR = 'leo';
const MINOR_FRIEND = 'lily';
const MAX_DAYS = 8;

/**
 * The preset A–B affinity makes a crush likely within 3 nights, but §7 aims each crush at the
 * villager's best-affinity candidate that night, and conversations move affinities. So the pair
 * under test is the first resident pair that actually forms a crush.
 */
let PAIR: [VillagerId, VillagerId] = [A, B].sort() as [VillagerId, VillagerId];

const isPair = (r: Romance) => r.pair[0] === PAIR[0] && r.pair[1] === PAIR[1];

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
    });
    w.engine.onMessage((m) => {
      const now = w.now();
      if (m.type === 'romance.updated') {
        const resident = m.romance.pair.every((id) => !visitorIds.has(id));
        if (
          resident &&
          m.romance.crushFrom.length > 0 &&
          !romances.some((r) => r.romance.crushFrom.length > 0)
        )
          PAIR = [...m.romance.pair].sort() as [VillagerId, VillagerId];
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
      // One extra day after the couple forms, so the last date's gossip has time to spread.
      if (coupleAt !== null && dayOf(w.now()) > dayOf(coupleAt) + 1) break;
    }
    for (const e of w.state().events) events.set(e.id, e);
  }, 600_000);

  afterAll(() => w?.dispose());

  it('a crush forms within 3 nights', () => {
    const first = romances.find((r) => isPair(r.romance) && r.romance.crushFrom.length > 0);
    expect(first).toBeDefined();
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
      expect([...run.event!.attendees].sort()).toEqual(expect.arrayContaining([HOST, GUEST]));
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
