import { describe, expect, it } from 'vitest';
import type { ChatRequest, LlmQueue } from '../../../src/server/llm/types.ts';
import { at, minuteOfDay } from '../../../src/shared/time.ts';
import { PLAYER_ID, type DayPlan } from '../../../src/shared/types.ts';
import { departureTime } from '../../../src/server/player/strangers.ts';
import { advance, setup } from './fake-host.ts';

function plan(): DayPlan {
  return {
    day: 0,
    summary: '',
    revision: 1,
    source: 'llm',
    createdAt: 0,
    blocks: [
      { start: 360, end: 470, locationId: 'park', activity: 'morning walk', done: true },
      { start: 480, end: 600, locationId: 'park', activity: 'picnic' },
      { start: 600, end: 700, locationId: 'square', activity: 'chat', eventId: 'ev' },
      { start: 700, end: 800, locationId: 'square', activity: 'people watching' },
      { start: 800, end: 900, locationId: 'bakery', activity: 'buy bread' },
    ],
  };
}

describe('rain', () => {
  it('starts rain, tells awake villagers, moves outdoor blocks indoors and restores them', () => {
    const { host, pw } = setup();
    const ada = host.states.find((v) => v.id === 'ada')!;
    ada.plan = plan();
    expect(pw.handleCommand({ type: 'world.trigger', kind: 'rain' })).toEqual([]);
    expect(pw.weather.state).toBe('rain');
    const until = pw.weather.until!;
    expect(until - host.time).toBeGreaterThanOrEqual(60);
    expect(until - host.time).toBeLessThanOrEqual(180);
    expect(host.of('weather.updated')).toHaveLength(1);
    expect(host.of('world.event')[0]!.event).toMatchObject({ kind: 'rain', endsAt: until });
    expect(
      host.memories
        .filter((m) => m.text === 'It started raining')
        .map((m) => m.villagerId)
        .sort(),
    ).toEqual(['ada', 'ben', 'cy']);

    const locs = ada.plan!.blocks.map((b) => b.locationId);
    // done block untouched, park -> nearest shop/home, event block untouched, square -> nearest, bakery stays
    expect(locs[0]).toBe('park');
    expect(['bakery', 'shop', 'house_ada']).toContain(locs[1]);
    expect(locs[2]).toBe('square');
    expect(['bakery', 'shop', 'house_ada']).toContain(locs[3]);
    expect(locs[4]).toBe('bakery');

    expect(pw.handleCommand({ type: 'world.trigger', kind: 'rain' })?.[0]).toMatchObject({
      message: "It's already raining",
    });

    advance(host, pw, until - host.time);
    expect(pw.weather.state).toBe('clear');
    expect(ada.plan!.blocks.map((b) => b.locationId)).toEqual(['park', 'park', 'square', 'square', 'bakery']);
    expect(host.of('weather.updated')).toHaveLength(2);
    expect(host.of('world.event').at(-1)!.event).toMatchObject({ kind: 'rain', data: { ended: true } });
    expect(pw.events.active()).toEqual([]);
  });

  it('swaps plans written while it rains', () => {
    const { host, pw } = setup();
    pw.handleCommand({ type: 'world.trigger', kind: 'rain' });
    const ben = host.states.find((v) => v.id === 'ben')!;
    ben.plan = plan();
    advance(host, pw, 1);
    expect(ben.plan!.blocks[3]!.locationId).not.toBe('square');
  });

  it('random weather starts rain on its own when enabled', () => {
    const { host, pw } = setup({ world: { randomWeather: true } });
    advance(host, pw, 24 * 60 * 3, 10);
    expect(host.of('weather.updated').length).toBeGreaterThan(0);
    const off = setup();
    advance(off.host, off.pw, 24 * 60 * 3, 10);
    expect(off.host.of('weather.updated')).toHaveLength(0);
  });
});

describe('party', () => {
  it('creates a player-hosted event at the plaza in 30 minutes for all awake villagers', () => {
    const { host, pw } = setup();
    expect(pw.handleCommand({ type: 'world.trigger', kind: 'party' })).toEqual([]);
    expect(host.events).toHaveLength(1);
    const ev = host.events[0]!;
    expect(ev).toMatchObject({
      title: 'Party at the plaza',
      hostId: PLAYER_ID,
      locationId: 'square',
      status: 'scheduled',
    });
    expect(ev.start).toBe(host.time + 30);
    expect(ev.end - ev.start).toBe(120);
    expect(ev.invitees.sort()).toEqual(['ada', 'ben', 'cy']);
    expect(host.of('world.event')[0]!.event).toMatchObject({
      kind: 'party',
      data: { villageEventId: ev.id },
    });
    expect(pw.handleCommand({ type: 'world.trigger', kind: 'party' })?.[0]).toMatchObject({ type: 'error' });
    advance(host, pw, 151, 10);
    expect(pw.events.active()).toEqual([]);
    expect(pw.handleCommand({ type: 'world.trigger', kind: 'party' })).toEqual([]);
  });
});

