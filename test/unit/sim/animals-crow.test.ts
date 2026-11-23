import { describe, expect, it } from 'vitest';
import { MINUTES_PER_DAY, minuteOfDay } from '../../../src/shared/time.ts';
import { makeSim, PERCH, POST_OFFICE } from './animal-fixture.ts';

const onPerch = (p: { x: number; y: number }) => PERCH.some((q) => q.x === p.x && q.y === p.y);

describe('AnimalSim crow', () => {
  it('stays on the perch or flies near the post office, and sleeps 20:00-06:00', () => {
    const sim = makeSim({ now: 0 });
    const id = sim.crowId()!;
    expect(id).toBeTruthy();
    const flightsPerDay = new Map<number, number>();
    let wasFlying = false;
    for (let t = 1; t <= 3 * MINUTES_PER_DAY; t++) {
      sim.step(t, []);
      const crow = sim.all().find((a) => a.id === id)!;
      const dist = Math.max(Math.abs(crow.pos.x - POST_OFFICE.x), Math.abs(crow.pos.y - POST_OFFICE.y));
      expect(onPerch(crow.pos) || (crow.status === 'flying' && dist <= 6), `t=${t}`).toBe(true);
      const m = minuteOfDay(t);
      if (m >= 20 * 60 || m < 6 * 60) {
        expect(crow.status, `t=${t}`).toBe('sleeping');
        expect(onPerch(crow.pos)).toBe(true);
      }
      const flying = crow.status === 'flying';
      if (flying && !wasFlying) {
        const day = Math.floor(t / MINUTES_PER_DAY);
        flightsPerDay.set(day, (flightsPerDay.get(day) ?? 0) + 1);
      }
      wasFlying = flying;
    }
    for (let day = 0; day < 3; day++) {
      const n = flightsPerDay.get(day) ?? 0;
      expect(n, `day ${day}`).toBeGreaterThanOrEqual(3);
      expect(n, `day ${day}`).toBeLessThanOrEqual(6);
    }
  });

  it('caws with a 30-minute cooldown', () => {
    const sim = makeSim();
    let t = 8 * 60;
    const caws = () => sim.step(++t, []).emotes.filter((e) => e.emote === 'Caw!').length;
    sim.step(++t, []);
    sim.caw('letter');
    expect(caws()).toBe(1);
    for (let i = 0; i < 10; i++) sim.step(++t, []);
    sim.caw('player');
    expect(caws()).toBe(0);
    for (let i = 0; i < 25; i++) sim.step(++t, []);
    sim.caw('player');
    expect(caws()).toBe(1);
  });

  it('has no crow without a perch', () => {
    const sim = makeSim({
      map: (() => {
        const m = makeSim().crowId() ? undefined : undefined;
        void m;
        return { ...animalMapWithoutPerch() };
      })(),
    });
    expect(sim.crowId()).toBeNull();
    sim.caw('letter');
    expect(sim.step(8 * 60 + 1, []).emotes).toEqual([]);
  });
});

import { animalTestMap } from './animal-fixture.ts';
function animalMapWithoutPerch() {
  const m = animalTestMap();
  m.locations = m.locations.map((l) => (l.id === 'post_office' ? { ...l, perch: undefined } : l));
  return m;
}
