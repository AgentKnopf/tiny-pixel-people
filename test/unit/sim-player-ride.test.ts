import { describe, expect, it } from 'vitest';
import { PLAYER_ID, type PlayerState } from '../../src/shared/types.ts';
import { createSimTestWorld } from '../helpers/sim.ts';

describe('player on a ride', () => {
  it('boards off its walk-up path, stays on the ride for the cycle, then walks again', async () => {
    const { engine, messages } = createSimTestWorld({ startAt: '09:00' });
    const ride = engine.map.locations.find((l) => l.id === 'rollercoaster')!;
    const p = engine.playerWorld.state as PlayerState;
    p.pos = { ...ride.entry };
    p.gold = 100;
    const away = { x: ride.entry.x + 4, y: ride.entry.y - 1 };
    // The UI walks up and sends player.ride while the last steps of the path are still queued.
    expect(engine.handleCommand({ type: 'player.move', to: away })).toEqual([]);
    expect(p.path.length).toBeGreaterThan(0);
    expect(engine.handleCommand({ type: 'player.ride', locationId: ride.id })).toEqual([]);
    await engine.advance(1);
    expect(engine.rides.isRiding(PLAYER_ID)).toBe(true);
    expect(p.path).toEqual([]);
    expect(ride.spots!.some((s) => s.x === p.pos.x && s.y === p.pos.y)).toBe(true);
    const seat = { ...p.pos };
    expect(messages.some((m) => m.type === 'player.updated' && m.player.path.length === 0)).toBe(true);

    // A click while riding does not walk the player off the running ride.
    engine.handleCommand({ type: 'player.move', to: away });
    await engine.advance(3);
    expect(p.pos).toEqual(seat);
    expect(p.path).toEqual([]);

    await engine.advance(ride.ride!.durationMin);
    expect(engine.rides.isRiding(PLAYER_ID)).toBe(false);
    expect(engine.handleCommand({ type: 'player.move', to: away })).toEqual([]);
    await engine.advance(10);
    expect(p.pos).toEqual(away);
  });
});
