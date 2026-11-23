import { dayOf } from '../../shared/time.ts';
import {
  PLAYER_HOME_ID,
  PLAYER_ID,
  type GameMinutes,
  type HouseVisit,
  type HouseVisitKind,
  type InteriorTemplate,
  type Location,
  type LocationId,
  type PlayerState,
  type Point,
  type Provenance,
  type VillagerId,
} from '../../shared/types.ts';
import type { Ctx } from './context.ts';
import { distance, tileOf } from './geometry.ts';
import { HOTEL_ID } from './hotel.ts';
import type { CommandResult, HouseVisitService } from './types.ts';

export const POST_OFFICE_ID = 'post_office';
/** Public interiors: entering them causes no reaction. */
export const PUBLIC_INTERIORS: readonly LocationId[] = [HOTEL_ID, POST_OFFICE_ID];
/** The player must stand on or next to the door to enter (tiles). */
export const ENTER_DISTANCE = 1.5;
export const WITNESS_DISTANCE = 6;
/** The greeting falls back to the template after this long (game minutes). */
export const GREETING_TIMEOUT = 60;
export const GREETING_TEMPLATE = 'Oh, hello! Come on in, make yourself at home.';
export const INTERIOR_TILES_PER_MINUTE = 2;
/** Keep the visit log bounded; only recent visits matter for the once-a-day rules. */
const MAX_VISITS = 200;

export interface HouseVisitEvents {
  /** The player went inside or came out. */
  playerChanged(): void;
  /** The greeter's line, shown as a bubble to the player. */
  greeted(visit: HouseVisit, villagerId: VillagerId, text: string): void;
}

/**
 * Player entry into interiors and the owners' reactions (spec v2 §6). Owners and witnesses get
 * their memories and affinity changes here; cognition only writes the greeting text
 * (`host.requestGreeting` → `VillagerMind.greetVisitor`).
 */
export class HouseVisits implements HouseVisitService {
  private list: HouseVisit[];
  private interiorPath: Point[] = [];
  private pendingGreeting: { visitId: string; deadline: GameMinutes; greeter: VillagerId } | null = null;
  /** Owners who were asleep at home during a 'sleeping' visit (not saved; after a restore: owners at home). */
  private readonly sleepers = new Map<string, VillagerId[]>();

  constructor(
    private readonly ctx: Ctx,
    private readonly player: PlayerState,
    private readonly events: HouseVisitEvents,
    restored?: HouseVisit[],
  ) {
    this.list = structuredClone(restored ?? []);
  }

  visits(): readonly HouseVisit[] {
    return this.list;
  }

  get inside(): boolean {
    return !!this.player.inside;
  }

  enter(locationId: LocationId, now: GameMinutes): CommandResult {
    if (this.player.inside) return { ok: false, reason: 'You are already inside' };
    const loc = this.ctx.location(locationId);
    if (!loc) return { ok: false, reason: `Unknown place "${locationId}"` };
    const isPublic = PUBLIC_INTERIORS.includes(loc.id);
    if (loc.id === PLAYER_HOME_ID || (!isPublic && (loc.kind !== 'house' || !loc.interiorId)))
      return { ok: false, reason: `You can't go inside ${loc.name}` };
    const door = loc.door ?? loc.entry;
    const near =
      distance(door, this.player.pos) <= ENTER_DISTANCE ||
      distance(loc.entry, this.player.pos) <= ENTER_DISTANCE;
    if (!near) return { ok: false, reason: `Walk to the door of ${loc.name} first` };
    const template = this.template(loc);
    this.player.path = [];
    this.interiorPath = [];
    this.player.inside = { locationId: loc.id, pos: { ...(template?.entry ?? { x: 0, y: 0 }) } };
    this.events.playerChanged();
    if (!isPublic) this.react(loc, now);
    return { ok: true };
  }

  exit(now: GameMinutes): CommandResult {
    const inside = this.player.inside;
    if (!inside) return { ok: false, reason: 'You are not inside' };
    const loc = this.ctx.location(inside.locationId);
    this.player.inside = null;
    this.interiorPath = [];
    if (loc) this.player.pos = { ...(loc.door ?? loc.entry) };
    this.player.path = [];
    if (this.pendingGreeting) this.fallbackGreeting(now);
    this.events.playerChanged();
    return { ok: true };
  }

  /** `player.move` while inside: path on the interior grid; the exit tile leaves. */
  moveInside(to: Point): CommandResult {
    const inside = this.player.inside;
    if (!inside) return { ok: false, reason: 'You are not inside' };
    const loc = this.ctx.location(inside.locationId);
    const t = loc && this.template(loc);
    if (!t) return { ok: false, reason: "You can't walk around in here" };
    if (!to || !Number.isFinite(to.x) || !Number.isFinite(to.y))
      return { ok: false, reason: 'Invalid target' };
    const path = interiorPath(t, tileOf(inside.pos), tileOf(to));
    if (!path) return { ok: false, reason: "You can't walk there" };
    this.interiorPath = path;
    return { ok: true };
  }

