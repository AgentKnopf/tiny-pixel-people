import { dayOf, formatClock, MINUTES_PER_DAY } from '../../shared/time.ts';
import {
  PLAYER_ID,
  type Conversation,
  type GameMinutes,
  type KeepEntryKind,
  type Letter,
  type Memory,
  type MemoryKind,
  type Needs,
  type Romance,
  type AnimalGroup,
  type VillagerId,
  type VillagerState,
} from '../../shared/types.ts';
import { Mind } from '../cognition/mind.ts';
import type { Engine } from '../sim/engine.ts';
import { TOWN_EVENT_TYPES } from '../sim/town-log.ts';
import { locationAt, locationById } from '../sim/world.ts';

/** What the observer views read. `Engine` satisfies it; nothing here mutates the sim. */
export type ObserverSource = Pick<
  Engine,
  | 'map'
  | 'queue'
  | 'playerWorld'
  | 'townLog'
  | 'speed'
  | 'wakingUp'
  | 'now'
  | 'profile'
  | 'villager'
  | 'mind'
  | 'villagerIds'
  | 'notes'
  | 'events'
  | 'conversations'
  | 'memories'
  | 'romances'
  | 'animals'
  | 'train'
>;

export class BadRequest extends Error {}

/** `since`: a number is a game tick (minutes), anything else an ISO-8601 timestamp. */
export type Since = { tick: number } | { ms: number } | null;

export function parseSince(raw: string | null): Since {
  if (raw === null || raw.trim() === '') return null;
  const s = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return { tick: Number(s) };
  const ms = Date.parse(s);
  if (Number.isNaN(ms))
    throw new BadRequest(`"since" must be an ISO-8601 timestamp or a game tick, got "${raw}"`);
  return { ms };
}

export function parseLimit(raw: string | null, def: number, max: number): number {
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new BadRequest(`"limit" must be a positive integer, got "${raw}"`);
  return Math.min(n, max);
}

function newer(since: Since, tick: number, ms: number): boolean {
  if (!since) return true;
  return 'tick' in since ? tick > since.tick : ms > since.ms;
}

/** Without `since`: the newest `limit` items. With `since`: the first `limit` items after it (page forward). */
function window<T>(items: T[], since: Since, limit: number): T[] {
  return since ? items.slice(0, limit) : items.slice(-limit);
}

export interface Paged<T> {
  items: T[];
  /** Value to pass as `since` on the next poll (ISO timestamp of the newest item returned). */
  nextSince: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** `day` is 1-based, as the game shows it ("Day 1"). */
function clock(t: GameMinutes) {
  return { day: dayOf(t) + 1, time: formatClock(t) };
}

function roundNeeds(n: Needs): Needs {
  return {
    hunger: Math.round(n.hunger),
    energy: Math.round(n.energy),
    social: Math.round(n.social),
    fun: Math.round(n.fun),
  };
}

/** A one-word mood from status and needs (0–100, 100 = satisfied). */
export function moodOf(s: Pick<VillagerState, 'status' | 'needs'>): string {
  if (s.status === 'sleeping') return 'asleep';
  const n = s.needs;
  const low: [keyof Needs, string][] = [
    ['energy', 'tired'],
    ['hunger', 'hungry'],
    ['social', 'lonely'],
    ['fun', 'bored'],
  ];
  const worst = low.reduce((a, b) => (n[b[0]] < n[a[0]] ? b : a));
  if (n[worst[0]] < 25) return worst[1];
  const avg = (n.hunger + n.energy + n.social + n.fun) / 4;
  if (avg >= 75) return 'happy';
  if (avg >= 50) return 'content';
  return 'meh';
}

export function relationshipKind(affinity: number): string {
  if (affinity >= 6) return 'close_friend';
  if (affinity >= 2) return 'friend';
  if (affinity <= -5) return 'rival';
  if (affinity <= -2) return 'dislikes';
  return 'acquaintance';
}

const KEEP_KINDS: readonly KeepEntryKind[] = ['note', 'letter', 'notice', 'rumor', 'reply'];
const ANIMAL_GROUPS: readonly AnimalGroup[] = ['farm', 'zoo', 'ambient'];

const MEMORY_KINDS = ['observation', 'reflection', 'plan', 'chat', 'note'] as const;
type ObserverMemoryKind = (typeof MEMORY_KINDS)[number];
const KIND_MAP: Record<MemoryKind, ObserverMemoryKind> = {
  observation: 'observation',
  event: 'observation',
  conversation: 'chat',
  heard: 'chat',
  reflection: 'reflection',
  summary: 'reflection',
  plan: 'plan',
  note: 'note',
};

export class ObserverViews {
  constructor(
    private readonly src: ObserverSource,
    private readonly llm: { provider: string; model: string },
  ) {}

