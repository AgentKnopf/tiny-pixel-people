import { describe, expect, it } from 'vitest';
import { distance } from '../../../src/server/player/geometry.ts';
import { at, gameMinutesPerRealSecond } from '../../../src/shared/time.ts';
import { DEFAULT_CONFIG } from '../../../src/server/config.ts';
import { PLAYER_ID } from '../../../src/shared/types.ts';
import { advance, setup, villager } from './fake-host.ts';

/** Game minutes per 100 ms tick at 8x with the default 15-minute day. */
const DT_8X =
  gameMinutesPerRealSecond(DEFAULT_CONFIG.sim.dayLengthMinutes) * 8 * (DEFAULT_CONFIG.sim.tickMs / 1000);

describe('high speed steps', () => {
  it('8x ticks are larger than one tile of walking', () => {
    expect(DT_8X).toBeCloseTo(1.28);
  });

  for (const dt of [DT_8X, 5]) {
    it(`picks up every item walked over with dt=${dt.toFixed(2)}`, () => {
      const { host, pw } = setup();
      pw.items.items = [5, 7, 9, 11, 13].map((x, i) => ({ id: `g${i}`, itemId: 'apple', pos: { x, y: 16 } }));
      pw.handleCommand({ type: 'player.move', to: { x: 14, y: 16 } });
      advance(host, pw, 20, dt);
      expect(pw.state.pos).toEqual({ x: 14, y: 16 });
      expect(pw.state.inventory).toEqual([{ itemId: 'apple', count: 5 }]);
      expect(pw.items.items).toEqual([]);
    });

    it(`pet catches up and stays close with dt=${dt.toFixed(2)}`, () => {
      const { host, pw } = setup();
      pw.handleCommand({ type: 'player.move', to: { x: 25, y: 10 } });
      advance(host, pw, 40, dt);
      expect(pw.state.pos).toEqual({ x: 25, y: 10 });
      expect(distance(pw.state.pet.pos, pw.state.pos)).toBeLessThanOrEqual(2);
    });
  }

  it('event attendance still counts with coarse steps', () => {
    const { host, pw } = setup();
    const ev = {
      id: 'e',
      title: 'Fair',
      description: '',
      hostId: 'ada',
      locationId: 'square',
      start: host.time,
      end: host.time + 60,
      invitees: [],
      accepted: [],
      declined: [],
      attendees: [],
      status: 'happening' as const,
    };
    host.events.push(ev);
    pw.handleCommand({ type: 'player.move', to: { x: 13, y: 9 } });
    advance(host, pw, 60, 5);
    host.events[0]!.status = 'done';
    advance(host, pw, 5, 5);
    expect(pw.state.gold).toBe(60);
  });

  it('random weather rolls for every hour crossed, even with huge steps', () => {
    const fine = setup({ world: { randomWeather: true } });
    const coarse = setup({ world: { randomWeather: true } });
    advance(fine.host, fine.pw, 3 * 1440, 60);
    advance(coarse.host, coarse.pw, 3 * 1440, 180);
    expect(fine.host.of('weather.updated').length).toBeGreaterThan(0);
    expect(coarse.host.of('weather.updated').length).toBeGreaterThan(0);
  });
});

describe('save / restore of all player state', () => {
  function busyWorld() {
    const a = setup();
    a.pw.addGold(40, 'test');
    a.pw.pickup(a.pw.items.items[0]!.id);
    a.pw.pickup(a.pw.items.items[0]!.id);
    a.pw.handleCommand({ type: 'decor.toggle', itemId: 'mailbox' });
    a.pw.handleCommand({ type: 'decor.toggle', itemId: 'flag' });
    a.pw.handleCommand({ type: 'decor.toggle', itemId: 'flag' });
    a.pw.handleCommand({ type: 'pet.command', action: 'rename', name: 'Mochi' });
    a.pw.handleCommand({ type: 'player.rumor', villagerId: 'ada', text: 'The well is full of coins' });
    const originId = a.pw.rumors.all()[0]!.originMemoryId;
    a.pw.onLearned({ from: 'ada', to: 'ben', originId, text: 'coins in the well', at: a.host.time });
    a.pw.handleCommand({ type: 'world.trigger', kind: 'stranger' });
    a.pw.handleCommand({ type: 'world.trigger', kind: 'rain' });
    a.pw.handleCommand({ type: 'player.move', to: { x: 20, y: 16 } });
    advance(a.host, a.pw, 3);
    a.pw.handleCommand({ type: 'pet.command', action: 'stay' });
    return a;
  }

  it('round-trips through JSON exactly', () => {
    const a = busyWorld();
    const saved = JSON.parse(JSON.stringify(a.pw.serialize()));
    expect(saved.player).toMatchObject({
      gold: 90 - 6 - 6,
      inventory: [{ itemId: 'flower', count: 2 }],
      ownedDecorations: ['mailbox', 'flag'],
      placedDecorations: ['mailbox'],
      pet: { name: 'Mochi', mode: 'stay', species: 'cat' },
    });
    expect(saved.player.path.length).toBeGreaterThan(0);
    expect(saved.rumors[0].hops).toHaveLength(1);
    expect(saved.weather.state).toBe('rain');
    expect(saved.strangers).toHaveLength(1);
    const b = setup({ restore: saved });
    expect(JSON.parse(JSON.stringify(b.pw.serialize()))).toEqual(saved);
    expect(b.pw.snapshot()).toEqual({
      player: saved.player,
      rumors: saved.rumors,
      weather: saved.weather,
      items: saved.items,
      worldEvents: saved.worldEvents,
    });
  });

  it('keeps working after a restore', () => {
    const a = busyWorld();
    const saved = JSON.parse(JSON.stringify(a.pw.serialize()));
    const b = setup({ restore: saved });
    b.host.time = a.host.time;
    const stranger = saved.strangers[0];
    b.host.add(stranger, villager(stranger.id, { x: 1, y: 10 }));

    // The walk continues along the saved path.
    advance(b.host, b.pw, 20);
    expect(b.pw.state.pos).toEqual({ x: 20, y: 16 });
    // Rumor hops continue on the restored rumor.
    const originId = saved.rumors[0].originMemoryId;
    b.pw.onLearned({ from: 'ben', to: 'cy', originId, text: 'coins', at: b.host.time });
    expect(b.pw.rumors.all()[0]!.knownBy).toEqual(['ada', 'ben', 'cy']);
    // Restored rain ends on time and clears the weather.
    advance(b.host, b.pw, saved.weather.until - b.host.time);
    expect(b.pw.weather.state).toBe('clear');
    // Already placed decorations are not re-announced; new ones are.
    b.host.states.push(villager('eve', { x: 8, y: 16 }));
    advance(b.host, b.pw, 1);
    expect(b.host.memoriesOf('eve')).toEqual([]);
    b.pw.handleCommand({ type: 'decor.toggle', itemId: 'flag' });
    advance(b.host, b.pw, 1);
    expect(b.host.memoriesOf('eve').map((m) => m.text)).toEqual(["Kai's cottage has new flag"]);
    // Re-placing an owned decoration is free.
    expect(b.pw.state.gold).toBe(saved.player.gold);
    // The restored stranger still leaves at 22:00.
    advance(b.host, b.pw, at(0, '22:00') - b.host.time, 10);
    expect(b.host.removed).toEqual([stranger.id]);
    expect(b.pw.strangers.profiles).toEqual([]);
    expect(b.pw.serialize().player.id).toBe(PLAYER_ID);
  });
});
