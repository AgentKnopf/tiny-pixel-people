import { z } from 'zod';
import { dayOf, formatClock, parseClock } from '../../shared/time.ts';
import type {
  GameMinutes,
  Provenance,
  VillagerId,
  VillagerProfile,
  VisitorInfo,
} from '../../shared/types.ts';
import type { VisitorTemplate } from './catalog.ts';
import type { Ctx } from './context.ts';
import { inRect } from './geometry.ts';
import { HOTEL_ID, type Hotel } from './hotel.ts';
import { extractJsonObject } from './strangers.ts';
import type { VisitorService } from './types.ts';

export const STATION_ID = 'station';
/** Visitors check in on reaching the hotel, or after this long at the latest (game minutes). */
export const CHECK_IN_TIMEOUT = 120;
/** Visitors head for the station (status 'leaving', room freed) this long before departure; cognition cuts the plan. */
export const STATION_LEAD_MINUTES = 30;
/** One-day stays take the morning train when it is more than this long after arrival. */
const MORNING_TRAIN_MIN_GAP = 18 * 60;
/** Ready-made profiles kept for the next train. */
export const READY_TARGET = 2;
const VISITOR_CREATE_TTL = 240;
const BIO_MAX = 300;

const llmVisitorSchema = z.object({
  name: z.string().trim().min(1).max(24),
  age: z.number().int().min(18).max(100),
  occupation: z.string().trim().min(1).max(60),
  bio: z.string().trim().min(1).max(BIO_MAX),
  traits: z.array(z.string()).max(6).default([]),
  sprite: z.string().min(1),
  origin: z.string().trim().min(1).max(60),
  reason: z.string().trim().min(1).max(120),
  likes: z.array(z.string()).max(6).default([]),
});

interface Ready {
  template: Omit<VisitorTemplate, 'id'>;
  source: Provenance;
}

export interface VisitorEvents {
  updated(info: VisitorInfo): void;
}

/**
 * Train visitors (spec v2 §5.2). The engine spawns the profiles `onTrainArrived` returns on the
 * platform and removes the ids `onTrainDeparting` returns; this service decides who comes and goes,
 * pre-generates profiles via `visitor.create` and runs check-in and check-out. The leaving-day plan
 * cut (last block at `station`) is done by cognition's plan sanitizing.
 */