  private nameOf(id: VillagerId): string {
    if (id === PLAYER_ID) return this.src.playerWorld.state.name;
    return this.src.profile(id)?.name ?? id;
  }

  private placeName(id: string | null | undefined): string | null {
    return id ? (locationById(this.src.map.locations, id)?.name ?? id) : null;
  }

  private ts(t: GameMinutes): string {
    return this.src.townLog.tsOf(t);
  }

  private kindOf(id: VillagerId): 'villager' | 'visitor' | 'stranger' {
    const p = this.src.profile(id);
    if (p?.visitor) return 'visitor';
    return p?.transient ? 'stranger' : 'villager';
  }

  private talkingTo(): Map<VillagerId, VillagerId> {
    const out = new Map<VillagerId, VillagerId>();
    for (const c of this.src.conversations()) {
      if (c.status !== 'active') continue;
      out.set(c.participants[0], c.participants[1]);
      out.set(c.participants[1], c.participants[0]);
    }
    return out;
  }

  private agentSummary(id: VillagerId, talking: Map<VillagerId, VillagerId>) {
    const s = this.src.villager(id)!;
    const partner = s.conversationId ? talking.get(id) : undefined;
    return {
      id,
      name: this.nameOf(id),
      kind: this.kindOf(id),
      location: s.locationId,
      location_name: this.placeName(s.locationId),
      x: round2(s.pos.x),
      y: round2(s.pos.y),
      status: s.status,
      activity: s.activity.text,
      emoji: s.activity.emoji,
      current_thought: s.thought || null,
      mood: moodOf(s),
      needs: roundNeeds(s.needs),
      ...(partner ? { talking_to: partner, talking_to_name: this.nameOf(partner) } : {}),
    };
  }

  state() {
    const now = this.src.now();
    const world = this.src.playerWorld.snapshot();
    const talking = this.talkingTo();
    const happening = this.src.events().filter((e) => e.status === 'happening');
    const ev = happening[0];
    return {
      ts: new Date().toISOString(),
      tick: now,
      ...clock(now),
      paused: this.src.speed === 0,
      speed: this.src.speed,
      phase: this.src.wakingUp ? 'waking_up' : 'running',
      weather: world.weather.state,
      event_active: ev
        ? {
            id: ev.id,
            title: ev.title,
            host: ev.hostId,
            location: ev.locationId,
            location_name: this.placeName(ev.locationId),
            until: formatClock(ev.end),
            attendees: [...ev.attendees],
          }
        : null,
      agents: this.src.villagerIds().map((id) => this.agentSummary(id, talking)),
      ...this.v2State(),
      player: this.playerSummary(),
    };
  }

  private playerSummary() {
    const p = this.src.playerWorld.state;
    const pLoc = locationAt(this.src.map.locations, p.pos);
    return {
      id: PLAYER_ID,
      kind: 'player',
      name: p.name,
      x: round2(p.pos.x),
      y: round2(p.pos.y),
      location: pLoc?.id ?? null,
      location_name: pLoc?.name ?? null,
      gold: p.gold,
      inside: p.inside
        ? {
            location: p.inside.locationId,
            location_name: this.placeName(p.inside.locationId),
            x: round2(p.inside.pos.x),
            y: round2(p.inside.pos.y),
          }
        : null,
    };
  }

