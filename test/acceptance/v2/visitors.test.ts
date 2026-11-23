/** AC12: visitors arrive by train, stay at the hotel 1–3 days, join town life and leave by train. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_VILLAGERS } from '../../../src/server/sim/engine.ts';
import { at, dayOf, formatClock, minuteOfDay, parseClock } from '../../../src/shared/time.ts';
import type { GameMinutes, TrainState, VillagerId, VisitorInfo } from '../../../src/shared/types.ts';
import { readyV2, waitingForV2 } from '../../helpers/features.ts';
import { hotelProblems } from '../../helpers/invariants.ts';
import { V2, visitorsInTown } from '../../helpers/v2.ts';
import { createTestWorld, type TestWorld } from '../../helpers/world.ts';

const F = [...V2.visitors];
const DAYS = 4;
const START = at(0, '06:00');
const END = at(DAYS, '06:00');
/** Train departures take `departing` (5 min) after the dwell; removal may land anywhere in it. */
const DEPARTURE_SLACK = 10;

const fmt = (t: GameMinutes) => `day ${dayOf(t)} ${formatClock(t)}`;

describe.skipIf(!readyV2(...F))(
  `AC12: visitors arrive by train and leave by train${waitingForV2(...F)}`,
  () => {
    let w: TestWorld;
    const residents = new Set<VillagerId>();
    const visitors = new Map<VillagerId, VisitorInfo>();
    const checkIn = new Map<VillagerId, { at: GameMinutes; roomId: string | null }>();
    const removedAt = new Map<VillagerId, GameMinutes>();
    const trains: { at: GameMinutes; train: TrainState }[] = [];
    const hourly: { time: GameMinutes; inTown: number }[] = [];
    /** Daytime (09:00–18:00) hourly samples of where each checked-in visitor is. */
    const daytime = new Map<VillagerId, (string | null)[]>();
    const problems: string[] = [];

    const seeVisitor = (v: VisitorInfo, now: GameMinutes) => {
      visitors.set(v.villagerId, { ...v, roomId: v.roomId ?? visitors.get(v.villagerId)?.roomId ?? null });
      if (v.status === 'checkedIn' && !checkIn.has(v.villagerId))
        checkIn.set(v.villagerId, { at: now, roomId: v.roomId });
    };

    beforeAll(async () => {
      w = await createTestWorld({ villagers: 12, seed: 12, startAt: START });
      for (const v of w.state().villagers) residents.add(v.id);
      w.engine.onMessage((m) => {
        const now = w.now();
        if (m.type === 'visitor.updated') seeVisitor(m.visitor, now);
        else if (m.type === 'train.updated') trains.push({ at: now, train: m.train });
        else if (m.type === 'villagers.changed')
          for (const id of m.removed) if (!removedAt.has(id)) removedAt.set(id, now);
      });
      let lastHour = -1;
      await w.advanceTo(END, {
        onStep: ({ time, snapshot }) => {
          const s = snapshot();
          for (const v of s.visitors ?? []) seeVisitor(v, time);
          if (s.train) trains.push({ at: time, train: s.train });
          problems.push(...hotelProblems(s, w.config.hotel.rooms).map((p) => `${fmt(time)}: ${p}`));
          if (s.villagers.length > MAX_VILLAGERS)
            problems.push(`${fmt(time)}: ${s.villagers.length} villagers (max ${MAX_VILLAGERS})`);
          const hour = Math.floor(time / 60);
          if (hour !== lastHour) {
            lastHour = hour;
            hourly.push({ time, inTown: visitorsInTown(s).length });
            const m = minuteOfDay(time);
            if (m >= parseClock('09:00') && m < parseClock('18:00'))
              for (const v of s.visitors ?? []) {
                if (v.status !== 'checkedIn') continue;
                const at = s.villagers.find((x) => x.id === v.villagerId)?.locationId ?? null;
                daytime.set(v.villagerId, [...(daytime.get(v.villagerId) ?? []), at]);
              }
          }
        },
      });
    }, 600_000);

    afterAll(() => w?.dispose());

    const scheduled = () => {
      const out: GameMinutes[] = [];
      for (let d = 0; d < DAYS; d++)
        for (const t of w.config.train.arrivals) {
          const time = at(d, t);
          if (time > START && time + w.config.train.dwellMinutes < END) out.push(time);
        }
      return out.sort((a, b) => a - b);
    };
    const departures = () => [
      ...new Set(trains.filter((t) => t.train.status !== 'away').map((t) => t.train.departsAt)),
    ];
    const visitorIdsSeen = () => [...visitors.keys()].filter((id) => !residents.has(id));

    it('trains reach boarding at every scheduled time', () => {
      const boarded = trains.filter((t) => t.train.status === 'boarding').map((t) => t.train.arrivesAt);
      const missing = scheduled().filter((s) => !boarded.some((b) => Math.abs(b - s) <= 1));
      expect(scheduled().length).toBe(DAYS * w.config.train.arrivals.length);
      expect(missing.map(fmt)).toEqual([]);
    });

    it('keeps 2–4 visitors in town every game hour after the first train', () => {
      const first = scheduled()[0]!;
      const after = hourly.filter((h) => h.time > first + w.config.train.dwellMinutes + 5);
      const { min, max } = w.config.visitors;
      const bad = after
        .filter((h) => h.inTown < min || h.inTown > max)
        .map((h) => `${fmt(h.time)}: ${h.inTown}`);
      expect(after.length).toBeGreaterThan(24 * (DAYS - 1));
      expect(bad).toEqual([]);
    });

    it('brings 2–3 visitors with the first train of day 0', () => {
      const first = scheduled()[0]!;
      expect(formatClock(first)).toBe(w.config.train.arrivals[0]);
      const firstBatch = [...visitors.values()].filter((v) => Math.abs(v.arrivedAt - first) <= 30);
      expect(firstBatch.length).toBeGreaterThanOrEqual(2);
      expect(firstBatch.length).toBeLessThanOrEqual(3);
    });

    it('every visitor checks in within 2 game hours of arrival and gets a room', () => {
      const ids = visitorIdsSeen().filter((id) => visitors.get(id)!.arrivedAt <= END - 120);
      expect(ids.length).toBeGreaterThanOrEqual(w.config.visitors.min);
      const late = ids.filter((id) => {
        const c = checkIn.get(id);
        return !c || c.at - visitors.get(id)!.arrivedAt > 120;
      });
      expect(late).toEqual([]);
      const roomless = ids.filter((id) => !checkIn.get(id)?.roomId && !visitors.get(id)!.roomId);
      expect(roomless).toEqual([]);
    });

    it('every visitor who left talked with at least one resident', () => {
      const left = visitorIdsSeen().filter((id) => removedAt.has(id));
      expect(left.length).toBeGreaterThanOrEqual(1);
      const lonely = left.filter(
        (id) =>
          !w
            .conversations()
            .some(
              (c) => c.participants.includes(id) && c.participants.some((p) => p !== id && residents.has(p)),
            ),
      );
      expect(lonely).toEqual([]);
    });

    it('visitors are removed at a train departure 1–3 days after arrival', () => {
      const [minDays, maxDays] = w.config.visitors.stayDays;
      const deps = departures();
      const left = visitorIdsSeen().filter((id) => removedAt.has(id));
      expect(left.length).toBeGreaterThanOrEqual(1);
      const bad: string[] = [];
      for (const id of left) {
        const t = removedAt.get(id)!;
        const v = visitors.get(id)!;
        if (!deps.some((d) => t >= d && t <= d + DEPARTURE_SLACK))
          bad.push(`${id} removed at ${fmt(t)}, no departure`);
        const days = dayOf(t) - dayOf(v.arrivedAt);
        if (days < minDays || days > maxDays) bad.push(`${id} stayed ${days} days`);
      }
      const finalIds = new Set(w.state().villagers.map((v) => v.id));
      for (const id of left) if (finalIds.has(id)) bad.push(`${id} still in the world`);
      expect(bad).toEqual([]);
    });

    it('schedules every stay 1–3 days, leaving with a scheduled train', () => {
      const [minDays, maxDays] = w.config.visitors.stayDays;
      const { dwellMinutes } = w.config.train;
      const arrivals = w.config.train.arrivals.map(parseClock);
      const onTrain = (t: GameMinutes) =>
        arrivals.some((a) => minuteOfDay(t) >= a && minuteOfDay(t) <= a + dwellMinutes + 5);
      const bad = visitorIdsSeen()
        .map((id) => visitors.get(id)!)
        .filter((v) => {
          const days = dayOf(v.departsAt) - dayOf(v.arrivedAt);
          return days < minDays || days > maxDays || !onTrain(v.departsAt);
        })
        .map((v) => `${v.villagerId}: ${fmt(v.arrivedAt)} -> ${fmt(v.departsAt)}`);
      expect(bad).toEqual([]);
    });

    it('visitors join town life: each one with a full day in town goes somewhere besides the hotel', () => {
      const lodging = new Set(['hotel', 'station']);
      const full = [...daytime].filter(([, at]) => at.length >= 8);
      expect(full.length).toBeGreaterThanOrEqual(w.config.visitors.min);
      const hotelBound = full
        .filter(([, at]) => !at.some((l) => l !== null && !lodging.has(l)))
        .map(([id, at]) => `${id}: ${at.join(', ')}`);
      expect(hotelBound).toEqual([]);
    });

    it('never exceeds the hotel rooms or 20 villagers', () => {
      expect(problems).toEqual([]);
    });

    describe('with a model that never answers', () => {
      let hung: TestWorld;

      beforeAll(async () => {
        hung = await createTestWorld({
          villagers: 12,
          seed: 12,
          startAt: START,
          neverAnswer: true,
          config: { sim: { wakeUpTimeoutSec: 0 }, llm: { timeoutMs: 2_000 } },
        });
        await hung.advanceTo(at(0, '13:00'));
      }, 300_000);

      afterAll(() => hung?.dispose());

      it('visitors still arrive, with fallback profiles', () => {
        const vs = hung.state().visitors ?? [];
        expect(vs.length).toBeGreaterThanOrEqual(hung.config.visitors.min);
        expect(vs.map((v) => v.source)).toEqual(vs.map(() => 'fallback'));
        const ids = new Set(hung.state().villagers.map((v) => v.id));
        for (const v of vs) expect(ids.has(v.villagerId)).toBe(true);
      });
    });
  },
);
