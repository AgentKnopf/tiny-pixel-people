/** WP2 v2 engine pieces: train schedule, ride queues, animals/train in the engine, residents moving in. */
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMind } from '../../src/server/cognition/mind.ts';
import { DEFAULT_CONFIG } from '../../src/server/config.ts';
import { MockChatProvider } from '../../src/server/llm/providers/mock.ts';
import type { ChatProvider } from '../../src/server/llm/types.ts';
import { JsonSaveStore } from '../../src/server/persistence/json-store.ts';
import type { SaveData } from '../../src/server/persistence/types.ts';
import {
  AFTER_RIDE_ACTIVITY,
  MAX_VILLAGERS,
  createSimEngine,
  type Engine,
} from '../../src/server/sim/engine.ts';
import { loadProfiles } from '../../src/server/sim/world.ts';
import { createStubMind, StubMind } from '../../src/server/sim/stub-mind.ts';
import type { Intent, WorldView } from '../../src/server/cognition/types.ts';
import { RIDE_MAX_WAIT_MINUTES, Rides } from '../../src/server/sim/rides.ts';
import { Train } from '../../src/server/sim/train.ts';
import type { TickMessage, ToastMsg, TrainUpdatedMsg } from '../../src/shared/protocol.ts';
import { at } from '../../src/shared/time.ts';
import type { Location, Romance, VillageEvent } from '../../src/shared/types.ts';
import { repoPath } from '../helpers/features.ts';
import { createSimTestWorld, testConfig } from '../helpers/sim.ts';

const trainCfg = { enabled: true, arrivals: ['10:00', '16:00'], dwellMinutes: 20 };

describe('Train schedule', () => {
  it('runs away → arriving → boarding → departing → away around each arrival', () => {
    const train = new Train(trainCfg, at(0, '06:00'));
    const seen: string[] = [];
    for (let t = at(0, '06:00'); t <= at(0, '17:00'); t++) {
      const s = train.step(t);
      if (s) seen.push(`${t - at(0, '00:00')}:${s.status}`);
    }
    expect(seen).toEqual([
      `${9 * 60 + 55}:arriving`,
      `${10 * 60}:boarding`,
      `${10 * 60 + 20}:departing`,
      `${10 * 60 + 25}:away`,
      `${15 * 60 + 55}:arriving`,
      `${16 * 60}:boarding`,
      `${16 * 60 + 20}:departing`,
      `${16 * 60 + 25}:away`,
    ]);
    expect(train.state()).toMatchObject({ arrivesAt: at(1, '10:00'), departsAt: at(1, '10:20') });
    expect(train.takeEvents().map((e) => e.kind)).toEqual([
      'arrived',
      'departing',
      'departed',
      'arrived',
      'departing',
      'departed',
    ]);
  });

  it('still fires every event of a cycle skipped by a clock jump', () => {
    const train = new Train(trainCfg, at(0, '06:00'));
    train.step(at(0, '12:00'));
    expect(train.takeEvents()).toEqual([
      { kind: 'arrived', arrivesAt: at(0, '10:00'), at: at(0, '10:00') },
      { kind: 'departing', arrivesAt: at(0, '10:00'), at: at(0, '10:20') },
      { kind: 'departed', arrivesAt: at(0, '10:00'), at: at(0, '10:25') },
    ]);
    expect(train.state()).toMatchObject({ status: 'away', arrivesAt: at(0, '16:00') });
  });

  it('brings the next train now, and only while it is away', () => {
    const train = new Train(trainCfg, at(0, '12:00'));
    train.triggerNow(at(0, '12:00'));
    expect(train.step(at(0, '12:00'))).toMatchObject({ status: 'arriving', arrivesAt: at(0, '12:05') });
    train.triggerNow(at(0, '12:01'));
    expect(train.state().arrivesAt).toBe(at(0, '12:05'));
    train.step(at(0, '12:30'));
    expect(train.state()).toMatchObject({ status: 'away', arrivesAt: at(0, '16:00') });
  });

  it('restores a train mid-cycle with its passengers, and reschedules a stale one', () => {
    const live = new Train(trainCfg, at(0, '09:00'));
    live.step(at(0, '10:05'));
    live.setPassengers({ arriving: ['v1'] });
    const saved = live.state(at(0, '10:05'));
    const back = new Train(trainCfg, at(0, '10:05'), saved);
    expect(back.state(at(0, '10:05'))).toEqual({ ...saved, status: 'boarding' });
    back.step(at(0, '10:06'));
    expect(back.takeEvents()).toEqual([]);
    expect(new Train(trainCfg, at(0, '13:00'), saved).state().arrivesAt).toBe(at(0, '16:00'));
  });
});