  /** null for unknown ids. */
  agent(id: VillagerId) {
    if (id === PLAYER_ID) return { ...this.playerSummary(), romance: null, relationships: [] };
    const profile = this.src.profile(id);
    const s = this.src.villager(id);
    if (!profile || !s) return null;
    const today = dayOf(this.src.now());
    const plan = s.plan && s.plan.day === today ? s.plan : null;
    const relationships = Object.entries(s.relationships)
      .map(([other, r]) => ({
        with: other,
        with_name: this.nameOf(other),
        kind: this.romanceKind(id, other) ?? relationshipKind(r.affinity),
        score: r.affinity,
        note: r.summary ?? null,
        ...(r.lastTalkedAt !== undefined ? { last_talked: this.ts(r.lastTalkedAt) } : {}),
      }))
      .sort((a, b) => b.score - a.score);
    // Romance partners without a relationship entry yet still show up.
    for (const r of this.src.romances()) {
      if (!r.pair.includes(id)) continue;
      const other = r.pair[0] === id ? r.pair[1] : r.pair[0];
      const kind = this.romanceKind(id, other);
      if (kind && !relationships.some((x) => x.with === other))
        relationships.push({ with: other, with_name: this.nameOf(other), kind, score: 0, note: null });
    }
    const romance = this.romanceFor(id);
    const visitor = profile.visitor
      ? this.src.playerWorld.snapshot().visitors.find((v) => v.villagerId === id)
      : undefined;
    return {
      ...this.agentSummary(id, this.talkingTo()),
      age: profile.age,
      occupation: profile.occupation,
      bio: profile.bio,
      traits: [...profile.traits],
      home: profile.homeId,
      home_name: this.placeName(profile.homeId),
      relationships,
      romance: romance
        ? {
            id: romance.id,
            stage: romance.stage,
            partner: romance.pair[0] === id ? romance.pair[1] : romance.pair[0],
            partner_name: this.nameOf(romance.pair[0] === id ? romance.pair[1] : romance.pair[0]),
            since: this.ts(romance.since),
            crush_from: [...romance.crushFrom],
            ...(romance.shy ? { shy: true } : {}),
            dates: romance.dates.map((d) => ({
              event: d.eventId,
              ts: this.ts(d.at),
              ...clock(d.at),
              location: d.locationId,
              location_name: this.placeName(d.locationId),
              asked_by: d.askedBy,
              status: d.status,
            })),
          }
        : null,
      ...(visitor
        ? {
            visitor: {
              status: visitor.status,
              origin: visitor.origin,
              ...(visitor.reason ? { reason: visitor.reason } : {}),
              room: visitor.roomId,
              arrived: this.ts(visitor.arrivedAt),
              departs: this.ts(visitor.departsAt),
            },
          }
        : {}),
      plan_summary: plan?.summary ?? null,
      plan_source: plan?.source ?? null,
      plan_today: (plan?.blocks ?? []).map((b) => ({
        time: formatClock(b.start),
        end: formatClock(b.end),
        text: b.activity,
        location: b.locationId,
        location_name: this.placeName(b.locationId),
        done: !!b.done,
      })),
    };
  }

  /** Newest first. null for unknown ids. */
  memories(id: VillagerId, q: URLSearchParams): Paged<unknown> | null {
    if (!this.src.profile(id)) return null;
    const since = parseSince(q.get('since'));
    const limit = parseLimit(q.get('limit'), 50, 500);
    const kinds = parseList(q.get('kind'), MEMORY_KINDS, 'kind');
    const mind = this.src.mind(id);
    // Mind.memory.all() is the live array: no copy, and unlike retrieval it does not touch lastAccessedAt.
    const all: readonly Memory[] = mind instanceof Mind ? mind.memory.all() : this.src.memories(id);
    const out = [];
    for (let i = all.length - 1; i >= 0 && (since || out.length < limit); i--) {
      const m = all[i]!;
      const kind = KIND_MAP[m.kind] ?? 'observation';
      if (kinds && !kinds.has(kind)) continue;
      const ms = this.src.townLog.msOf(m.createdAt);
      if (!newer(since, m.createdAt, ms)) continue;
      out.push({
        id: m.id,
        ts: new Date(ms).toISOString(),
        tick: m.createdAt,
        ...clock(m.createdAt),
        kind,
        raw_kind: m.kind,
        importance: m.importance,
        text: m.text,
        ...(m.meta.archived ? { archived: true } : {}),
      });
    }
    // Polling with `since` pages forward from the oldest new memory; the page is still newest first.
    const items = since ? out.slice(-limit) : out;
    return { items, nextSince: items[0]?.ts ?? null };
  }