  /** Every sim step. Returns true when the player state changed. */
  update(dt: number, now: GameMinutes): boolean {
    let changed = false;
    if (this.player.inside && this.interiorPath.length > 0) {
      const steps = Math.max(1, Math.floor(INTERIOR_TILES_PER_MINUTE * dt));
      const next = this.interiorPath.splice(0, steps);
      this.player.inside.pos = { ...next[next.length - 1]! };
      changed = true;
      const loc = this.ctx.location(this.player.inside.locationId);
      const t = loc && this.template(loc);
      if (t && this.interiorPath.length === 0 && samePoint(this.player.inside.pos, t.exit)) {
        this.exit(now);
        return false;
      }
    }
    if (this.pendingGreeting && now >= this.pendingGreeting.deadline) this.fallbackGreeting(now);
    this.notice(now);
    return changed;
  }

  /** An owner arrived home or woke up: deliver pending snoop or sleeping visits. */
  onOwnerHome(villagerId: VillagerId, now: GameMinutes): HouseVisit[] {
    const out: HouseVisit[] = [];
    for (const visit of this.list) {
      if (visit.noticedAt !== null || !visit.ownerIds.includes(villagerId)) continue;
      if (visit.kind === 'visit') continue;
      if (this.tryNotice(visit, villagerId, now)) out.push(visit);
    }
    return out;
  }

  // ---------- internals ----------

  private react(loc: Location, now: GameMinutes): void {
    const owners = this.ownersOf(loc);
    if (owners.length === 0) return;
    const home = owners.filter((id) => this.ctx.villager(id)?.locationId === loc.id);
    const awake = home.filter((id) => this.ctx.villager(id)?.status !== 'sleeping');
    const kind: HouseVisitKind = awake.length > 0 ? 'visit' : home.length > 0 ? 'sleeping' : 'snoop';
    const visit: HouseVisit = {
      id: this.ctx.id('visit'),
      houseId: loc.id,
      ownerIds: owners,
      at: now,
      kind,
      noticedAt: kind === 'visit' ? now : null,
      witnesses: [],
    };
    const name = this.player.name;
    if (kind === 'visit') {
      const first = !this.list.some(
        (v) => v.houseId === loc.id && v.kind === 'visit' && dayOf(v.at) === dayOf(now),
      );
      if (first) {
        for (const id of awake) {
          this.ctx.host.addMemory(id, {
            at: now,
            kind: 'event',
            text: `${name} came to visit me at home`,
            importance: 5,
          });
          this.ctx.host.adjustAffinity(id, PLAYER_ID, this.ctx.interiors.visitAffinity);
        }
        this.greet(visit, [...awake].sort()[0]!, now);
      }
    } else if (kind === 'snoop') {
      const ownerName = this.ctx.nameOf(owners[0]!);
      const originId = this.ctx.id('fact');
      for (const v of this.ctx.awake()) {
        if (owners.includes(v.id) || distance(v.pos, loc.door ?? loc.entry) > WITNESS_DISTANCE) continue;
        visit.witnesses.push(v.id);
        this.ctx.host.addMemory(v.id, {
          at: now,
          kind: 'observation',
          text: `I saw ${name} go into ${ownerName}'s house while they were out`,
          importance: 6,
          meta: { originId },
        });
      }
    }
    if (kind === 'sleeping') this.sleepers.set(visit.id, home);
    this.list.push(visit);
    if (this.list.length > MAX_VISITS) this.list.splice(0, this.list.length - MAX_VISITS);
    this.broadcast(visit);
  }

  private greet(visit: HouseVisit, greeter: VillagerId, now: GameMinutes): void {
    visit.greetedBy = greeter;
    const request = this.ctx.host.requestGreeting;
    if (!request) {
      this.applyGreeting(visit, GREETING_TEMPLATE, 'fallback');
      return;
    }
    this.pendingGreeting = { visitId: visit.id, deadline: now + GREETING_TIMEOUT, greeter };
    request
      .call(this.ctx.host, greeter, structuredClone(visit))
      .then(
        (res) => {
          const reply = typeof res?.reply === 'string' ? res.reply.trim().slice(0, 200) : '';
          return reply ? { reply, source: res.source } : null;
        },
        () => null,
      )
      .then((res) => {
        if (this.pendingGreeting?.visitId !== visit.id) return;
        if (!res) return this.fallbackGreeting(this.ctx.host.now());
        this.pendingGreeting = null;
        this.applyGreeting(visit, res.reply, res.source);
      });
  }

