import { describe, expect, it } from 'vitest';
import type { LlmQueue } from '../../../src/server/llm/types.ts';
import { mockAnswer } from '../../../src/server/llm/providers/mock.ts';
import { Hotel } from '../../../src/server/player/hotel.ts';
import { at, dayOf, minuteOfDay, parseClock } from '../../../src/shared/time.ts';
import type { PlanBlock } from '../../../src/shared/types.ts';
import { setup, type FakeHost } from './fake-host.ts';
import type { PlayerWorld } from '../../../src/server/player/index.ts';
import { addV2Locations } from './v2-fixtures.ts';

const DWELL = 20;

function mockQueue(mode: 'answer' | 'never' | 'garbage' = 'answer'): LlmQueue & { calls: number } {
  const q = {
    calls: 0,
    enqueue(req: Parameters<LlmQueue['enqueue']>[0]) {
      q.calls++;
      if (mode === 'never') return new Promise<never>(() => {});
      const text = mode === 'garbage' ? 'no json here' : mockAnswer(req);
      return Promise.resolve({ text, model: 'mock', latencyMs: 0 });
    },
    embed: async () => null,
    drain: async () => {},
    stats: () => ({
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      avgLatencyMs: 0,
      totalLatencyMs: 0,
      totalTokens: 0,
      lastReplyMs: null,
      tokensPerSecond: null,
    }),
  };
  return q;
}

function world(llm?: LlmQueue, worldCfg: { llmVisitors?: boolean } = {}) {
  const { host, pw } = setup({ world: worldCfg });
  addV2Locations(host);
  if (llm) host.llm = llm;
  host.time = at(0, '06:00');
  return { host, pw };
}

const station = { x: 5, y: 12 };

interface RunStats {
  arrivals: Map<string, number>;
  departures: Map<string, number>;
  maxOccupancy: number;
  maxVillagers: number;
  hourlyCounts: number[];
}

/**
 * Drive trains like the engine would: spawn arrivals on the platform at each arrival time and
 * board at arrival + dwell. Visitors walk to the hotel an hour after arriving and to the platform
 * once they are leaving; `stuck` visitors never reach the platform.
 */
async function run(
  host: FakeHost,
  pw: PlayerWorld,
  days: number,
  opts: { stuck?: Set<string> } = {},
): Promise<RunStats> {
  const stats: RunStats = {
    arrivals: new Map(),
    departures: new Map(),
    maxOccupancy: 0,
    maxVillagers: 0,
    hourlyCounts: [],
  };
  const arrivals = ['10:00', '16:00'].map(parseClock);
  const end = host.time + days * 1440;
  let firstTrain = false;
  while (host.time < end) {
    host.time += 1;
    const m = minuteOfDay(host.time);
    if (arrivals.includes(m)) {
      firstTrain = true;
      for (const p of pw.onTrainArrived(host.time)) {
        host.spawnVillager(p, { ...station });
        host.states.find((s) => s.id === p.id)!.locationId = 'station';
        stats.arrivals.set(p.id, host.time);
      }
    }
    if (arrivals.some((a) => a + DWELL === m)) {
      const onPlatform = host.states
        .filter((s) => s.locationId === 'station' && !opts.stuck?.has(s.id))
        .map((s) => s.id);
      for (const id of pw.onTrainDeparting(host.time, onPlatform)) {
        host.removeVillager(id);
        stats.departures.set(id, host.time);
      }
    }
    for (const info of pw.visitors.visitors()) {
      const s = host.states.find((v) => v.id === info.villagerId);
      if (!s) continue;
      if (info.status === 'arriving' && host.time - info.arrivedAt >= 60) s.locationId = 'hotel';
      if (info.status === 'leaving') s.locationId = 'station';
    }
    pw.update(1);
    await Promise.resolve();
    stats.maxOccupancy = Math.max(
      stats.maxOccupancy,
      pw.hotel.state().rooms.filter((r) => r.guestId !== null).length,
    );
    stats.maxVillagers = Math.max(stats.maxVillagers, host.states.length);
    if (firstTrain && m % 60 === 0) stats.hourlyCounts.push(pw.visitors.inTown());
  }
  return stats;
}

