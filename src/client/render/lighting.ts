import { minuteOfDay } from '../../shared/time.ts';
import type { GameMinutes } from '../../shared/types.ts';

/** Night multiply colour from docs/art/README.md (about rgb(0.42, 0.5, 0.58)). */
export const NIGHT_TINT: readonly [number, number, number] = [107, 128, 148];
const DUSK_START = 18 * 60;
const DUSK_END = 20 * 60;
const DAWN_START = 5 * 60;
const DAWN_END = 7 * 60;

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** 0 = full day, 1 = full night. Fades over dusk (18:00–20:00) and dawn (05:00–07:00). */
export function nightFactor(t: GameMinutes): number {
  const m = minuteOfDay(t);
  if (m >= DAWN_END && m < DUSK_START) return 0;
  if (m >= DUSK_END || m < DAWN_START) return 1;
  if (m >= DUSK_START) return smoothstep((m - DUSK_START) / (DUSK_END - DUSK_START));
  return 1 - smoothstep((m - DAWN_START) / (DAWN_END - DAWN_START));
}

/** Multiply colour for the world at night factor `f`, darkened a little more in rain. */
export function tintColor(f: number, raining: boolean): [number, number, number] {
  const rain = raining ? 0.82 : 1;
  return [0, 1, 2].map((i) => Math.round((255 + (NIGHT_TINT[i]! - 255) * f) * rain)) as [
    number,
    number,
    number,
  ];
}

/** Use the lit (night) tile variants once the night is more than half in. */
export function useLitTiles(f: number): boolean {
  return f >= 0.5;
}