describe('birthday', () => {
  it('tells everyone and plans a party at the cafe/bakery at 17:00 with friends', () => {
    const { host, pw } = setup();
    const ada = host.states.find((v) => v.id === 'ada')!;
    ada.relationships = { ben: { affinity: 5 }, cy: { affinity: 3 }, dot: { affinity: 2 } };
    expect(pw.handleCommand({ type: 'world.trigger', kind: 'birthday', villagerId: 'ada' })).toEqual([]);
    expect(host.memoriesOf('ada')[0]!.text).toBe("Today is my birthday! It's Ada's big day");
    for (const id of ['ben', 'cy', 'dot'])
      expect(host.memoriesOf(id)[0]!.text).toBe("Today is Ada's birthday");
    const ev = host.events[0]!;
    expect(ev).toMatchObject({
      title: "Ada's birthday",
      hostId: 'ada',
      locationId: 'bakery',
      start: at(0, '17:00'),
    });
    expect(ev.invitees).toEqual(['ben', 'cy', 'dot']);
    expect(
      pw.handleCommand({ type: 'world.trigger', kind: 'birthday', villagerId: 'ada' })?.[0],
    ).toMatchObject({ type: 'error' });
  });

  it('tops up guests when there are few friends and starts soon when it is late', () => {
    const { host, pw } = setup();
    host.time = at(0, '18:00');
    pw.handleCommand({ type: 'world.trigger', kind: 'birthday', villagerId: 'ben' });
    const ev = host.events[0]!;
    expect(ev.invitees).toHaveLength(3);
    expect(ev.start).toBe(host.time + 30);
  });

  it('picks a random non-stranger villager when none is given', () => {
    const { host, pw } = setup();
    pw.handleCommand({ type: 'world.trigger', kind: 'birthday' });
    expect(['ada', 'ben', 'cy']).toContain(host.events[0]!.hostId);
  });
});

describe('town event', () => {
  it('asks the engine for an event proposal', () => {
    const { host, pw } = setup();
    expect(pw.handleCommand({ type: 'world.trigger', kind: 'townEvent' })).toEqual([]);
    expect(host.proposals).toBe(1);
  });
});

describe('stranger', () => {
  it('spawns a transient visitor at the map edge with news, and it leaves at 22:00', () => {
    const { host, pw } = setup();
    expect(pw.handleCommand({ type: 'world.trigger', kind: 'stranger' })).toEqual([]);
    const { profile, at: spawnAt } = host.spawned[0]!;
    expect(profile).toMatchObject({ transient: true, homeId: 'square', sprite: 'characters/stranger.png' });
    expect(profile.id).toMatch(/^stranger_/);
    expect(profile.seedMemories!.some((m) => m.startsWith('News I carry'))).toBe(true);
    expect(spawnAt.x === 1 || spawnAt.x === 28).toBe(true);
    expect(pw.strangers.profiles).toHaveLength(1);
    expect(host.memories.filter((m) => m.text.startsWith('A stranger named')).length).toBe(3);
    const ev = host.of('world.event')[0]!.event;
    expect(ev).toMatchObject({ kind: 'stranger', endsAt: at(0, '22:00'), data: { strangerId: profile.id } });

    advance(host, pw, at(0, '22:00') - host.time, 10);
    expect(host.removed).toEqual([profile.id]);
    expect(pw.strangers.profiles).toEqual([]);
  });

  it('late arrivals leave by 02:00 the next morning; respects the 20-villager cap', () => {
    expect(departureTime(at(0, '09:00'))).toBe(at(0, '22:00'));
    expect(departureTime(at(0, '21:00'))).toBe(at(1, '02:00'));
    expect(departureTime(at(0, '23:30'))).toBe(at(1, '02:00'));
    expect(departureTime(at(1, '00:30'))).toBe(at(1, '02:00'));
    expect(departureTime(at(1, '01:50'))).toBe(at(1, '02:20'));
    const { host, pw } = setup();
    host.time = at(0, '21:00');
    pw.handleCommand({ type: 'world.trigger', kind: 'stranger' });
    expect(host.of('world.event')[0]!.event.endsAt).toBe(at(1, '02:00'));
    advance(host, pw, at(1, '02:00') - host.time, 10);
    expect(host.removed).toHaveLength(1);
    const capped = setup();
    capped.pw.ctx.cfg.maxVillagers = 4;
    expect(capped.pw.handleCommand({ type: 'world.trigger', kind: 'stranger' })?.[0]).toMatchObject({
      message: expect.stringContaining('full'),
    });
  });

  it('never repeats a visitor who is still in town', () => {
    const { host, pw } = setup();
    const n = pw.ctx.catalogs.strangers.length;
    for (let i = 0; i < n; i++)
      expect(pw.handleCommand({ type: 'world.trigger', kind: 'stranger' })).toEqual([]);
    expect(new Set(host.spawned.map((s) => s.profile.id)).size).toBe(n);
    expect(pw.handleCommand({ type: 'world.trigger', kind: 'stranger' })?.[0]).toMatchObject({
      type: 'error',
    });
  });

  it('uses stranger.create when world.llmStrangers is on, with the template as fallback', async () => {
    const answers = [
      '```json\n{"name":"Marlo","age":40,"occupation":"juggler","bio":"Juggles. Laughs.","traits":["fun"],"news":"The river froze."}\n```',
      'not json at all',
    ];
    const requests: ChatRequest[] = [];
    const queue: LlmQueue = {
      enqueue: async (req) => {
        requests.push(req);
        return { text: answers.shift()!, model: 'mock', latencyMs: 1 };
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
    const { host, pw } = setup({ world: { llmStrangers: true } });
    host.llm = queue;
    pw.handleCommand({ type: 'world.trigger', kind: 'stranger' });
    expect(pw.handleCommand({ type: 'world.trigger', kind: 'stranger' })?.[0]).toMatchObject({
      type: 'error',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(requests[0]!.task).toBe('stranger.create');
    expect(host.spawned[0]!.profile).toMatchObject({ name: 'Marlo', occupation: 'juggler', transient: true });
    expect(host.spawned[0]!.profile.seedMemories![1]).toContain('The river froze.');

    pw.handleCommand({ type: 'world.trigger', kind: 'stranger' });
    await new Promise((r) => setTimeout(r, 0));
    const fallback = host.spawned[1]!.profile;
    expect(pw.ctx.catalogs.strangers.map((t) => t.name)).toContain(fallback.name);
    expect(minuteOfDay(host.time)).toBe(480);
  });
});