/** Give every visitor a fresh all-day plan each morning, like a mind would. */
function planEveryMorning(host: FakeHost, pw: PlayerWorld): void {
  for (const info of pw.visitors.visitors()) {
    const s = host.states.find((v) => v.id === info.villagerId);
    const day = dayOf(host.time);
    if (!s || s.plan?.day === day) continue;
    const blocks: PlanBlock[] = [
      { start: 420, end: 720, locationId: 'square', activity: 'Exploring', emoji: '🧭' },
      { start: 720, end: 1320, locationId: 'park', activity: 'Relaxing', emoji: '🌳' },
    ];
    host.setPlan(s.id, { day, summary: '', blocks, revision: 0, source: 'llm', createdAt: host.time });
  }
}

describe('HotelService', () => {
  it('assigns the lowest free room and never overbooks', () => {
    const hotel = new Hotel(3);
    expect(hotel.checkIn('a', 0)).toBe('hotel_room_1');
    expect(hotel.checkIn('b', 0)).toBe('hotel_room_2');
    expect(hotel.checkIn('a', 5)).toBe('hotel_room_1');
    expect(hotel.checkIn('c', 0)).toBe('hotel_room_3');
    expect(hotel.checkIn('d', 0)).toBeNull();
    expect(hotel.freeRooms()).toBe(0);
    hotel.checkOut('b');
    expect(hotel.freeRooms()).toBe(1);
    expect(hotel.checkIn('d', 1)).toBe('hotel_room_2');
  });

  it('restores guests and rebuilds a v1 save hotel from config', () => {
    const a = new Hotel(6);
    a.checkIn('x', 10);
    const b = new Hotel(6, structuredClone(a.state()));
    expect(b.state()).toEqual(a.state());
    expect(new Hotel(6, null).freeRooms()).toBe(6);
  });
});

