import type { GameMinutes, Location, LocationId, RideSpec, RideState, VillagerId } from '../../shared/types.ts';
import { minuteOfDay, parseClock } from '../../shared/time.ts';
import type { RideService } from './types.ts';

/** A rider who waits longer than this leaves the queue (spec v2 §4). */
export const RIDE_MAX_WAIT_MINUTES = 20;

export type RideEventKind = 'boarded' | 'finished' | 'gaveUp';

export interface RideEvent {
  kind: RideEventKind;
  riderId: VillagerId;
  rideId: LocationId;
  at: GameMinutes;
}

interface Ride {
  loc: Location & { ride: RideSpec };
  open: number;
  close: number;
  state: RideState;
  joinedAt: Map<VillagerId, GameMinutes>;
}

function isOpen(open: number, close: number, now: GameMinutes): boolean {
  const m = minuteOfDay(now);
  return open <= close ? m >= open && m < close : m >= open || m < close;
}

/** Queues and cycles of every `ride` location. Deterministic; riders may include PLAYER_ID. */
export class Rides implements RideService {
  private readonly rides = new Map<LocationId, Ride>();
  private readonly byRider = new Map<VillagerId, LocationId>();
  private events: RideEvent[] = [];
  private now: GameMinutes;

  constructor(locations: readonly Location[], zooHours: { openTime: string; closeTime: string }, now: GameMinutes) {
    this.now = now;
    for (const loc of locations) {
      if (loc.kind !== 'ride' || !loc.ride) continue;
      const open = parseClock(loc.hours?.open ?? zooHours.openTime);
      const close = parseClock(loc.hours?.close ?? zooHours.closeTime);
      this.rides.set(loc.id, {
        loc: loc as Ride['loc'],
        open,
        close,
        joinedAt: new Map(),
        state: {
          locationId: loc.id,
          status: isOpen(open, close, now) ? 'idle' : 'closed',
          riders: [],
          queue: [],
          cycleEndsAt: null,
        },
      });
    }
  }

  spec(rideId: LocationId): RideSpec | null {
    return this.rides.get(rideId)?.loc.ride ?? null;
  }

  isOpen(rideId: LocationId, now: GameMinutes = this.now): boolean {
    const r = this.rides.get(rideId);
    return !!r && isOpen(r.open, r.close, now);
  }

  /** The ride a villager is queueing for or riding. */
  rideOf(villagerId: VillagerId): LocationId | null {
    return this.byRider.get(villagerId) ?? null;
  }

  isRiding(villagerId: VillagerId): boolean {
    const id = this.byRider.get(villagerId);
    return !!id && !!this.rides.get(id)?.state.riders.includes(villagerId);
  }

  join(villagerId: VillagerId, rideId: LocationId): boolean {
    const r = this.rides.get(rideId);
    if (!r || !isOpen(r.open, r.close, this.now)) return false;
    const current = this.byRider.get(villagerId);
    if (current === rideId) return true;
    if (current) this.leave(villagerId);
    r.state.queue.push(villagerId);
    r.joinedAt.set(villagerId, this.now);
    this.byRider.set(villagerId, rideId);
    return true;
  }

  leave(villagerId: VillagerId): void {
    const id = this.byRider.get(villagerId);
    if (!id) return;
    const r = this.rides.get(id)!;
    r.state.queue = r.state.queue.filter((v) => v !== villagerId);
    r.state.riders = r.state.riders.filter((v) => v !== villagerId);
    r.joinedAt.delete(villagerId);
    this.byRider.delete(villagerId);
  }

  step(now: GameMinutes): RideState[] {
    this.now = now;
    const changed: RideState[] = [];
    for (const r of this.rides.values()) {
      const before = JSON.stringify(r.state);
      const s = r.state;
      if (s.status === 'running' && s.cycleEndsAt !== null && now >= s.cycleEndsAt) {
        for (const id of s.riders) this.drop(id, 'finished', r, s.cycleEndsAt);
        s.riders = [];
        s.status = 'idle';
        s.cycleEndsAt = null;
      }
      const open = isOpen(r.open, r.close, now);
      for (const id of [...s.queue]) {
        if (!open || now - (r.joinedAt.get(id) ?? now) > RIDE_MAX_WAIT_MINUTES) this.drop(id, 'gaveUp', r, now);
      }
      if (s.status !== 'running') s.status = open ? 'idle' : 'closed';
      if (s.status === 'idle' && s.queue.length > 0) {
        const boarding = s.queue.splice(0, r.loc.ride.capacity);
        s.riders = boarding;
        s.status = 'running';
        s.cycleEndsAt = now + r.loc.ride.durationMin;
        for (const id of boarding) {
          r.joinedAt.delete(id);
          this.events.push({ kind: 'boarded', riderId: id, rideId: r.loc.id, at: now });
        }
      }
      if (JSON.stringify(s) !== before) changed.push(structuredClone(s));
    }
    return changed;
  }

  private drop(id: VillagerId, kind: 'finished' | 'gaveUp', r: Ride, at: GameMinutes): void {
    r.state.queue = r.state.queue.filter((v) => v !== id);
    r.joinedAt.delete(id);
    this.byRider.delete(id);
    this.events.push({ kind, riderId: id, rideId: r.loc.id, at });
  }

  all(): readonly RideState[] {
    return [...this.rides.values()].map((r) => structuredClone(r.state));
  }

  /** Events since the last call, oldest first. */
  takeEvents(): RideEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}
