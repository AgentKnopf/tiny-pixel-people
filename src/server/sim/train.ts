import type { AppConfig } from '../config.ts';
import type { GameMinutes, TrainState, TrainStatus, VillagerId } from '../../shared/types.ts';
import { dayOf, MINUTES_PER_DAY, parseClock } from '../../shared/time.ts';
import type { TrainService } from './types.ts';

/** Minutes the train is visible before it stops at the platform, and after it leaves. */
export const TRAIN_APPROACH_MINUTES = 5;
export const TRAIN_DEPART_MINUTES = 5;

export type TrainEventKind = 'arrived' | 'departing' | 'departed';

export interface TrainEvent {
  kind: TrainEventKind;
  /** Arrival time of the train the event belongs to. */
  arrivesAt: GameMinutes;
  at: GameMinutes;
}

/**
 * Clock-driven train (spec v2 §5.1): away → arriving (5 min) → boarding (dwell) → departing (5 min) → away.
 * Each status follows from the time and the current cycle's arrival, so large clock jumps stay consistent;
 * the events of a skipped cycle still fire in order.
 */
export class Train implements TrainService {
  private readonly arrivals: number[];
  private readonly dwell: number;
  private arrivesAt: GameMinutes;
  private arriving: VillagerId[] = [];
  private departing: VillagerId[] = [];
  private fired = { arrived: false, departing: false };
  private last: TrainState;
  private dirty = false;
  private events: TrainEvent[] = [];

  constructor(cfg: AppConfig['train'], now: GameMinutes, saved?: TrainState | null) {
    this.arrivals = [...new Set(cfg.arrivals.map(parseClock))].sort((a, b) => a - b);
    this.dwell = cfg.dwellMinutes;
    if (saved && saved.arrivesAt + this.dwell + TRAIN_DEPART_MINUTES > now) {
      this.arrivesAt = saved.arrivesAt;
      this.arriving = [...saved.arriving];
      this.departing = [...saved.departing];
      this.fired = { arrived: now >= saved.arrivesAt, departing: now >= saved.arrivesAt + this.dwell };
    } else {
      this.arrivesAt = this.nextScheduled(now);
    }
    this.last = this.state(now);
  }

  get departsAt(): GameMinutes {
    return this.arrivesAt + this.dwell;
  }

  private get endsAt(): GameMinutes {
    return this.departsAt + TRAIN_DEPART_MINUTES;
  }

  /** First scheduled arrival whose approach starts at or after `from`. */
  private nextScheduled(from: GameMinutes): GameMinutes {
    for (let day = dayOf(from); ; day++) {
      for (const m of this.arrivals) {
        const a = day * MINUTES_PER_DAY + m;
        if (a - TRAIN_APPROACH_MINUTES >= from) return a;
      }
    }
  }

  private statusAt(t: GameMinutes): TrainStatus {
    if (t < this.arrivesAt - TRAIN_APPROACH_MINUTES) return 'away';
    if (t < this.arrivesAt) return 'arriving';
    if (t < this.departsAt) return 'boarding';
    if (t < this.endsAt) return 'departing';
    return 'away';
  }

  state(now?: GameMinutes): TrainState {
    return {
      status: now === undefined ? this.last.status : this.statusAt(now),
      arrivesAt: this.arrivesAt,
      departsAt: this.departsAt,
      arriving: [...this.arriving],
      departing: [...this.departing],
    };
  }

  step(now: GameMinutes): TrainState | null {
    for (;;) {
      if (!this.fired.arrived && now >= this.arrivesAt) {
        this.fired.arrived = true;
        this.events.push({ kind: 'arrived', arrivesAt: this.arrivesAt, at: this.arrivesAt });
      }
      if (!this.fired.departing && now >= this.departsAt) {
        this.fired.departing = true;
        this.events.push({ kind: 'departing', arrivesAt: this.arrivesAt, at: this.departsAt });
      }
      if (now < this.endsAt) break;
      this.events.push({ kind: 'departed', arrivesAt: this.arrivesAt, at: this.endsAt });
      this.arrivesAt = this.nextScheduled(this.endsAt);
      this.arriving = [];
      this.departing = [];
      this.fired = { arrived: false, departing: false };
      this.dirty = true;
    }
    const next = this.state(now);
    const changed = this.dirty || next.status !== this.last.status || next.arrivesAt !== this.last.arrivesAt;
    this.last = next;
    this.dirty = false;
    return changed ? next : null;
  }

  triggerNow(now: GameMinutes): void {
    if (this.statusAt(now) !== 'away') return;
    this.arrivesAt = now + TRAIN_APPROACH_MINUTES;
    this.arriving = [];
    this.departing = [];
    this.fired = { arrived: false, departing: false };
    this.dirty = true;
  }

  /** Who gets off (on arrival) and who boards (at departure); shown by the client and the observer API. */
  setPassengers(p: { arriving?: readonly VillagerId[]; departing?: readonly VillagerId[] }): void {
    if (p.arriving) this.arriving = [...p.arriving];
    if (p.departing) this.departing = [...p.departing];
    this.dirty = true;
  }

  /** Events since the last call, oldest first. */
  takeEvents(): TrainEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}