const ride = (id: string, capacity: number, durationMin: number): Location => ({
  id,
  name: id,
  kind: 'ride',
  area: { x: 0, y: 0, w: 4, h: 4 },
  entry: { x: 1, y: 4 },
  ride: { capacity, durationMin, playerCost: 2, funGain: 20 },
});

describe('Rides', () => {
  const hours = { openTime: '08:00', closeTime: '21:00' };

  it('boards up to capacity, runs a cycle, unloads, then boards the rest', () => {
    const rides = new Rides([ride('carousel', 2, 8)], hours, at(0, '10:00'));
    for (const id of ['a', 'b', 'c']) expect(rides.join(id, 'carousel')).toBe(true);
    expect(rides.step(at(0, '10:00'))).toEqual([
      {
        locationId: 'carousel',
        status: 'running',
        riders: ['a', 'b'],
        queue: ['c'],
        cycleEndsAt: at(0, '10:08'),
      },
    ]);
    expect(rides.isRiding('a')).toBe(true);
    expect(rides.step(at(0, '10:05'))).toEqual([]);
    const s = rides.step(at(0, '10:08'));
    expect(s[0]).toMatchObject({ status: 'running', riders: ['c'], queue: [], cycleEndsAt: at(0, '10:16') });
    expect(rides.takeEvents().map((e) => `${e.kind}:${e.riderId}`)).toEqual([
      'boarded:a',
      'boarded:b',
      'finished:a',
      'finished:b',
      'boarded:c',
    ]);
    expect(rides.rideOf('a')).toBeNull();
  });

  it('lets a rider give up after the waiting limit', () => {
    const rides = new Rides([ride('ferris_wheel', 1, 30)], hours, at(0, '10:00'));
    rides.join('a', 'ferris_wheel');
    rides.join('b', 'ferris_wheel');
    rides.step(at(0, '10:00'));
    rides.step(at(0, '10:00') + RIDE_MAX_WAIT_MINUTES);
    expect(rides.rideOf('b')).toBe('ferris_wheel');
    rides.step(at(0, '10:00') + RIDE_MAX_WAIT_MINUTES + 1);
    expect(rides.rideOf('b')).toBeNull();
    expect(rides.takeEvents().at(-1)).toMatchObject({ kind: 'gaveUp', riderId: 'b' });
  });

  it('is closed outside zoo hours and refuses riders', () => {
    const rides = new Rides([ride('rollercoaster', 8, 10)], hours, at(0, '20:55'));
    expect(rides.join('a', 'rollercoaster')).toBe(true);
    rides.step(at(0, '20:55'));
    rides.join('b', 'rollercoaster');
    expect(rides.step(at(0, '21:05'))[0]).toMatchObject({ status: 'closed', riders: [], queue: [] });
    expect(rides.join('c', 'rollercoaster')).toBe(false);
    expect(rides.takeEvents().map((e) => `${e.kind}:${e.riderId}`)).toEqual([
      'boarded:a',
      'finished:a',
      'gaveUp:b',
    ]);
  });
});

