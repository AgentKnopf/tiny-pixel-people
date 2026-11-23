import { describe, expect, it } from 'vitest';
import { MINUTES_PER_DAY } from '../../../src/shared/time.ts';
import { makeSim } from './animal-fixture.ts';

// Spec v2 §16: a full sim step (20 villagers + 80 animals) has p95 ≤ 4 ms and max ≤ 20 ms; animals
// get a small slice of that.
describe('AnimalSim performance', () => {
  it('steps ~80 animals well within the sim budget over one game day', () => {
    const sim = makeSim({ now: 0 });
    expect(sim.all().length).toBeGreaterThanOrEqual(60);
    const people = Array.from({ length: 20 }, (_, i) => ({ x: 90 + i, y: 30 + (i % 20) }));
    const times: number[] = [];
    for (let t = 1; t <= MINUTES_PER_DAY; t++) {
      const start = performance.now();
      sim.step(t, people);
      sim.frames();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    const max = times[times.length - 1]!;
    expect(p95).toBeLessThan(1);
    expect(max).toBeLessThan(10);
  });
});
