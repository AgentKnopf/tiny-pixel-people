import { at, dayOf, formatClock } from '../../shared/time.ts';
import {
  PLAYER_ID,
  type LocationId,
  type VillageEvent,
  type VillagerId,
  type WorldEvent,
  type WorldEventKind,
} from '../../shared/types.ts';
import type { Ctx } from './context.ts';
import type { Strangers } from './strangers.ts';
import type { CommandResult, WorldEventService } from './types.ts';
import type { WeatherController } from './weather.ts';
import type { WorldEventLog } from './world-event-log.ts';

export const PARTY_DELAY_MINUTES = 30;
export const PARTY_DURATION_MINUTES = 120;
export const BIRTHDAY_START = '17:00';
export const BIRTHDAY_DURATION_MINUTES = 120;
/** Affinity at which a villager counts as a friend for birthday invitations. */
export const FRIEND_AFFINITY = 2;
const MIN_BIRTHDAY_GUESTS = 3;

/** Toolbar world events (spec §7.13): rain, party, stranger, birthday, town event. */
export class WorldEvents implements WorldEventService {
  constructor(
    private readonly ctx: Ctx,
    private readonly log: WorldEventLog,
    private readonly weather: WeatherController,
    private readonly strangers: Strangers,
  ) {}

  active(): readonly WorldEvent[] {
    return this.log.active();
  }

  trigger(kind: WorldEventKind, opts: { villagerId?: VillagerId } = {}): CommandResult {
    switch (kind) {
      case 'rain':
        if (this.weather.raining) return { ok: false, reason: "It's already raining" };
        this.weather.startRain();
        return { ok: true };
      case 'party':
        return this.party();
      case 'stranger':
        return this.strangers.trigger();
      case 'birthday':
        return this.birthday(opts.villagerId);
      case 'townEvent':
        return this.townEvent();
      default:
        return { ok: false, reason: `Unknown world event "${String(kind)}"` };
    }
  }

  private party(): CommandResult {
    const running = this.log
      .active()
      .some((e) => e.kind === 'party' && this.villageEvent(e.data.villageEventId)?.status !== 'cancelled');
    if (running) return { ok: false, reason: 'A party is already planned' };
    const locationId = this.plazaId();
    if (!locationId) return { ok: false, reason: 'There is no plaza for a party' };
    const now = this.ctx.host.now();
    const start = Math.ceil(now) + PARTY_DELAY_MINUTES;
    const invitees = this.ctx.awake().map((v) => v.id);
    const name = this.playerName();
    const event = this.makeEvent({
      title: 'Party at the plaza',
      description: `${name} is throwing a party at the plaza with music and snacks. Everyone is welcome!`,
      hostId: PLAYER_ID,
      locationId,
      start,
      end: start + PARTY_DURATION_MINUTES,
      invitees,
    });
    this.ctx.host.addVillageEvent(event);
    this.log.open('party', event.end, { villageEventId: event.id, locationId });
    this.ctx.toast('🎉', `Party at the plaza in ${PARTY_DELAY_MINUTES} minutes!`);
    this.ctx.log(`${name} announced a party at the plaza`);
    return { ok: true };
  }