describe('engine v2 wiring', () => {
  it('runs 12 residents by default, with Laude and Franzi at home', () => {
    expect(DEFAULT_CONFIG.sim.villagers).toBe(12);
    const { engine } = createSimTestWorld();
    const ids = engine.profiles.map((p) => p.id);
    expect(ids).toHaveLength(12);
    expect(ids.slice(10)).toEqual(['laude', 'franzi']);
    expect(engine.profile('laude')!.homeId).toBe('house_laude');
    expect(engine.profile('franzi')!.homeId).toBe('house_franzi');
  });

  it('keeps the v1 roster with sim.villagers 10', () => {
    const { engine } = createSimTestWorld({ config: { sim: { villagers: 10 } } });
    expect(engine.profiles.map((p) => p.id)).not.toContain('laude');
  });

  it('simulates animals and the train, broadcasts them, and saves them', async () => {
    const { engine, messages } = createSimTestWorld({ startAt: '09:30' });
    const snap = engine.snapshot();
    expect(snap.animals!.some((a) => a.group === 'zoo')).toBe(true);
    expect(snap.animals!.some((a) => a.group === 'farm')).toBe(true);
    expect(snap.train).toMatchObject({ status: 'away', arrivesAt: at(0, '10:00') });
    expect(snap.rides!.map((r) => r.locationId).sort()).toEqual([
      'carousel',
      'ferris_wheel',
      'rollercoaster',
    ]);
    await engine.advance(52);
    const ticks = messages.filter((m): m is TickMessage => m.type === 'tick');
    expect(ticks.some((t) => (t.animals?.length ?? 0) > 0)).toBe(true);
    const trains = messages.filter((m): m is TrainUpdatedMsg => m.type === 'train.updated');
    expect(trains.map((m) => m.train.status)).toEqual(['arriving', 'boarding', 'departing']);

    const save = engine.toSaveData();
    expect(save.animals!.length).toBeGreaterThan(0);
    expect(save.animals!.every((a) => a.group !== 'ambient')).toBe(true);
    expect(save.farm!.seeded).toBe(true);
    const back = createSimEngine({
      config: engine.config,
      providers: { chat: new MockChatProvider(), embeddings: null },
      createMind: createStubMind,
      restore: structuredClone(save),
    });
    expect(back.snapshot().train).toEqual(engine.snapshot().train);
    expect(back.toSaveData().animals).toEqual(save.animals);
  });

  it('seeds the shy Laude/Franzi crush, stores romance updates from minds and saves them', () => {
    let world: { upsertRomance?: (r: Romance) => void; romances?: () => readonly Romance[] } = {};
    const { engine, messages } = createSimTestWorld({
      startAt: '09:00',
      createMind: (profile, deps) => {
        if (profile.id === 'mia') world = deps.world;
        return createStubMind(profile, deps);
      },
    });
    const seed = engine.snapshot().romances!.find((r) => r.pair.join() === 'franzi,laude')!;
    expect(seed).toMatchObject({ stage: 'crush', shy: true, dates: [] });
    expect([...seed.crushFrom].sort()).toEqual(['franzi', 'laude']);
    expect(engine.view('laude')!.romances).toEqual([seed]);
    expect(engine.view('mia')!.romances).toEqual([]);

    world.upsertRomance!({
      id: 'r1',
      pair: ['tom', 'mia'],
      stage: 'crush',
      since: engine.now(),
      crushFrom: ['mia'],
      dates: [],
      updatedAt: engine.now(),
    });
    expect(world.romances!().map((r) => r.pair.join())).toContain('mia,tom');
    expect(messages.some((m) => m.type === 'romance.updated' && m.romance.id === 'r1')).toBe(true);
    world.upsertRomance!({ ...world.romances!().find((r) => r.id === 'r1')!, stage: 'dating' });
    expect(engine.snapshot().romances!.filter((r) => r.id === 'r1')).toHaveLength(1);
    expect(engine.handleCommand({ type: 'inspect', villagerId: 'mia' })[0]).toMatchObject({
      romance: { id: 'r1', stage: 'dating' },
    });

    const back = createSimEngine({
      config: engine.config,
      providers: { chat: new MockChatProvider(), embeddings: null },
      createMind: createStubMind,
      restore: structuredClone(engine.toSaveData()),
    });
    expect(back.snapshot().romances).toEqual(engine.snapshot().romances);
  });

  it('ends the romances of a villager who leaves town, even when the partner left first', () => {
    const { engine, messages } = createSimTestWorld({ startAt: '09:00' });
    const base = loadProfiles(engine.map)[0]!;
    for (const id of ['visitor_a', 'visitor_b'])
      expect(engine.addVillager({ ...base, id, name: id, transient: true, visitor: true })).toBe(true);
    const romance = (id: string, pair: [string, string]): Romance => ({
      id,
      pair,
      stage: 'dating',
      since: engine.now(),
      crushFrom: [...pair],
      dates: [],
      updatedAt: engine.now(),
    });
    engine.upsertRomance(romance('r-vv', ['visitor_a', 'visitor_b']));
    engine.upsertRomance(romance('r-vm', ['mia', 'visitor_b']));
    engine.upsertRomance(romance('r-mt', ['mia', 'tom']));
    engine.removeVillager('visitor_a');
    const stage = (id: string) => engine.snapshot().romances!.find((r) => r.id === id)?.stage;
    expect(stage('r-vv')).toBe('ended');
    expect(stage('r-vm')).toBe('dating');
    engine.removeVillager('visitor_b');
    expect(stage('r-vm')).toBe('ended');
    expect(stage('r-mt')).toBe('dating');
    expect(
      messages
        .filter((m) => m.type === 'romance.updated' && m.romance.stage === 'ended')
        .map((m) => (m.type === 'romance.updated' ? m.romance.id : '')),
    ).toEqual(['r-vv', 'r-vm']);
  });

  it('has no seed romance without Laude and Franzi', () => {
    const { engine } = createSimTestWorld({ config: { sim: { villagers: 10 } } });
    expect(engine.snapshot().romances).toEqual([]);
  });

  it('moves Laude and Franzi into a v1 save and seeds the farm and zoo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpp-movein-'));
    cpSync(repoPath('test/fixtures/save-v1'), join(dir, 'save-v1'), { recursive: true });
    const restore = (await new JsonSaveStore({ dir, slot: 'save-v1' }).load())!;
    const toasts: ToastMsg[] = [];
    const engine = createSimEngine({
      config: testConfig(),
      providers: { chat: new MockChatProvider(), embeddings: null },
      createMind: createStubMind,
      restore,
    });
    engine.onMessage((m) => {
      if (m.type === 'toast') toasts.push(m);
    });
    expect(engine.profiles.map((p) => p.id)).toEqual(expect.arrayContaining(['laude', 'franzi']));
    expect(engine.villager('laude')!.locationId).toBe('house_laude');
    expect(engine.snapshot().animals!.filter((a) => a.group === 'farm').length).toBeGreaterThan(0);
    expect(engine.snapshot().romances!.map((r) => r.pair.join())).toEqual(['franzi,laude']);
    await engine.advance(1);
    expect(toasts).toContainEqual({
      type: 'toast',
      icon: '🏡',
      text: 'Laude and Franzi moved in near the bakery!',
    });
    await engine.advance(1);
    expect(toasts.filter((m) => m.icon === '🏡')).toHaveLength(1);
  });

  it('does not announce a move-in when the save already has everyone', () => {
    const { engine } = createSimTestWorld();
    const back = createSimEngine({
      config: engine.config,
      providers: { chat: new MockChatProvider(), embeddings: null },
      createMind: createStubMind,
      restore: engine.toSaveData(),
    });
    const toasts: ToastMsg[] = [];
    back.onMessage((m) => {
      if (m.type === 'toast') toasts.push(m);
    });
    return back.advance(1).then(() => expect(toasts.filter((m) => m.icon === '🏡')).toEqual([]));
  });
});

