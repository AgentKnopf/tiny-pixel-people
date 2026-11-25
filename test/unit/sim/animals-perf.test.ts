import { describe, expect, it } from 'vitest';
import { MINUTES_PER_DAY } from '../../../src/shared/time.ts';
import { cpuMax, startTiming, type Timing } from '../../helpers/cpu-meter.ts';
import { makeSim } from './animal-fixture.ts';

/** One game day of ~80 animals around 20 people; the time of each step. */
function animalDay(): Timing[] {
  const sim = makeSim({ now: 0 });
  expect(sim.all().length).toBeGreaterThanOrEqual(60);
  const people = Array.from({ length: 20 }, (_, i) => ({ x: 90 + i, y: 30 + (i % 20) }));
  const times: Timing[] = [];
  for (let t = 1; t <= MINUTES_PER_DAY; t++) {
    const stop = startTiming();
    sim.step(t, people);
    sim.frames();
    times.push(stop());
  }
  return times;
}

// Spec v2 §16: a full sim step (20 villagers + 80 animals) has p95 ≤ 4 ms and max ≤ 20 ms; animals
// get a small slice of that. p95 is wall time; the max is CPU time (see test/helpers/cpu-meter.ts).
describe('AnimalSim performance', () => {
  it('steps ~80 animals well within the sim budget over one game day', () => {
    const times = animalDay();
    const walls = times.map((t) => t.wall).sort((a, b) => a - b);
    const p95 = walls[Math.floor(walls.length * 0.95)]!;
    let m = cpuMax(times);
    // Without CPU time a host pause cannot be told from slow work; a slow step shows up again.
    if (m.on === 'wall' && m.max >= 10) m = cpuMax(animalDay());
    expect(p95).toBeLessThan(1);
    expect(m.max, `max ${m.max.toFixed(2)} ms ${m.on} at step ${m.at}`).toBeLessThan(10);
  });
});