  conversations(q: URLSearchParams): Paged<unknown> {
    const since = parseSince(q.get('since'));
    const limit = parseLimit(q.get('limit'), 20, 200);
    const agent = q.get('agent');
    const updatedAt = (c: Conversation) => c.endedAt ?? c.messages.at(-1)?.at ?? c.startedAt;
    const rows = this.src
      .conversations()
      .filter((c) => !agent || c.participants.includes(agent))
      .map((c) => ({ c, updated: updatedAt(c), ms: this.src.townLog.msOf(updatedAt(c)) }))
      .filter((r) => newer(since, r.updated, r.ms))
      .sort((a, b) => a.updated - b.updated);
    const items = window(rows, since, limit).map(({ c, updated, ms }) => ({
      id: c.id,
      ts: this.ts(c.startedAt),
      updated_ts: new Date(ms).toISOString(),
      tick: c.startedAt,
      updated_tick: updated,
      ...clock(c.startedAt),
      status: c.status,
      location: c.locationId,
      location_name: this.placeName(c.locationId),
      participants: [...c.participants],
      participant_names: c.participants.map((p) => this.nameOf(p)),
      lines: c.messages.map((m) => ({
        speaker: this.nameOf(m.speakerId),
        speaker_id: m.speakerId,
        text: m.text,
        ...clock(m.at),
        tick: m.at,
        ...(m.source ? { source: m.source } : {}),
      })),
    }));
    return { items, nextSince: items.at(-1)?.updated_ts ?? null };
  }

  notes(q: URLSearchParams): Paged<unknown> {
    const since = parseSince(q.get('since'));
    const limit = parseLimit(q.get('limit'), 100, 1000);
    const agent = q.get('agent');
    const rows = this.src
      .notes()
      .filter((n) => !agent || n.ownerId === agent || n.authorId === agent)
      .map((n) => ({ n, ms: this.src.townLog.msOf(n.postedAt) }))
      .filter((r) => newer(since, r.n.postedAt, r.ms))
      .sort((a, b) => a.n.postedAt - b.n.postedAt);
    const items = window(rows, since, limit).map(({ n, ms }) => ({
      id: n.id,
      ts: new Date(ms).toISOString(),
      tick: n.postedAt,
      ...clock(n.postedAt),
      from: n.authorId,
      from_name: this.nameOf(n.authorId),
      to: n.ownerId,
      to_name: this.nameOf(n.ownerId),
      house: n.houseId,
      text: n.text,
      read: n.status !== 'unread',
      status: n.status,
      ...(n.readAt !== undefined ? { read_ts: this.ts(n.readAt) } : {}),
      ...(n.reply !== undefined ? { reply: n.reply } : {}),
      ...(n.repliedAt !== undefined ? { reply_ts: this.ts(n.repliedAt) } : {}),
    }));
    return { items, nextSince: items.at(-1)?.ts ?? null };
  }

  events(q: URLSearchParams): Paged<unknown> {
    const since = parseSince(q.get('since'));
    const limit = parseLimit(q.get('limit'), 100, 1000);
    const types: Set<string> | null = parseList(q.get('type'), TOWN_EVENT_TYPES, 'type');
    const agent = q.get('agent');
    const rows = this.src.townLog
      .list()
      .filter((e) => (!types || types.has(e.type)) && (!agent || e.agents.includes(agent)))
      .filter((e) => newer(since, e.tick, Date.parse(e.ts)));
    const items = window(rows, since, limit).map((e) => ({
      seq: e.seq,
      ts: e.ts,
      tick: e.tick,
      ...clock(e.tick),
      type: e.type,
      agents: [...e.agents],
      text: e.text,
      ...(e.data ? { data: e.data } : {}),
    }));
    return { items, nextSince: items.at(-1)?.ts ?? null };
  }