describe('wake-up hold without drainLlm', () => {
  it('never awaits a hung provider; the hold ends by rounds', async () => {
    const hung: ChatProvider = {
      kind: 'mock',
      model: 'hung',
      health: async () => ({ ok: true }) as never,
      chat: () => new Promise(() => {}),
    };
    const { engine } = createSimTestWorld({
      startAt: '05:58',
      createMind,
      providers: { chat: hung, embeddings: null },
      config: { sim: { villagers: 4, wakeUpTimeoutSec: 600 } },
    });
    const done = engine.advance(10).then(() => 'done');
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 5000));
    expect(await Promise.race([done, timeout])).toBe('done');
    expect(engine.now()).toBeCloseTo(at(0, '06:08'));
    expect(engine.wakingUp).toBe(false);
  });
});

class RideFan extends StubMind {
  override update(view: WorldView): Intent {
    const fans = ['mia', 'tom', 'lily'];
    const m = view.now % 1440;
    if (fans.includes(view.profile.id) && m >= 600 && m < 640)
      return { type: 'goto', locationId: 'rollercoaster', activity: 'riding the rollercoaster', emoji: '🎢' };
    return super.update(view);
  }
}

describe('villagers on rides', () => {
  it('queue for the rollercoaster, ride one cycle with fun gain, and do not ride again that visit', async () => {
    const { engine, messages } = createSimTestWorld({
      startAt: '09:40',
      createMind: (p, d) => new RideFan(p, d),
      config: { needs: { enabled: false } },
    });
    for (const id of ['mia', 'tom', 'lily']) engine.villager(id)!.needs.fun = 10;
    const statuses = new Map<string, Set<string>>();
    engine.onMessage((m) => {
      if (m.type !== 'tick') return;
      for (const f of m.villagers) {
        if (
          ['mia', 'tom', 'lily'].includes(f.id) &&
          /riding the rollercoaster|watching the rides/i.test(f.activity)
        )
          (statuses.get(f.id) ?? statuses.set(f.id, new Set()).get(f.id)!).add(`${f.status}:${f.activity}`);
      }
    });
    await engine.advance(70);
    const rides = messages.filter((m) => m.type === 'ride.updated');
    expect(rides.some((m) => m.type === 'ride.updated' && m.ride.status === 'running')).toBe(true);
    for (const id of ['mia', 'tom', 'lily']) {
      expect([...(statuses.get(id) ?? [])], id).toContain('acting:riding the Rollercoaster');
      expect(engine.villager(id)!.needs.fun, id).toBeGreaterThanOrEqual(10 + 35);
    }
    const boardings = rides.flatMap((m) =>
      m.type === 'ride.updated' && m.ride.status === 'running' ? m.ride.riders : [],
    );
    for (const id of ['mia', 'tom', 'lily']) expect(new Set(boardings).has(id)).toBe(true);
    expect(engine.snapshot().rides!.find((r) => r.locationId === 'rollercoaster')).toMatchObject({
      queue: [],
    });
  });
});

