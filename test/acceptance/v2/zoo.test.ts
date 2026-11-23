/** AC9: a zoo with 12 species, rides, a burger joint and ice cream; villagers go on outings. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ZOO_SPECIES,
  type AnimalState,
  type LocationId,
  type VillagerId,
  type VillagerProfile,
  type WorldSnapshot,
} from '../../../src/shared/types.ts';
import { at, dayOf, minuteOfDay, parseClock } from '../../../src/shared/time.ts';
import type { ChatRequest } from '../../../src/server/llm/types.ts';
import { MockChatProvider, mockAnswer } from '../../../src/server/llm/providers/mock.ts';
import { readyV2, waitingForV2, type Feature } from '../../helpers/features.ts';
import { animalPenProblems } from '../../helpers/invariants.ts';
import { loc, ofKind, V2 } from '../../helpers/v2.ts';
import { createTestWorld, type TestWorld } from '../../helpers/world.ts';

const F: Feature[] = [...new Set<Feature>([...V2.animals, ...V2.rides])];

const RIDERS = ['lily', 'sam', 'nora'];
const NIGHT_RIDER = 'ben';
const RIDE = 'rollercoaster';
const OPEN_ALTERNATIVES = ['square', 'park', 'market', 'forest'];
const FOOD = ['burger_joint', 'ice_cream_truck_1', 'ice_cream_truck_2'];

const zooAnimals = (s: WorldSnapshot): AnimalState[] => (s.animals ?? []).filter((a) => a.group === 'zoo');

function planDay(meta: Record<string, unknown>): number {
  if (typeof meta.day === 'number') return meta.day;
  return typeof meta.now === 'number' ? dayOf(meta.now) : 0;
}

/** Day 0: three riders meet at the gate and ride the rollercoaster; one villager plans a ride at 21:00. */
function scriptedPlan(req: ChatRequest): string {
  const meta = req.meta ?? {};
  const p = meta.profile as VillagerProfile | undefined;
  if (!p || planDay(meta) !== 0 || ![...RIDERS, NIGHT_RIDER].includes(p.id)) return mockAnswer(req);
  const blocks = RIDERS.includes(p.id)
    ? [
        { start: '07:00', end: '09:00', location: p.homeId, activity: 'Breakfast at home', emoji: '🍳' },
        {
          start: '09:00',
          end: '10:00',
          location: 'zoo_gate',
          activity: 'Meeting friends at the zoo',
          emoji: '🦁',
        },
        { start: '10:00', end: '10:45', location: RIDE, activity: 'Riding the rollercoaster', emoji: '🎢' },
        {
          start: '10:45',
          end: '13:00',
          location: 'square',
          activity: 'Chatting about the ride',
          emoji: '💬',
        },
        { start: '13:00', end: '22:00', location: p.homeId, activity: 'Resting at home', emoji: '📖' },
      ]
    : [
        {
          start: '07:00',
          end: '21:00',
          location: 'square',
          activity: 'Hanging around the square',
          emoji: '💬',
        },
        { start: '21:00', end: '22:00', location: RIDE, activity: 'A late rollercoaster ride', emoji: '🎢' },
        { start: '22:00', end: '23:00', location: p.homeId, activity: 'Going to bed', emoji: '🛏️' },
      ];
  return JSON.stringify({ summary: `${p.name} plans a day out`, blocks });
}

interface RiderLog {
  queued: boolean;
  rode: boolean;
  ridingStatusOk: boolean;
  funBefore: number | null;
  funAfter: number | null;
  rodeAt: number | null;
  leftAt: number | null;
}