export class Visitors implements VisitorService {
  private infos: VisitorInfo[] = [];
  readonly profiles = new Map<VillagerId, VillagerProfile>();
  private readonly ready: Ready[] = [];
  private readonly missed = new Map<VillagerId, number>();
  private pending = 0;
  private cursor = 0;
  private started = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly hotel: Hotel,
    private readonly events: VisitorEvents,
    restored: { infos?: VisitorInfo[]; profiles?: VillagerProfile[] } = {},
  ) {
    this.infos = structuredClone(restored.infos ?? []);
    for (const p of restored.profiles ?? []) {
      if (p.visitor && this.infos.some((i) => i.villagerId === p.id))
        this.profiles.set(p.id, structuredClone(p));
    }
  }

  visitors(): readonly VisitorInfo[] {
    return this.infos;
  }

  info(villagerId: VillagerId): VisitorInfo | null {
    return this.infos.find((i) => i.villagerId === villagerId) ?? null;
  }

  /** Visitors who are staying (not on their way out). */
  inTown(): number {
    return this.infos.filter((i) => i.status !== 'leaving').length;
  }

  onTrainArrived(now: GameMinutes): VillagerProfile[] {
    const cfg = this.ctx.visitors;
    if (!cfg.enabled) return [];
    const staying = this.inTown();
    const awaitingRoom = this.infos.filter((i) => i.status === 'arriving').length;
    const cap = Math.min(
      cfg.max - staying,
      this.hotel.freeRooms() - awaitingRoom,
      this.ctx.maxVillagers - this.ctx.host.villagers().length,
    );
    const wanted = Math.max(0, cfg.min - staying) + (this.ctx.host.random() < 0.5 ? 1 : 0);
    const out: VillagerProfile[] = [];
    for (let i = 0; i < Math.min(wanted, cap); i++) {
      const next = this.nextProfile();
      if (!next) break;
      out.push(this.admit(next, now));
    }
    this.prepare(now);
    return out;
  }

  onTrainDeparting(now: GameMinutes, onPlatform: readonly VillagerId[]): VillagerId[] {
    const boarding: VillagerId[] = [];
    const platform = new Set(onPlatform);
    for (const info of [...this.infos]) {
      // A one-minute tolerance absorbs sim steps that straddle the departure time.
      if (info.departsAt > now + 1) continue;
      const misses = this.missed.get(info.villagerId) ?? 0;
      if (platform.has(info.villagerId) || misses >= 2) {
        boarding.push(info.villagerId);
        this.depart(info);
        continue;
      }
      this.missed.set(info.villagerId, misses + 1);
      info.departsAt = this.nextDeparture(now + 1);
      this.events.updated(info);
    }
    this.prepare(now);
    return boarding;
  }

  /** Every sim step: check-in, and 'leaving' (room freed) 30 minutes before departure. */
  update(now: GameMinutes): void {
    if (!this.started) {
      this.started = true;
      this.prepare(now);
    }
    const hotelLoc = this.ctx.location(HOTEL_ID);
    for (const info of this.infos) {
      const v = this.ctx.villager(info.villagerId);
      if (info.status === 'arriving') {
        const atHotel =
          v && (v.locationId === HOTEL_ID || (hotelLoc !== undefined && inRect(hotelLoc.area, v.pos)));
        if (atHotel || now - info.arrivedAt >= CHECK_IN_TIMEOUT) this.checkIn(info, now);
      }
      if (info.status !== 'leaving' && now >= info.departsAt - STATION_LEAD_MINUTES) {
        info.status = 'leaving';
        this.hotel.checkOut(info.villagerId);
        info.roomId = null;
        this.events.updated(info);
      }
    }
  }

  /** Next scheduled departure strictly after `after`. */
  nextDeparture(after: GameMinutes): GameMinutes {
    const dwell = this.ctx.train.dwellMinutes;
    const times = this.arrivalTimes();
    for (let day = dayOf(after); ; day++) {
      for (const t of times) {
        const dep = day * 1440 + t + dwell;
        if (dep > after) return dep;
      }
    }
  }

  /** Scheduled departure for a stay of `days` starting at `now` (spec v2 §5.2). */
  departureFor(now: GameMinutes, days: number): GameMinutes {
    const times = this.arrivalTimes();
    const lastDay = dayOf(now) + days;
    const morning = times[0]!;
    const evening = times[times.length - 1]!;
    const pick = days === 1 && lastDay * 1440 + morning - now > MORNING_TRAIN_MIN_GAP ? morning : evening;
    return lastDay * 1440 + pick + this.ctx.train.dwellMinutes;
  }

  private arrivalTimes(): number[] {
    return [...new Set(this.ctx.train.arrivals.map(parseClock))].sort((a, b) => a - b);
  }

  private admit(next: Ready, now: GameMinutes): VillagerProfile {
    const [minDays, maxDays] = this.ctx.visitors.stayDays;
    const days = minDays + Math.floor(this.ctx.host.random() * (maxDays - minDays + 1));
    const departsAt = this.departureFor(now, days);
    const t = next.template;
    const id = this.ctx.id('visitor');
    const profile: VillagerProfile = {
      id,
      name: t.name,
      age: t.age,
      occupation: t.occupation,
      bio: t.bio,
      traits: t.traits,
      homeId: HOTEL_ID,
      sprite: t.sprite,
      wakeTime: '07:00',
      sleepTime: '22:00',
      likes: t.likes,
      seedMemories: [
        `I am ${t.name}, a ${t.occupation} from ${t.origin}. I came to this village by train for ${t.reason}.`,
        `I am staying at the hotel for ${days} day${days === 1 ? '' : 's'} and leave on the ${formatClock(departsAt - this.ctx.train.dwellMinutes)} train on day ${dayOf(departsAt) + 1}.`,
      ],
      transient: true,
      visitor: true,
    };
    const info: VisitorInfo = {
      villagerId: id,
      arrivedAt: now,
      departsAt,
      roomId: null,
      origin: t.origin,
      reason: t.reason,
      status: 'arriving',
      source: next.source,
    };
    this.profiles.set(id, profile);
    this.infos.push(info);
    this.events.updated(info);
    this.ctx.log(`${t.name} (${t.occupation}) arrived by train from ${t.origin}`);
    return profile;
  }

  private checkIn(info: VisitorInfo, now: GameMinutes): void {
    const room = this.hotel.checkIn(info.villagerId, now);
    if (!room) return;
    info.roomId = room;
    info.status = 'checkedIn';
    this.events.updated(info);
  }

  private depart(info: VisitorInfo): void {
    this.hotel.checkOut(info.villagerId);
    this.infos = this.infos.filter((i) => i !== info);
    this.missed.delete(info.villagerId);
    const profile = this.profiles.get(info.villagerId);
    this.profiles.delete(info.villagerId);
    info.status = 'leaving';
    info.roomId = null;
    this.events.updated(info);
    if (profile) this.ctx.log(`${profile.name} left on the train`);
  }

  // ---------- profiles ----------

  private nextProfile(): Ready | null {
    while (this.ready.length > 0) {
      const r = this.ready.shift()!;
      if (!this.nameTaken(r.template.name)) return r;
    }
    const t = this.fallbackTemplate();
    return t ? { template: t, source: 'fallback' } : null;
  }

  private fallbackTemplate(): VisitorTemplate | null {
    const pool = this.ctx.catalogs.visitors;
    for (let i = 0; i < pool.length; i++) {
      const t = pool[(this.cursor + i) % pool.length]!;
      if (this.nameTaken(t.name) || this.ready.some((r) => sameName(r.template.name, t.name))) continue;
      this.cursor = (this.cursor + i + 1) % pool.length;
      return t;
    }
    return null;
  }

  private takenNames(): string[] {
    const names = this.ctx.host.villagers().map((v) => this.ctx.nameOf(v.id));
    for (const p of this.profiles.values()) names.push(p.name);
    return names;
  }

  private nameTaken(name: string): boolean {
    return this.takenNames().some((n) => sameName(n, name));
  }

  sprites(): string[] {
    return [...new Set(this.ctx.catalogs.visitors.map((t) => t.sprite))];
  }

  /** Keep READY_TARGET profiles ready for the next train (spec v2 §5.2, §11). */
  private prepare(now: GameMinutes): void {
    const llm = this.ctx.host.llm;
    if (!this.ctx.visitors.enabled || !this.ctx.cfg.world.llmVisitors || !llm) return;
    if ((this.ctx.host.loadLevel?.() ?? 'normal') === 'overloaded') return;
    const missing = READY_TARGET - this.ready.length - this.pending;
    for (let i = 0; i < missing; i++) {
      this.pending++;
      const existingNames = [...this.takenNames(), ...this.ready.map((r) => r.template.name)];
      const sprites = this.sprites();
      llm
        .enqueue(
          {
            task: 'visitor.create',
            json: true,
            messages: visitorPrompt(existingNames, sprites),
            meta: { existingNames, sprites, now },
          },
          { dedupeKey: `visitor.create:${now}:${i}`, expiresAt: now + VISITOR_CREATE_TTL },
        )
        .then(
          (res) => {
            this.pending--;
            const parsed = this.validate(res.text);
            if (parsed) this.ready.push({ template: parsed, source: 'llm' });
            else {
              const t = this.fallbackTemplate();
              if (t) this.ready.push({ template: t, source: 'fallback' });
            }
          },
          () => {
            this.pending--;
          },
        );
    }
  }

  private validate(text: string): Omit<VisitorTemplate, 'id'> | null {
    const parsed = llmVisitorSchema.safeParse(extractJsonObject(text));
    if (!parsed.success) return null;
    const v = parsed.data;
    if (!this.sprites().includes(v.sprite)) return null;
    if (this.nameTaken(v.name) || this.ready.some((r) => sameName(r.template.name, v.name))) return null;
    return v;
  }
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function visitorPrompt(existingNames: string[], sprites: string[]) {
  return [
    {
      role: 'system' as const,
      content:
        'You invent a visitor who arrives by train in a cozy pixel village and stays at the hotel for a few days. ' +
        'Reply with JSON only: {"name": string, "age": number, "occupation": string, "bio": "2 short sentences", ' +
        '"traits": [string], "sprite": string, "origin": "where they come from", "reason": "why they visit", "likes": [string]}.',
    },
    {
      role: 'user' as const,
      content:
        `Names already taken: ${existingNames.join(', ') || 'none'}. Pick a different, short first name. ` +
        `Choose "sprite" from: ${sprites.join(', ')}.`,
    },
  ];
}