/** Wants the rollercoaster until it boards, then wants to be somewhere else straight away. */
class RideQuitter extends StubMind {
  override update(view: WorldView): Intent {
    const m = view.now % 1440;
    if (view.profile.id !== 'mia' || m < 600 || m >= 720) return super.update(view);
    if (/^riding the/i.test(view.self.activity.text))
      return { type: 'goto', locationId: 'square', activity: 'strolling', emoji: '🚶' };
    return { type: 'goto', locationId: 'rollercoaster', activity: 'riding the rollercoaster', emoji: '🎢' };
  }
}

describe('a boarded rider', () => {
  it('stays on for the whole cycle even when the mind wants to leave, and gets the fun', async () => {
    const { engine } = createSimTestWorld({
      startAt: '09:40',
      createMind: (p, d) => new RideQuitter(p, d),
      config: { needs: { enabled: false } },
    });
    engine.villager('mia')!.needs.fun = 10;
    let boardedAt: number | null = null;
    let leftAt: number | null = null;
    engine.onMessage((m) => {
      if (m.type !== 'tick') return;
      const f = m.villagers.find((v) => v.id === 'mia');
      if (!f) return;
      if (boardedAt === null && /^riding the/i.test(f.activity)) boardedAt = engine.now();
      else if (boardedAt !== null && leftAt === null && !/^riding the/i.test(f.activity))
        leftAt = engine.now();
    });
    await engine.advance(120);
    expect(boardedAt, 'boarded').not.toBeNull();
    expect(leftAt, 'stepped off').not.toBeNull();
    expect(leftAt! - boardedAt!).toBeGreaterThanOrEqual(5);
    expect(engine.villager('mia')!.needs.fun).toBeGreaterThanOrEqual(10 + 35);
  });
});

