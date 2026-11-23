import type { GameMinutes } from './types.ts';

export const MINUTES_PER_DAY = 1440;

export function dayOf(t: GameMinutes): number {
  return Math.floor(t / MINUTES_PER_DAY);
}

export function minuteOfDay(t: GameMinutes): number {
  return ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** "HH:MM" -> minute of day. Throws on invalid input. */
export function parseClock(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`Invalid time "${hhmm}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new Error(`Invalid time "${hhmm}"`);
  return h * 60 + min;
}

/** Minute of day (or absolute game minutes) -> "HH:MM". */
export function formatClock(t: GameMinutes): string {
  const m = Math.floor(minuteOfDay(t));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function at(day: number, hhmm: string): GameMinutes {
  return day * MINUTES_PER_DAY + parseClock(hhmm);
}

/** Game minutes that pass per real second at speed 1. */
export function gameMinutesPerRealSecond(dayLengthMinutes: number): number {
  return MINUTES_PER_DAY / (dayLengthMinutes * 60);
}
