import { describe, expect, it } from 'vitest';
import {
  at,
  dayOf,
  formatClock,
  gameMinutesPerRealSecond,
  minuteOfDay,
  parseClock,
} from '../../src/shared/time.ts';

describe('time helpers', () => {
  it('parses and formats clock strings', () => {
    expect(parseClock('06:00')).toBe(360);
    expect(parseClock('23:59')).toBe(1439);
    expect(formatClock(360)).toBe('06:00');
    expect(formatClock(at(2, '13:05'))).toBe('13:05');
    expect(() => parseClock('25:00')).toThrow();
    expect(() => parseClock('noon')).toThrow();
  });

  it('splits absolute game time into day and minute', () => {
    const t = at(3, '08:30');
    expect(dayOf(t)).toBe(3);
    expect(minuteOfDay(t)).toBe(510);
  });

  it('computes clock rate from day length', () => {
    expect(gameMinutesPerRealSecond(15)).toBeCloseTo(1.6);
  });
});