  private birthday(requested?: VillagerId): CommandResult {
    const candidates = this.ctx.host.villagers().filter((v) => !this.ctx.host.profile(v.id)?.transient);
    let target = requested ? candidates.find((v) => v.id === requested) : undefined;
    if (requested && !target) return { ok: false, reason: `Unknown villager "${requested}"` };
    if (!target) {
      const awake = candidates.filter((v) => v.status !== 'sleeping');
      const pool = awake.length > 0 ? awake : candidates;
      target = pool[Math.floor(this.ctx.host.random() * pool.length)];
    }
    if (!target) return { ok: false, reason: 'Nobody lives here yet' };
    const now = this.ctx.host.now();
    const day = dayOf(now);
    const already = this.log.events.some(
      (e) => e.kind === 'birthday' && e.data.villagerId === target.id && dayOf(e.startedAt) === day,
    );
    if (already) return { ok: false, reason: `It is already ${this.ctx.nameOf(target.id)}'s birthday today` };

    const name = this.ctx.nameOf(target.id);
    for (const v of this.ctx.host.villagers()) {
      this.ctx.host.addMemory(v.id, {
        at: now,
        kind: 'event',
        text:
          v.id === target.id ? `Today is my birthday! It's ${name}'s big day` : `Today is ${name}'s birthday`,
        importance: v.id === target.id ? 6 : 5,
      });
    }
    const guests = this.friendsOf(target.id);
    const locationId = this.birthdayLocation(target.id);
    const usual = at(day, BIRTHDAY_START);
    const start = now + PARTY_DELAY_MINUTES <= usual ? usual : Math.ceil(now) + PARTY_DELAY_MINUTES;
    const event = this.makeEvent({
      title: `${name}'s birthday`,
      description: `A small birthday party for ${name} with cake and friends.`,
      hostId: target.id,
      locationId,
      start,
      end: start + BIRTHDAY_DURATION_MINUTES,
      invitees: guests,
    });
    this.ctx.host.addVillageEvent(event);
    this.log.open('birthday', event.end, { villagerId: target.id, villageEventId: event.id });
    this.ctx.toast('🎂', `Today is ${name}'s birthday!`);
    this.ctx.log(
      `It's ${name}'s birthday; party at ${this.ctx.location(locationId)?.name ?? locationId} at ${formatClock(start)}`,
    );
    return { ok: true };
  }

  private townEvent(): CommandResult {
    const res = this.ctx.host.proposeTownEvent();
    if (res.ok) {
      this.log.open('townEvent', null, {});
      this.ctx.toast('🗓', 'Someone is planning a town event…');
    }
    return res;
  }

  /** Friends (affinity >= FRIEND_AFFINITY), topped up with the closest others so a party can happen. */
  private friendsOf(id: VillagerId): VillagerId[] {
    const v = this.ctx.villager(id);
    const others = this.ctx.host
      .villagers()
      .filter((o) => o.id !== id)
      .map((o) => ({ id: o.id, affinity: v?.relationships[o.id]?.affinity ?? 0 }))
      .sort((a, b) => b.affinity - a.affinity || a.id.localeCompare(b.id));
    const friends = others.filter((o) => o.affinity >= FRIEND_AFFINITY);
    const picked = friends.length >= MIN_BIRTHDAY_GUESTS ? friends : others.slice(0, MIN_BIRTHDAY_GUESTS);
    return picked.map((o) => o.id);
  }

  private birthdayLocation(id: VillagerId): LocationId {
    const locs = this.ctx.host.map.locations;
    const cafe = locs.find((l) => /cafe|bakery/i.test(l.id));
    return cafe?.id ?? this.ctx.host.profile(id)?.homeId ?? this.plazaId() ?? locs[0]?.id ?? 'square';
  }

  private plazaId(): LocationId | undefined {
    const locs = this.ctx.host.map.locations;
    return (
      locs.find((l) => l.id === 'square' || l.id === 'plaza')?.id ?? locs.find((l) => l.kind === 'public')?.id
    );
  }

  private villageEvent(id: unknown): VillageEvent | undefined {
    return this.ctx.host.villageEvents().find((e) => e.id === id);
  }

  private makeEvent(
    e: Pick<VillageEvent, 'title' | 'description' | 'hostId' | 'locationId' | 'start' | 'end' | 'invitees'>,
  ): VillageEvent {
    return {
      id: this.ctx.id('event'),
      ...e,
      accepted: [],
      declined: [],
      attendees: [],
      status: 'scheduled',
    };
  }

  private playerName(): string {
    return this.ctx.cfg.player.name;
  }
}