  /** v2 parts of /api/state (spec v2 §17). */
  private v2State() {
    const pw = this.src.playerWorld.snapshot();
    const now = this.src.now();
    const t = this.src.train?.state(now) ?? null;
    const farm: Record<string, number> = {};
    for (const a of this.src.animals.all())
      if (a.group === 'farm') farm[a.species] = (farm[a.species] ?? 0) + 1;
    const hotel = pw.hotel;
    return {
      train: t
        ? {
            status: t.status,
            next_arrival: this.ts(t.arrivesAt),
            ...clock(t.arrivesAt),
            arrives_tick: t.arrivesAt,
            departs_tick: t.departsAt,
            departs_time: formatClock(t.departsAt),
            arriving: [...t.arriving],
            departing: [...t.departing],
          }
        : null,
      hotel: hotel
        ? {
            location: hotel.locationId,
            rooms: hotel.rooms.length,
            occupied: hotel.rooms.filter((r) => r.guestId).length,
            room_list: hotel.rooms.map((r) => ({
              id: r.id,
              guest: r.guestId,
              ...(r.since !== null ? { since: this.ts(r.since) } : {}),
            })),
          }
        : null,
      visitors: pw.visitors.map((v) => ({
        id: v.villagerId,
        name: this.nameOf(v.villagerId),
        status: v.status,
        room: v.roomId,
        origin: v.origin,
        arrived: this.ts(v.arrivedAt),
        departs: this.ts(v.departsAt),
        departs_tick: v.departsAt,
        ...clock(v.departsAt),
      })),
      farm,
      stock: structuredClone(pw.stock),
    };
  }

  private romanceFor(id: VillagerId): Romance | null {
    const rank: Record<string, number> = { couple: 0, dating: 1, crush: 2 };
    let best: Romance | null = null;
    for (const r of this.src.romances()) {
      if (!r.pair.includes(id) || r.stage === 'ended') continue;
      if (r.stage === 'crush' && !r.crushFrom.includes(id)) continue;
      if (!best || rank[r.stage]! < rank[best.stage]!) best = r;
    }
    return best;
  }

  /** Romance kind of id's relationship to other, or null when there is none from id's side. */
  private romanceKind(id: VillagerId, other: VillagerId): string | null {
    for (const r of this.src.romances()) {
      if (!r.pair.includes(id) || !r.pair.includes(other)) continue;
      if (r.stage === 'couple') return 'partner';
      if (r.stage === 'dating') return 'dating';
      if (r.stage === 'crush' && r.crushFrom.includes(id)) return r.shy ? 'shy_crush' : 'crush';
    }
    return null;
  }

  letters(q: URLSearchParams): Paged<unknown> {
    const since = parseSince(q.get('since'));
    const limit = parseLimit(q.get('limit'), 100, 1000);
    const agent = q.get('agent');
    const all = this.src.playerWorld.snapshot().letters;
    const replies = new Map<string, string>();
    for (const l of all) if (l.replyTo && !replies.has(l.replyTo)) replies.set(l.replyTo, l.text);
    const updated = (l: Letter) => Math.max(l.postedAt, l.deliveredAt ?? 0, l.readAt ?? 0);
    const rows = all
      .filter((l) => !agent || l.from === agent || l.to === agent)
      .map((l) => ({ l, ms: this.src.townLog.msOf(l.postedAt) }))
      .filter((r) => newer(since, r.l.postedAt, r.ms))
      .sort((a, b) => a.l.postedAt - b.l.postedAt);
    const items = window(rows, since, limit).map(({ l, ms }) => ({
      id: l.id,
      ts: new Date(ms).toISOString(),
      tick: l.postedAt,
      ...clock(l.postedAt),
      from: l.from,
      from_name: this.nameOf(l.from),
      to: l.to,
      to_name: this.nameOf(l.to),
      text: l.text,
      status: l.status,
      ...(l.deliveredAt !== undefined ? { delivered_ts: this.ts(l.deliveredAt) } : {}),
      ...(l.readAt !== undefined ? { read_ts: this.ts(l.readAt) } : {}),
      ...(l.replyTo ? { reply_to: l.replyTo } : {}),
      ...(replies.has(l.id) ? { reply: replies.get(l.id)! } : {}),
      updated_tick: updated(l),
      ...(l.source ? { source: l.source } : {}),
    }));
    return { items, nextSince: items.at(-1)?.ts ?? null };
  }

