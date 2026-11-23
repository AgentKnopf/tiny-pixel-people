/** §14.1 Speed 0/1/2/4/8: game time per real second scales with speed; pause stops movement. */
import { afterEach, describe, expect, it } from 'vitest';
import { gameMinutesPerRealSecond } from '../../src/shared/time.ts';
import { ready, waitingFor } from '../helpers/features.ts';
import { createTestWorld, sleep, stubMind, type TestWorld } from '../helpers/world.ts';

let w: TestWorld | undefined;
afterEach(() => w?.dispose());

async function measure(world: TestWorld, speed: number, ms: number): Promise<number> {
  world.engine.setSpeed(speed);
  const t0 = world.now();
  const r0 = performance.now();
  world.engine.start();
  await sleep(ms);
  world.engine.stop();
  const elapsed = (performance.now() - r0) / 1000;
  return (world.now() - t0) / elapsed;
}

describe.skipIf(!ready('engine'))(`§14.1 speed control${waitingFor('engine')}`, () => {
  it('advances game time proportionally to the speed', async () => {
    w = await createTestWorld({ startAt: '10:00', createMind: stubMind, config: { sim: { tickMs: 20 } } });
    const base = gameMinutesPerRealSecond(w.config.sim.dayLengthMinutes);
    for (const speed of [1, 2, 4, 8]) {
      const rate = await measure(w, speed, 700);
      expect(rate / (base * speed), `speed ${speed}: ${rate.toFixed(2)} game min/s`).toBeGreaterThan(0.6);
      expect(rate / (base * speed), `speed ${speed}: ${rate.toFixed(2)} game min/s`).toBeLessThan(1.4);
    }
  }, 20_000);

  it('pause stops the clock and movement', async () => {
    w = await createTestWorld({ startAt: '10:00', config: { sim: { tickMs: 20 } } });
    await w.advance(30);
    const before = w.state();
    const rate = await measure(w, 0, 400);
    expect(rate).toBe(0);
    const after = w.state();
    expect(after.time).toBe(before.time);
    for (const v of after.villagers) {
      const b = before.villagers.find((x) => x.id === v.id)!;
      expect(v.pos, v.id).toEqual(b.pos);
    }
  }, 20_000);

  it.skipIf(!ready('engine', 'mind', 'queue', 'player'))(
    'keeps answering the player while paused',
    async () => {
      w = await createTestWorld({ startAt: '10:00', config: { sim: { tickMs: 20 } } });
      await w.advance(10);
      const v = w.state().villagers.find((x) => x.status !== 'sleeping')!;
      w.engine.setSpeed(0);
      w.engine.start();
      w.command({ type: 'player.say', villagerId: v.id, text: 'Hello, lovely weather today!', mode: 'say' });
      const ok = await (async () => {
        for (let i = 0; i < 50; i++) {
          if (w!.of('conversation.message').some((m) => m.speakerId === v.id && m.listenerId === 'player'))
            return true;
          await sleep(100);
        }
        return false;
      })();
      w.engine.stop();
      expect(ok).toBe(true);
    },
    20_000,
  );
});