  private fallbackGreeting(_now: GameMinutes): void {
    const pending = this.pendingGreeting;
    this.pendingGreeting = null;
    const visit = pending && this.list.find((v) => v.id === pending.visitId);
    if (visit) this.applyGreeting(visit, GREETING_TEMPLATE, 'fallback');
  }

  private applyGreeting(visit: HouseVisit, text: string, source: Provenance): void {
    visit.greeting = text;
    visit.greetingSource = source;
    this.broadcast(visit);
    if (visit.greetedBy) this.events.greeted(visit, visit.greetedBy, text);
  }

  /** Watch owners of pending visits (works without engine calls to `onOwnerHome`). */
  private notice(now: GameMinutes): void {
    for (const visit of this.list) {
      if (visit.noticedAt !== null || visit.kind === 'visit') continue;
      for (const id of visit.ownerIds) {
        const v = this.ctx.villager(id);
        if (!v) continue;
        const sleepers = this.sleepers.get(visit.id);
        const ready =
          visit.kind === 'sleeping' && sleepers
            ? sleepers.includes(id) && v.status !== 'sleeping'
            : v.locationId === visit.houseId && v.status !== 'sleeping';
        if (ready && this.tryNotice(visit, id, now)) break;
      }
    }
  }

  private tryNotice(visit: HouseVisit, ownerId: VillagerId, now: GameMinutes): boolean {
    const v = this.ctx.villager(ownerId);
    if (!v || v.status === 'sleeping') return false;
    const sleepers = this.sleepers.get(visit.id);
    if (visit.kind === 'sleeping' && sleepers && !sleepers.includes(ownerId)) return false;
    if ((visit.kind === 'snoop' || !sleepers) && v.locationId !== visit.houseId) return false;
    visit.noticedAt = now;
    this.sleepers.delete(visit.id);
    const name = this.player.name;
    if (visit.kind === 'sleeping') {
      this.ctx.host.addMemory(ownerId, {
        at: now,
        kind: 'event',
        text: `${name} walked into my house while I was asleep`,
        importance: 6,
      });
      this.ctx.host.adjustAffinity(ownerId, PLAYER_ID, -1);
    } else {
      const already = this.list.some(
        (o) =>
          o !== visit &&
          o.houseId === visit.houseId &&
          o.kind === 'snoop' &&
          o.noticedAt != null &&
          dayOf(o.noticedAt) === dayOf(now),
      );
      if (!already) {
        this.ctx.host.addMemory(ownerId, {
          at: now,
          kind: 'event',
          text: `Someone was in my house while I was out. It was ${name}.`,
          importance: 7,
        });
        this.ctx.host.adjustAffinity(ownerId, PLAYER_ID, this.ctx.interiors.snoopAffinity);
      }
    }
    this.broadcast(visit);
    return true;
  }

  private ownersOf(loc: Location): VillagerId[] {
    const ids = new Set((loc.ownerIds ?? []).filter((id) => id !== PLAYER_ID));
    for (const v of this.ctx.host.villagers()) {
      const p = this.ctx.host.profile(v.id);
      if (p && !p.transient && p.homeId === loc.id) ids.add(v.id);
    }
    return [...ids].sort();
  }

  private template(loc: Location): InteriorTemplate | undefined {
    const id = loc.interiorId ?? (loc.id === HOTEL_ID ? 'hotel_lobby' : loc.id);
    return this.ctx.host.map.interiors?.find((t) => t.id === id);
  }

  private broadcast(visit: HouseVisit): void {
    this.ctx.emit({ type: 'visit.updated', visit: structuredClone(visit) });
  }
}

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

/** 4-direction BFS on an interior grid, excluding the start tile; null if unreachable. */
export function interiorPath(t: InteriorTemplate, from: Point, to: Point): Point[] | null {
  const inside = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < t.width && p.y < t.height;
  const free = (p: Point) => inside(p) && t.collision[p.y * t.width + p.x] !== 1;
  if (!free(to)) return null;
  if (samePoint(from, to)) return [];
  const key = (p: Point) => p.y * t.width + p.x;
  const prev = new Map<number, number>([[key(from), -1]]);
  const queue: Point[] = [from];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    for (const d of [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ]) {
      const n = { x: p.x + d.x, y: p.y + d.y };
      if (!free(n) || prev.has(key(n))) continue;
      prev.set(key(n), key(p));
      if (samePoint(n, to)) {
        const path: Point[] = [];
        let k = key(n);
        while (k !== key(from)) {
          path.unshift({ x: k % t.width, y: Math.floor(k / t.width) });
          k = prev.get(k)!;
        }
        return path;
      }
      queue.push(n);
    }
  }
  return null;
}
