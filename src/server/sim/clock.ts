import { gameMinutesPerRealSecond } from '../../shared/time.ts';
import type { GameMinutes } from '../../shared/types.ts';

export interface ClockOptions {
  dayLengthMinutes: number;
  speed: number;
  nightSpeedMultiplier: number;
}

/** Game clock. Real mode converts real elapsed time to game minutes; tests call `tick()` directly. */
export class SimClock {
  speed: number;
  private readonly perRealSecond: number;
  private readonly nightMultiplier: number;

  constructor(
    public time: GameMinutes,
    opts: ClockOptions,
  ) {
    this.speed = opts.speed;
    this.perRealSecond = gameMinutesPerRealSecond(opts.dayLengthMinutes);
    this.nightMultiplier = opts.nightSpeedMultiplier;
  }

  /** Game minutes that pass per real second at speed 1. */
  get gameMinutesPerRealSecond(): number {
    return this.perRealSecond;
  }

  /** Game minutes for `realMs` of wall time at the current speed. */
  gameMinutesFor(realMs: number, everyoneAsleep: boolean): number {
    if (this.speed <= 0) return 0;
    const mult = everyoneAsleep ? this.nightMultiplier : 1;
    return (realMs / 1000) * this.perRealSecond * this.speed * mult;
  }

  /** Real seconds (at speed 1) that correspond to `gameMinutes`; used to move the player in virtual mode. */
  realSecondsFor(gameMinutes: number): number {
    return gameMinutes / this.perRealSecond;
  }
}
