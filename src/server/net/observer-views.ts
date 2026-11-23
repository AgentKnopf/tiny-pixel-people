import { dayOf, formatClock } from '../../shared/time.ts';
import {
  PLAYER_ID,
  type Conversation,
  type GameMinutes,
  type Memory,
  type MemoryKind,
  type Needs,
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

  private kindOf(id: VillagerId): 'villager' | 'visitor' {
    return this.src.profile(id)?.transient ? 'visitor' : 'villager';
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
    const p = world.player;
    const pLoc = locationAt(this.src.map.locations, p.pos);
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
      player: {
        id: PLAYER_ID,
        name: p.name,
        x: round2(p.pos.x),
        y: round2(p.pos.y),
        location: pLoc?.id ?? null,
        location_name: pLoc?.name ?? null,
        gold: p.gold,
      },
    };
  }

  /** null for unknown ids. */
  agent(id: VillagerId) {
    const profile = this.src.profile(id);
    const s = this.src.villager(id);
    if (!profile || !s) return null;
    const today = dayOf(this.src.now());
    const plan = s.plan && s.plan.day === today ? s.plan : null;
    const relationships = Object.entries(s.relationships)
      .map(([other, r]) => ({
        with: other,
        with_name: this.nameOf(other),
        kind: relationshipKind(r.affinity),
        score: r.affinity,
        note: r.summary ?? null,
        ...(r.lastTalkedAt !== undefined ? { last_talked: this.ts(r.lastTalkedAt) } : {}),
      }))
      .sort((a, b) => b.score - a.score);
    return {
      ...this.agentSummary(id, this.talkingTo()),
      age: profile.age,
      occupation: profile.occupation,
      bio: profile.bio,
      traits: [...profile.traits],
      home: profile.homeId,
      home_name: this.placeName(profile.homeId),
      relationships,
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
