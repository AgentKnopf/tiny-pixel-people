import { dayOf, minuteOfDay } from '../../shared/time.ts';
import type {
  DayPlan,
  LocationId,
  PlanBlock,
  VillagerId,
  VillagerState,
  Weather,
} from '../../shared/types.ts';
import type { Ctx } from './context.ts';
import { distance } from './geometry.ts';
import type { WorldEventLog } from './world-event-log.ts';

export const RAIN_MIN_MINUTES = 60;
export const RAIN_MAX_MINUTES = 180;
/** Chance per daytime game hour that rain starts on its own (`world.randomWeather`). */
export const RANDOM_RAIN_CHANCE = 0.06;

interface Swap {
  villagerId: VillagerId;
  day: number;
  start: number;
  original: LocationId;
  swapped: LocationId;
}

/** Weather and the rain plan swap (spec §7.13): outdoor blocks move indoors until the rain stops. */
export class WeatherController {
  weather: Weather;
  private swaps: Swap[] = [];
  private lastHour: number;

  constructor(
    private readonly ctx: Ctx,
    private readonly log: WorldEventLog,
    restored?: Weather,
  ) {
    const now = ctx.host.now();
    this.weather = restored ? { ...restored } : { state: 'clear', since: now, until: null };
    this.lastHour = Math.floor(now / 60);
  }

  get raining(): boolean {
    return this.weather.state === 'rain';
  }

  startRain(durationMinutes?: number): void {
    const now = this.ctx.host.now();
    const rnd = this.ctx.host.random();
    const duration =
      durationMinutes ?? Math.round(RAIN_MIN_MINUTES + rnd * (RAIN_MAX_MINUTES - RAIN_MIN_MINUTES));
    this.weather = { state: 'rain', since: now, until: now + duration };
    this.log.open('rain', now + duration, { until: now + duration });
    this.ctx.emit({ type: 'weather.updated', weather: { ...this.weather } });
    this.ctx.toast('🌧', 'It started raining');
    this.ctx.log('It started raining');
    for (const v of this.ctx.awake()) {
      this.ctx.host.addMemory(v.id, { at: now, kind: 'event', text: 'It started raining', importance: 3 });
    }
    this.applySwaps();
  }

  stopRain(): void {
    if (!this.raining) return;
    const now = this.ctx.host.now();
    this.weather = { state: 'clear', since: now, until: null };
    this.restoreSwaps();
    for (const ev of this.log.active()) if (ev.kind === 'rain') this.log.close(ev);
    this.ctx.emit({ type: 'weather.updated', weather: { ...this.weather } });
    this.ctx.log('The rain stopped');
  }

  update(): void {
    const now = this.ctx.host.now();
    if (this.raining) {
      if (this.weather.until !== null && now >= this.weather.until) this.stopRain();
      else this.applySwaps();
    }
    const hour = Math.floor(now / 60);
    // Large steps (high speed, tests) can cross several hours; roll once per hour crossed.
    for (let h = this.lastHour + 1; h <= hour; h++) {
      const hod = h % 24;
      if (this.ctx.cfg.world.randomWeather && !this.raining && hod >= 7 && hod < 19) {
        if (this.ctx.host.random() < RANDOM_RAIN_CHANCE) this.startRain();
      }
    }
    this.lastHour = Math.max(this.lastHour, hour);
  }

  /** Idempotent: also catches plans written or revised while it rains. */
  private applySwaps(): void {
    const now = this.ctx.host.now();
    const day = dayOf(now);
    const mod = minuteOfDay(now);
    for (const v of this.ctx.host.villagers()) {
      if (!v.plan || v.plan.day !== day) continue;
      let next: DayPlan | null = null;
      v.plan.blocks.forEach((block, i) => {
        if (block.done || block.end <= mod || block.eventId || block.taskId) return;
        if (this.swaps.some((s) => s.villagerId === v.id && s.day === day && s.start === block.start)) return;
        const target = this.indoorFor(v, block);
        if (!target) return;
        this.swaps.push({
          villagerId: v.id,
          day,
          start: block.start,
          original: block.locationId,
          swapped: target,
        });
        next ??= structuredClone(v.plan!);
        next.blocks[i]!.locationId = target;
      });
      if (next) this.ctx.host.setPlan(v.id, next);
    }
  }

  private restoreSwaps(): void {
    const mod = minuteOfDay(this.ctx.host.now());
    const byVillager = new Map<VillagerId, Swap[]>();
    for (const s of this.swaps) byVillager.set(s.villagerId, [...(byVillager.get(s.villagerId) ?? []), s]);
    for (const [id, swaps] of byVillager) {
      const v = this.ctx.villager(id);
      if (!v?.plan) continue;
      const next = structuredClone(v.plan);
      let changed = false;
      for (const s of swaps) {
        if (next.day !== s.day) continue;
        const block = next.blocks.find((b) => b.start === s.start && b.locationId === s.swapped);
        if (block && !block.done && block.end > mod) {
          block.locationId = s.original;
          changed = true;
        }
      }
      if (changed) this.ctx.host.setPlan(id, next);
    }
    this.swaps = [];
  }

  /** Nearest shop or the villager's own home for an outdoor (public/nature) block, else null. */
  indoorFor(v: VillagerState, block: PlanBlock): LocationId | null {
    const loc = this.ctx.location(block.locationId);
    if (!loc || (loc.kind !== 'public' && loc.kind !== 'nature')) return null;
    const homeId = this.ctx.host.profile(v.id)?.homeId;
    const candidates = this.ctx.host.map.locations.filter((l) => l.kind === 'shop' || l.id === homeId);
    let best: { id: LocationId; d: number } | null = null;
    for (const c of candidates) {
      const d = distance(c.entry, loc.entry);
      if (!best || d < best.d) best = { id: c.id, d };
    }
    return best?.id ?? null;
  }
}