class DateMind extends StubMind {
  override update(view: WorldView): Intent {
    const m = view.now % 1440;
    if (['mia', 'tom'].includes(view.profile.id) && m >= 600 && m < 690)
      return { type: 'goto', locationId: 'rollercoaster', activity: 'on a date', emoji: '💕' };
    if (view.profile.id === 'lily' && m >= 540 && m < 690)
      return { type: 'goto', locationId: 'rollercoaster', activity: 'riding the rollercoaster', emoji: '🎢' };
    return super.update(view);
  }
}

function dateEvent(id: string, locationId: string): VillageEvent {
  return {
    id,
    title: 'Mia and Tom: date',
    description: 'A date at the rollercoaster',
    hostId: 'mia',
    locationId,
    start: at(0, '10:00'),
    end: at(0, '11:30'),
    invitees: ['tom'],
    accepted: ['tom'],
    declined: [],
    attendees: [],
    status: 'scheduled',
    kind: 'date',
  };
}

describe('events held at a ride', () => {
  const world = (restore?: SaveData) =>
    createSimTestWorld({
      startAt: '08:50',
      createMind: (p, d) => new DateMind(p, d),
      config: { needs: { enabled: false } },
      ...(restore ? { restore } : {}),
    }).engine;
  const event = (engine: Engine, id: string) => engine.snapshot().events.find((e) => e.id === id)!;

  it('counts riding and the after-ride chat of people who boarded during the event', async () => {
    const engine = world();
    engine.upsertEvent(dateEvent('date_ride', 'rollercoaster'));
    engine.upsertEvent({ ...dateEvent('elsewhere', 'square'), kind: 'event', title: 'Square meetup' });
    const after = new Set<string>();
    engine.onMessage((m) => {
      if (m.type !== 'tick') return;
      for (const f of m.villagers) if (f.activity === AFTER_RIDE_ACTIVITY) after.add(f.id);
    });
    await engine.advance(170);
    const date = event(engine, 'date_ride');
    expect(date.status).toBe('done');
    // Both rode one cycle and spent the rest of the date at the food stand, still counted.
    expect(after).toContain('mia');
    expect(after).toContain('tom');
    expect([...date.attendees].sort()).toEqual(['mia', 'tom']);
    // Lily rode before the date started: her after-ride chat does not make her a guest.
    expect(date.attendees).not.toContain('lily');
    // Riding does not count for an event somewhere else.
    expect(event(engine, 'elsewhere').attendees).not.toContain('mia');
    expect(event(engine, 'elsewhere').attendees).not.toContain('tom');
    engine.stop();
  });

  it('still counts both partners when the world is saved and restored mid-date', async () => {
    const first = world();
    first.upsertEvent(dateEvent('date_ride', 'rollercoaster'));
    await first.advance(85); // 10:15, the date is under way
    expect(event(first, 'date_ride').status).toBe('happening');
    const save = first.toSaveData();
    first.stop();
    const engine = world(save);
    await engine.advance(80);
    const date = event(engine, 'date_ride');
    expect(date.status).toBe('done');
    // Ride and after-ride state are not saved; the partners rejoin the ride and still qualify.
    expect(date.attendees).toEqual(expect.arrayContaining(['mia', 'tom']));
    engine.stop();
  });
});