describe('VisitorService', () => {
  it('first 10:00 train brings 2–3 visitors with mock LLM profiles', async () => {
    const llm = mockQueue();
    const { host, pw } = world(llm);
    pw.update(1);
    await Promise.resolve();
    expect(llm.calls).toBe(2);
    host.time = at(0, '10:00');
    const arrived = pw.onTrainArrived(host.time);
    expect(arrived.length).toBeGreaterThanOrEqual(2);
    expect(arrived.length).toBeLessThanOrEqual(3);
    for (const p of arrived) {
      expect(p).toMatchObject({ transient: true, visitor: true, homeId: 'hotel' });
      expect(p.seedMemories?.[0]).toMatch(/came to this village by train/);
    }
    const sources = arrived.map((p) => pw.visitors.info(p.id)?.source);
    expect(sources.slice(0, 2)).toEqual(['llm', 'fallback']);
    expect(new Set(arrived.map((p) => p.name)).size).toBe(arrived.length);
    expect(host.of('visitor.updated').length).toBe(arrived.length);
  });

  it('over 4 days keeps 2–4 visitors, checks them in, and removes them 1–3 days later', async () => {
    const { host, pw } = world(mockQueue());
    const stats = await runWithPlans(host, pw, 4);
    expect(stats.arrivals.size).toBeGreaterThanOrEqual(3);
    expect(Math.min(...stats.hourlyCounts)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...stats.hourlyCounts)).toBeLessThanOrEqual(4);
    expect(stats.maxOccupancy).toBeLessThanOrEqual(6);
    expect(stats.maxVillagers).toBeLessThanOrEqual(20);
    expect(stats.departures.size).toBeGreaterThan(0);
    for (const [id, leftAt] of stats.departures) {
      // Stays count in game days: they leave on a train 1–3 days after the arrival day.
      const days = dayOf(leftAt) - dayOf(stats.arrivals.get(id)!);
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(3);
      expect(leftAt - stats.arrivals.get(id)!).toBeGreaterThan(18 * 60);
    }
    const checkIns = host.of('visitor.updated').filter((m) => m.visitor.status === 'checkedIn');
    for (const m of checkIns) {
      expect(m.visitor.roomId).toMatch(/^hotel_room_\d$/);
      expect(host.time).toBeGreaterThan(m.visitor.arrivedAt);
    }
    expect(new Set(checkIns.map((m) => m.visitor.villagerId)).size).toBe(stats.arrivals.size);
  });

  it('a visitor who misses the train leaves on a later one, at the latest the second after', async () => {
    const { host, pw } = world(mockQueue());
    host.time = at(0, '09:59');
    await run(host, pw, 0.01);
    const [first] = pw.visitors.visitors();
    const id = first!.villagerId;
    const scheduled = first!.departsAt;
    const stats = await run(host, pw, 4, { stuck: new Set([id]) });
    const left = stats.departures.get(id);
    expect(left).toBeDefined();
    // Two missed trains (the scheduled one and the next), then removed wherever they are.
    expect(left!).toBeGreaterThan(scheduled);
    expect(pw.visitors.info(id)).toBeNull();
    expect(pw.hotel.state().rooms.some((r) => r.guestId === id)).toBe(false);
  });

  it('with a model that never answers, visitors still arrive from the fallback pool', async () => {
    const { host, pw } = world(mockQueue('never'));
    const stats = await run(host, pw, 1);
    expect(stats.arrivals.size).toBeGreaterThanOrEqual(2);
    for (const id of stats.arrivals.keys()) {
      const info =
        pw.visitors.info(id) ?? host.of('visitor.updated').find((m) => m.visitor.villagerId === id)!.visitor;
      expect(info.source).toBe('fallback');
    }
  });

  it('invalid LLM answers count as fallback; llmVisitors=false and overload make no calls', async () => {
    const bad = mockQueue('garbage');
    const a = world(bad);
    a.pw.update(1);
    await Promise.resolve();
    a.host.time = at(0, '10:00');
    const arrived = a.pw.onTrainArrived(a.host.time);
    expect(arrived.every((p) => a.pw.visitors.info(p.id)?.source === 'fallback')).toBe(true);

    const off = mockQueue();
    const b = world(off, { llmVisitors: false });
    b.pw.update(1);
    expect(off.calls).toBe(0);

    const busy = mockQueue();
    const c = world(busy);
    c.host.load = 'overloaded';
    c.pw.update(1);
    expect(busy.calls).toBe(0);
  });

  it('respects the villager cap and the free rooms', () => {
    const { host, pw } = world();
    host.time = at(0, '10:00');
    for (let i = 0; i < 15; i++)
      host.spawnVillager({ ...host.profiles.get('ada')!, id: `x${i}`, name: `X${i}` }, station);
    expect(host.states.length).toBe(19);
    expect(pw.onTrainArrived(host.time).length).toBeLessThanOrEqual(1);
  });

  it('round-trips visitors, profiles and the hotel through the save', async () => {
    const { host, pw } = world(mockQueue());
    host.time = at(0, '09:59');
    await run(host, pw, 0.2);
    const save = JSON.parse(JSON.stringify(pw.serialize()));
    expect(save.visitors.length).toBeGreaterThanOrEqual(2);
    expect(save.strangers.filter((p: { visitor?: boolean }) => p.visitor)).toHaveLength(save.visitors.length);
    const b = setup({ restore: save });
    expect(b.pw.visitors.visitors()).toEqual(save.visitors);
    expect(b.pw.hotel.state()).toEqual(save.hotel);
    expect(b.pw.strangers.profiles).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(b.pw.serialize()))).toEqual(save);
  });
});

async function runWithPlans(host: FakeHost, pw: PlayerWorld, days: number): Promise<RunStats> {
  const total: RunStats = {
    arrivals: new Map(),
    departures: new Map(),
    maxOccupancy: 0,
    maxVillagers: 0,
    hourlyCounts: [],
  };
  const hours = Math.round(days * 24 * 60);
  for (let t = 0; t < hours; t += 60) {
    planEveryMorning(host, pw);
    const s = await run(host, pw, Math.min(60, hours - t) / 1440);
    for (const [k, v] of s.arrivals) total.arrivals.set(k, v);
    for (const [k, v] of s.departures) total.departures.set(k, v);
    total.maxOccupancy = Math.max(total.maxOccupancy, s.maxOccupancy);
    total.maxVillagers = Math.max(total.maxVillagers, s.maxVillagers);
    total.hourlyCounts.push(...s.hourlyCounts);
  }
  return total;
}