  /** Active notices, oldest first. */
  notices() {
    const now = this.src.now();
    return this.src.playerWorld
      .snapshot()
      .notices.filter((n) => n.expiresAt > now)
      .sort((a, b) => a.postedAt - b.postedAt)
      .map((n) => ({
        id: n.id,
        ts: this.ts(n.postedAt),
        tick: n.postedAt,
        ...clock(n.postedAt),
        author: n.authorId,
        author_name: this.nameOf(n.authorId),
        text: n.text,
        expires: this.ts(n.expiresAt),
        expires_tick: n.expiresAt,
        ...(n.eventId ? { event: n.eventId } : {}),
      }));
  }

  keep(q: URLSearchParams): Paged<unknown> {
    const since = parseSince(q.get('since'));
    const limit = parseLimit(q.get('limit'), 100, 1000);
    const kinds = parseList(q.get('kind'), KEEP_KINDS, 'kind');
    const needle = q.get('q')?.trim().toLowerCase() ?? '';
    const rows = this.src.playerWorld.post.keep
      .all()
      .filter((e) => (!kinds || kinds.has(e.kind)) && (!needle || e.text.toLowerCase().includes(needle)))
      .map((e) => ({ e, ms: this.src.townLog.msOf(e.at) }))
      .filter((r) => newer(since, r.e.at, r.ms));
    const items = window(rows, since, limit).map(({ e, ms }) => ({
      id: e.id,
      ts: new Date(ms).toISOString(),
      tick: e.at,
      ...clock(e.at),
      kind: e.kind,
      ref: e.refId,
      author: e.authorId,
      author_name: this.nameOf(e.authorId),
      ...(e.recipientId ? { recipient: e.recipientId, recipient_name: this.nameOf(e.recipientId) } : {}),
      text: e.text,
    }));
    return { items, nextSince: items.at(-1)?.ts ?? null };
  }

  animals(q: URLSearchParams) {
    const groups = parseList(q.get('group'), ANIMAL_GROUPS, 'group');
    const species = q.get('species')?.trim();
    const now = this.src.now();
    return this.src.animals
      .all()
      .filter((a) => (!groups || groups.has(a.group)) && (!species || a.species === species))
      .map((a) => ({
        id: a.id,
        species: a.species,
        group: a.group,
        ...(a.name ? { name: a.name } : {}),
        ...(a.stage ? { stage: a.stage } : {}),
        ...(a.sex ? { sex: a.sex } : {}),
        ...(a.bornAt !== undefined
          ? { ageDays: Math.max(0, Math.floor((now - a.bornAt) / MINUTES_PER_DAY)) }
          : {}),
        location: a.homeId,
        location_name: this.placeName(a.homeId),
        x: round2(a.pos.x),
        y: round2(a.pos.y),
        status: a.status,
      }));
  }
  stats() {
    const q = this.src.queue.stats();
    return {
      provider: this.llm.provider,
      model: this.llm.model,
      online: this.src.queue.isOnline() ?? true,
      calls: q.done + q.failed,
      failed: q.failed,
      avg_latency_ms: Math.round(q.avgLatencyMs),
      queue_len: q.queued,
      running: q.running,
      tokens: q.totalTokens,
      tokens_per_second: q.tokensPerSecond,
      last_reply_ms: q.lastReplyMs,
      by_task: q.byTask ?? {},
    };
  }
}

function parseList<T extends string>(raw: string | null, allowed: readonly T[], name: string): Set<T> | null {
  if (raw === null || raw.trim() === '') return null;
  const out = new Set<T>();
  for (const part of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!(allowed as readonly string[]).includes(part))
      throw new BadRequest(`unknown ${name} "${part}"; expected one of: ${allowed.join(', ')}`);
    out.add(part as T);
  }
  return out;
}