class CrowdMind extends StubMind {
  override update(view: WorldView): Intent {
    const m = view.now % 1440;
    if (m >= 600 && m < 720)
      return { type: 'goto', locationId: 'forest_lake', activity: 'feeding the ducks', emoji: '🦆' };
    return super.update(view);
  }
}

describe('A* budget per step', () => {
  it('spreads a crowd leaving at once over at most PATH_MAX_DEFERRALS+1 steps, and all arrive', async () => {
    const base = loadProfiles(createSimTestWorld().engine.map);
    const profiles = [...base];
    for (let i = 0; profiles.length < MAX_VILLAGERS; i++) {
      const p = base[i % base.length]!;
      profiles.push({ ...p, id: `${p.id}_x${i}`, name: `${p.name} ${i + 2}`, initialRelationships: {} });
    }
    const { engine } = createSimTestWorld({
      startAt: '09:59',
      profiles,
      createMind: (p, d) => new CrowdMind(p, d),
      config: { needs: { enabled: false }, sim: { villagers: MAX_VILLAGERS } },
    });
    // Everyone stands still and nobody chats, so every villager needs a fresh search at 10:00.
    const started = new Map<string, number>();
    engine.onMessage((m) => {
      if (m.type !== 'tick') return;
      for (const f of m.villagers)
        if (!started.has(f.id) && /walking to the forest lake|feeding the ducks/i.test(f.activity))
          started.set(f.id, engine.now());
    });
    await engine.advance(4, { step: 1 });
    const ids = engine.snapshot().villagers.map((v) => v.id);
    expect(ids).toHaveLength(MAX_VILLAGERS);
    const late = ids.filter((id) => !started.has(id) || started.get(id)! > at(0, '10:02') + 1e-6);
    expect(late).toEqual([]);
    await engine.advance(110);
    const away = engine
      .snapshot()
      .villagers.filter((v) => v.locationId !== 'forest_lake' && !v.conversationId);
    expect(away.map((v) => `${v.id}@${v.locationId}:${v.activity.text}`)).toEqual([]);
    engine.stop();
  });
});

class ChurnMind extends StubMind {
  override update(view: WorldView): Intent {
    const m = Math.floor(view.now % 1440);
    if (m >= 600 && m < 720)
      return { type: 'goto', locationId: m % 2 ? 'square' : 'park', activity: 'pacing', emoji: '🚶' };
    return super.update(view);
  }
}

describe('A* budget starvation', () => {
  it('a villager behind more uncached searches than the budget every step still gets one', async () => {
    const base = loadProfiles(createSimTestWorld().engine.map);
    const profiles = [...base];
    for (let i = 0; profiles.length < MAX_VILLAGERS; i++) {
      const p = base[i % base.length]!;
      profiles.push({ ...p, id: `${p.id}_x${i}`, name: `${p.name} ${i + 2}`, initialRelationships: {} });
    }
    const victim = profiles.at(-1)!.id;
    const { engine } = createSimTestWorld({
      startAt: '09:59',
      profiles,
      // Everyone ahead of the victim changes destination every minute: a fresh search each step.
      createMind: (p, d) => (p.id === victim ? new CrowdMind(p, d) : new ChurnMind(p, d)),
      config: { needs: { enabled: false }, sim: { villagers: MAX_VILLAGERS } },
    });
    let started: number | null = null;
    engine.onMessage((m) => {
      if (m.type !== 'tick' || started !== null) return;
      const f = m.villagers.find((v) => v.id === victim);
      if (f && /walking to the forest lake|feeding the ducks/i.test(f.activity)) started = engine.now();
    });
    await engine.advance(10, { step: 1 });
    expect(started, 'victim started walking').not.toBeNull();
    expect(started!).toBeLessThanOrEqual(at(0, '10:02') + 1e-6);
    await engine.advance(100, { step: 1 });
    expect(engine.villager(victim)!.locationId).toBe('forest_lake');
    engine.stop();
  });
});
