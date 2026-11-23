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
import { createTestWorld, mutualAffinity, type TestWorld } from '../../helpers/world.ts';

const F = [...V2.romance];
const A = 'sam';
const B = 'ivy';
/** Under 18 (16): preset to a high mutual affinity so the age rule is what keeps them apart. */
const MINOR = 'leo';
const MINOR_FRIEND = 'lily';
const MAX_DAYS = 8;
const PAIR = [A, B].sort() as [VillagerId, VillagerId];

const isPair = (r: Romance) => r.pair[0] === PAIR[0] && r.pair[1] === PAIR[1];

describe.skipIf(!readyV2(...F))(`AC15: romance${waitingForV2(...F)}`, () => {
  let w: TestWorld;
  const romances: { at: GameMinutes; romance: Romance }[] = [];
  const events = new Map<string, VillageEvent>();
  const toasts: string[] = [];
  const worldEvents: WorldEvent[] = [];
  const visitorIds = new Set<VillagerId>();
  let coupleAt: GameMinutes | null = null;

  const isVenue = (id: string) =>
    ['zoo_gate', 'burger_joint', 'park', 'forest_grove', 'forest_lake'].includes(id) ||
    id.startsWith('ice_cream_truck_') ||
    w.location(id)?.kind === 'ride';
  const dateEvents = () =>
    [...events.values()].filter(
      (e) => e.kind === 'date' && PAIR.includes(e.hostId) && e.invitees.length === 1,
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
        romances.push({ at: now, romance: m.romance });
        if (isPair(m.romance) && m.romance.stage === 'couple' && coupleAt === null) coupleAt = now;
      } else if (m.type === 'event.updated') events.set(m.event.id, m.event);
      else if (m.type === 'toast') toasts.push(m.text);
      else if (m.type === 'world.event') worldEvents.push(m.event);
      else if (m.type === 'villagers.changed') for (const p of m.added) if (p.visitor) visitorIds.add(p.id);
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
    const other = who === A ? B : A;
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
      expect(e.invitees).toEqual([e.hostId === A ? B : A]);
      expect(isVenue(e.locationId), e.locationId).toBe(true);
      expect(e.end - e.start).toBe(90);
    }
  });

  it('both attend and the date is done', () => {
    const done = dateEvents().filter((e) => e.status === 'done');
    expect(done.length).toBeGreaterThanOrEqual(1);
    expect(done[0]!.attendees).toEqual(expect.arrayContaining([A, B]));
    expect(pairRomance()?.dates.some((d) => d.status === 'done')).toBe(true);
  });

  it('a third villager remembers the date and it spreads to a fourth through conversation', () => {
    const names = [w.profile(A).name, w.profile(B).name];
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
    const [na, nb] = [w.profile(A).name, w.profile(B).name];
    expect(toasts.some((t) => /couple/i.test(t) && t.includes(na) && t.includes(nb))).toBe(true);
    expect(worldEvents.some((e) => e.kind === 'couple')).toBe(true);
  });

  it('inspect.data shows the couple', () => {
    expect(w.inspect(A)?.romance?.stage).toBe('couple');
    expect(w.inspect(B)?.romance?.stage).toBe('couple');
  });

  it('a villager under 18 never gets a crush', () => {
    expect(w.profile(MINOR).age).toBeLessThan(w.config.romance.minAge);
    const all = [...romances.map((r) => r.romance), ...(w.state().romances ?? [])];
    const minors = new Set(w.engine.profiles.filter((p) => p.age < w.config.romance.minAge).map((p) => p.id));
    expect(all.filter((r) => r.crushFrom.some((id) => minors.has(id)))).toEqual([]);
    expect(all.filter((r) => r.pair.some((id) => minors.has(id)) && r.stage !== 'ended')).toEqual([]);
  });

  it('a visitor never becomes part of a couple', () => {
    expect(visitorIds.size).toBeGreaterThan(0);
    const all = [...romances.map((r) => r.romance), ...(w.state().romances ?? [])];
    expect(all.filter((r) => r.stage === 'couple' && r.pair.some((id) => visitorIds.has(id)))).toEqual([]);
  });
});