describe.skipIf(!readyV2(...F))(`AC9: zoo, rides and food${waitingForV2(...F)}`, () => {
  describe('3 default days', () => {
    let w: TestWorld;
    let first: WorldSnapshot;
    const penProblems: string[] = [];
    let penChecks = 0;
    const riders = new Set<VillagerId>();
    const eaters = new Set<string>();

    beforeAll(async () => {
      w = await createTestWorld({ villagers: 12, seed: 9, startAt: '06:00' });
      first = w.state();
      const map = w.engine.map;
      const food = new Set<LocationId>(FOOD);
      const sample = (snap: WorldSnapshot) => {
        for (const r of snap.rides ?? []) for (const id of r.riders) riders.add(id);
        for (const v of snap.villagers)
          if (v.locationId && food.has(v.locationId) && v.status !== 'walking')
            eaters.add(`${v.id}@${v.locationId}`);
      };
      await w.advanceTo(at(2, '06:00'), {
        chunk: 1,
        onStep: (info) => {
          const snap = info.snapshot();
          penChecks++;
          penProblems.push(...animalPenProblems({ ...snap, animals: zooAnimals(snap) }, map));
          sample(snap);
        },
      });
      await w.advanceTo(at(3, '06:00'), { chunk: 5, onStep: (info) => sample(info.snapshot()) });
    }, 600_000);

    afterAll(() => w?.dispose());

    it('has all 12 species with the seeded populations', () => {
      const animals = zooAnimals(first);
      for (const species of ZOO_SPECIES) {
        const here = animals.filter((a) => a.species === species);
        expect(here.length, species).toBeGreaterThanOrEqual(1);
        if (species === 'penguin' || species === 'flamingo') expect(here.length, species).toBe(3);
        else expect(here.length, species).toBeLessThanOrEqual(2);
        for (const a of here) {
          expect(a.homeId, a.id).toBe(`zoo_${species}`);
          expect(loc(w.engine.map, a.homeId).species, a.id).toBe(species);
        }
      }
      expect(
        zooAnimals(w.state())
          .map((a) => a.id)
          .sort(),
      ).toEqual(animals.map((a) => a.id).sort());
    });

    it('keeps every zoo animal inside its pen at every step for 2 days', () => {
      expect(penChecks).toBeGreaterThanOrEqual(2 * 1440);
      expect(penProblems.slice(0, 10), `${penProblems.length} problems`).toEqual([]);
    });

    it('sends at least one villager on a ride and one to eat at the zoo', () => {
      const fromMessages = w.of('ride.updated').flatMap((m) => m.ride.riders);
      const rode = [...riders, ...fromMessages].filter((id) => id !== 'player');
      expect(rode.length, 'riders').toBeGreaterThanOrEqual(1);
      expect(
        [...eaters].length,
        'villagers at the burger joint or an ice cream truck',
      ).toBeGreaterThanOrEqual(1);
      expect(w.errors()).toEqual([]);
    });
  });

  describe('scripted ride day', () => {
    let w: TestWorld;
    const log = new Map<VillagerId, RiderLog>();
    let funGain = 0;
    let durationMin = 0;
    let cycleProblems: string[] = [];
    const lateRides: string[] = [];
    let ridesAt2130: WorldSnapshot['rides'];
    let nightBlock: { locationId: string; start: number; end: number } | undefined;
    let nightPlanBlocks: { locationId: string; start: number; end: number }[] = [];

    beforeAll(async () => {
      const provider = new MockChatProvider('mock');
      provider.setScript('plan.day', scriptedPlan);
      w = await createTestWorld({
        villagers: 12,
        seed: 3,
        startAt: '06:00',
        provider,
        // Isolates the plan sanitizer: with needs on, a hungry villager's evening food override
        // legitimately replaces the 21:00 block before this check sees it. Needs-driven outings are
        // covered by the default-day suite below and the cognition needs tests.
        config: { needs: { enabled: false } },
        patchSave: (save) => {
          for (const v of save.villagers) if (RIDERS.includes(v.id)) v.needs.fun = 30;
        },
      });
      const spec = loc(w.engine.map, RIDE).ride;
      if (!spec) throw new Error('rollercoaster has no ride spec');
      funGain = spec.funGain;
      durationMin = spec.durationMin;
      for (const id of RIDERS)
        log.set(id, {
          queued: false,
          rode: false,
          ridingStatusOk: true,
          funBefore: null,
          funAfter: null,
          rodeAt: null,
          leftAt: null,
        });
      await w.advanceTo('09:00');
      const problems: string[] = [];
      await w.advanceTo('11:45', {
        chunk: 1,
        onStep: ({ time, snapshot }) => {
          const snap = snapshot();
          const ride = (snap.rides ?? []).find((r) => r.locationId === RIDE);
          if (!ride) return;
          if (ride.status === 'running') {
            if (ride.cycleEndsAt === null) problems.push(`running without cycleEndsAt at ${time}`);
            else if (ride.cycleEndsAt - time > durationMin)
              problems.push(`cycle longer than ${durationMin} min`);
            if (ride.riders.length > spec.capacity) problems.push(`${ride.riders.length} riders`);
          }
          for (const id of RIDERS) {
            const r = log.get(id)!;
            const v = snap.villagers.find((x) => x.id === id);
            if (!v) continue;
            const inQueue = ride.queue.includes(id);
            const riding = ride.riders.includes(id) && ride.status === 'running';
            if (inQueue) {
              r.queued = true;
              if (!r.rode) r.funBefore = v.needs.fun;
            }
            if (riding) {
              if (!r.rode) r.rodeAt = time;
              r.rode = true;
              if (v.status !== 'acting' || !/rid/i.test(v.activity.text)) r.ridingStatusOk = false;
            } else if (r.rode && r.funAfter === null && !inQueue) r.funAfter = v.needs.fun;
            if (r.rode && !riding && !inQueue && v.locationId !== RIDE && r.leftAt === null) r.leftAt = time;
          }
        },
      });
      cycleProblems = problems;
      await w.advanceTo('21:30', {
        chunk: 5,
        onStep: ({ time, snapshot }) => {
          // A cycle that started before closing may finish (at most 15 min, the longest ride).
          if (minuteOfDay(time) < parseClock(w.config.zoo.closeTime) + 15) return;
          for (const r of snapshot().rides ?? [])
            if (r.status !== 'closed' || r.riders.length > 0) lateRides.push(`${r.locationId} ${r.status}`);
        },
      });
      ridesAt2130 = w.state().rides;
      const plan = w.villager(NIGHT_RIDER).plan;
      nightPlanBlocks = (plan?.blocks ?? []).map((b) => ({
        locationId: b.locationId,
        start: b.start,
        end: b.end,
      }));
      nightBlock = nightPlanBlocks.find((b) => b.start <= parseClock('21:00') && parseClock('21:00') < b.end);
    }, 300_000);

    afterAll(() => w?.dispose());

    it('queues the three villagers, rides them for one cycle with fun gain, and lets them leave', () => {
      for (const id of RIDERS) {
        const r = log.get(id)!;
        expect(r.queued, `${id} queued`).toBe(true);
        expect(r.rode, `${id} rode`).toBe(true);
        expect(r.ridingStatusOk, `${id} acting "riding …" while on the ride`).toBe(true);
        expect(r.funBefore, `${id} fun before`).not.toBeNull();
        expect(r.funAfter, `${id} fun after`).not.toBeNull();
        expect(r.funAfter!, `${id} fun`).toBeGreaterThanOrEqual(Math.min(100, r.funBefore! + funGain) - 2);
        expect(r.leftAt, `${id} left the ride`).not.toBeNull();
        expect(r.leftAt! - r.rodeAt!, `${id} rode one cycle`).toBeLessThanOrEqual(durationMin + 20);
      }
      expect(cycleProblems).toEqual([]);
      expect(
        w.of('ride.updated').some((m) => m.ride.locationId === RIDE && m.ride.status === 'running'),
      ).toBe(true);
    });

    it('moves a 21:00 ride block to an open place and keeps the rides closed after hours', () => {
      const rides = new Set(ofKind(w.engine.map, 'ride').map((l) => l.id));
      const close = parseClock(w.config.zoo.closeTime);
      const late = nightPlanBlocks.filter((b) => rides.has(b.locationId) && b.end > close);
      expect(late, 'ride blocks after closing').toEqual([]);
      expect(nightBlock, 'a block at 21:00').toBeDefined();
      expect(OPEN_ALTERNATIVES).toContain(nightBlock!.locationId);
      expect(lateRides).toEqual([]);
      for (const r of ridesAt2130 ?? []) expect(r.status, r.locationId).toBe('closed');
      expect(w.villager(NIGHT_RIDER).locationId).not.toBe(RIDE);
    });
  });
});
