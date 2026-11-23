/**
 * Romance (spec v2 §7): nightly crushes, asking on dates, date outcomes and gossip, couples and the
 * slow-burn shy pair. Everything is deterministic except the two LLM tasks (date.ask, date.decide),
 * which have fallbacks. State lives in `Romance` records written through `MindWorld.upsertRomance`;
 * the village keeps a copy so cognition works the same with or without engine storage.
 */
import { MINUTES_PER_DAY, dayOf, formatClock, minuteOfDay } from '../../shared/time.ts';
import type {
  Conversation,
  DateRecord,
  GameMinutes,
  Location,
  Provenance,
  Romance,
  VillageEvent,
  VillagerId,
} from '../../shared/types.ts';
import type { RomanceSnapshot, WorldView } from './types.ts';
import { asBool, asRecord, asString, parseClockLoose, pick } from './json.ts';
import { lines, memoryLines, systemFor } from './prompts/common.ts';
import { isOpenFor } from './sanitize.ts';
import type { Mind } from './mind.ts';

export const DATE_MINUTES = 90;
export const DATE_TTL = 120;
const CRUSH_AT = 2 * 60;
const CRUSH_CHANCE = 0.3;
/** The eligible night in a row on which the crush is certain. */
const CRUSH_SURE_NIGHT = 3;
const CRUSH_TALKS = 2;
const CRUSH_WINDOW = 3 * MINUTES_PER_DAY;
const DATE_DONE_AFFINITY = 2;
const DATE_MISSED_AFFINITY = -1;
const WITNESS_TILES = 8;
const END_AFTER = 3 * MINUTES_PER_DAY;
const SHY_DATE_AFFINITY = 8;
const SHY_DATE_TALKS = 6;
const POST_OFFICE = 'post_office';
const FALLBACK_DATE_AT = 17 * 60;
const FALLBACK_SOON_BEFORE = 15 * 60;
/** A transient villager whose mind has not been stepped for this long has left town. */
const DEPARTED_AFTER = 60;

export const DATE_VENUE_RE = /^(zoo_gate|burger_joint|park|forest_grove|forest_lake|ice_cream_truck_\w+)$/;

export function romanceId(a: VillagerId, b: VillagerId): string {
  const [x, y] = [a, b].sort();
  return `romance-${x}-${y}`;
}

export function isActive(r: Romance): boolean {
  return r.stage !== 'ended';
}

export function partnerOf(r: Romance, id: VillagerId): VillagerId {
  return r.pair[0] === id ? r.pair[1] : r.pair[0];
}

export function isDateVenue(l: Location): boolean {
  return l.kind === 'ride' || DATE_VENUE_RE.test(l.id);
}

/** Romance records of one village: the engine's copies (from views) win when they are newer. */
export class RomanceBook {
  private readonly byId = new Map<string, Romance>();
  private readonly askDay = new Map<string, number>();

  /** One date.ask per pair and day: after a chat both partners of a couple would otherwise ask at once. */
  claimAsk(pairKey: string, day: number): boolean {
    if ((this.askDay.get(pairKey) ?? -1) >= day) return false;
    this.askDay.set(pairKey, day);
    return true;
  }

  sync(records: readonly Romance[] | undefined): void {
    for (const r of records ?? []) {
      const mine = this.byId.get(r.id);
      if (!mine || r.updatedAt >= mine.updatedAt) this.byId.set(r.id, clone(r));
    }
  }

  get(id: string): Romance | undefined {
    return this.byId.get(id);
  }

  /** The pair's active record, else its latest one (record ids may come from the engine's seeds). */
  pair(a: VillagerId, b: VillagerId): Romance | undefined {
    let best: Romance | undefined;
    for (const r of this.byId.values()) {
      if (!r.pair.includes(a) || !r.pair.includes(b)) continue;
      if (
        !best ||
        (isActive(r) && !isActive(best)) ||
        (isActive(r) === isActive(best) && r.updatedAt > best.updatedAt)
      )
        best = r;
    }
    return best;
  }

  of(villager: VillagerId): Romance[] {
    return [...this.byId.values()].filter((r) => r.pair.includes(villager));
  }

  put(r: Romance): void {
    this.byId.set(r.id, clone(r));
  }
}

function clone(r: Romance): Romance {
  return {
    ...r,
    pair: [...r.pair] as [VillagerId, VillagerId],
    crushFrom: [...r.crushFrom],
    dates: r.dates.map((d) => ({ ...d })),
  };
}

export function dateAskPrompt(
  mind: Mind,
  partnerName: string,
  venues: readonly Location[],
  shy: boolean,
  now: GameMinutes,
  memories: Parameters<typeof memoryLines>[0],
): { system: string; user: string } {
  return {
    system: systemFor(
      mind.profile,
      'Romance in this village is light and wholesome: nothing physical beyond holding hands.',
    ),
    user: lines(
      `It is ${formatClock(now)}. You just chatted with ${partnerName} and would like to ask them on a date.`,
      shy && `You are very shy around ${partnerName}, so keep it short and a little awkward.`,
      `What you remember about ${partnerName}:\n${memoryLines(memories, false, 4)}`,
      `Places for a date (use these ids): ${venues.map((v) => `${v.id} (${v.name})`).join(', ')}`,
      `Pick a place and a start time (24h, later today or tomorrow) and say the invitation in 1-2 sentences.`,
      `Example: {"text":"Would you like to get ice cream with me tomorrow at five?","locationId":"${venues[0]?.id ?? 'park'}","start":"17:00"}`,
    ),
  };
}

export function dateDecidePrompt(
  mind: Mind,
  askerName: string,
  relation: string,
  text: string,
  place: string,
  start: GameMinutes,
): { system: string; user: string } {
  return {
    system: systemFor(
      mind.profile,
      'Romance in this village is light and wholesome: nothing physical beyond holding hands.',
    ),
    user: lines(
      `${askerName} asks you on a date: "${text}" (${place}, ${formatClock(start)}).`,
      relation,
      `Do you say yes? Answer in character in 1 sentence.`,
      `Example: {"accept":true,"reply":"I would love to!"}`,
    ),
  };
}

/** The romance side of one villager's mind. */
export class RomanceAgent {
  private crushNight = -1;
  /** Eligible nights in a row without a crush, as of `crushStreakNight` (a day number). */
  private crushStreak: number;
  private crushStreakNight: number;
  private askedDay = -1;
  private readonly settled = new Set<string>();
  private readonly witnessed = new Set<string>();
  private readonly shySeenDay = new Map<string, number>();
  private readonly belowSince = new Map<string, GameMinutes>();
  private readonly coupleNoted = new Set<string>();
  private lastNight = -1;

  constructor(private readonly mind: Mind) {
    const saved = mind.deps.snapshot?.romance;
    this.crushStreak = saved?.crushStreak ?? 0;
    this.crushStreakNight = saved?.crushStreakNight ?? -1;
    for (const m of mind.memory.all()) {
      if (m.meta.eventId && m.kind === 'event' && /date/.test(m.text)) this.settled.add(m.meta.eventId);
      if (m.text.startsWith('I think I have a crush on'))
        this.crushNight = Math.max(this.crushNight, dayOf(m.createdAt));
      if (/are a couple now/.test(m.text)) this.coupleNoted.add(m.text);
    }
  }

  private get cfg() {
    return this.mind.deps.config.romance;
  }

  private get book(): RomanceBook {
    return this.mind.town.romances;
  }

  get enabled(): boolean {
    return this.cfg?.enabled !== false;
  }

  /** My records, freshest first; seeded from the view (engine) when it has them. */
  records(view: WorldView | null = this.mind.lastView): Romance[] {
    this.book.sync(view?.romances ?? this.mind.world.romances?.());
    return this.book.of(this.mind.id);
  }

  active(view: WorldView | null = this.mind.lastView): Romance | undefined {
    return this.records(view).find(isActive);
  }

  shyWith(other: VillagerId): Romance | undefined {
    const r = this.book.pair(this.mind.id, other);
    return r && r.shy && isActive(r) ? r : undefined;
  }

  private write(r: Romance): void {
    const rec = { ...r, updatedAt: this.mind.deps.now() };
    this.book.put(rec);
    this.mind.world.upsertRomance?.(rec);
  }

  private eligible(id: VillagerId): boolean {
    const p = id === this.mind.id ? this.mind.profile : this.mind.town.minds.get(id)?.profile;
    return !!p && p.age >= (this.cfg?.minAge ?? 18);
  }

  private affinityOf(from: VillagerId, to: VillagerId): number {
    const view = from === this.mind.id ? this.mind.lastView : this.mind.town.minds.get(from)?.lastView;
    return view?.self.relationships[to]?.affinity ?? 0;
  }

  /** Conversations with `other` that ended at or after `since` (from the memory stream, so saves keep them). */
  talks(other: VillagerId, since = -Infinity): number {
    const name = this.mind.nameOf(other);
    const ids = new Set<string>();
    for (const m of this.mind.memory.all())
      if (
        m.kind === 'conversation' &&
        m.createdAt >= since &&
        m.meta.conversationId &&
        m.text.startsWith(`Talked with ${name}:`)
      )
        ids.add(m.meta.conversationId);
    return ids.size;
  }

  // ---------- every step ----------

  update(view: WorldView): void {
    if (!this.enabled) return;
    const recs = this.records(view);
    this.dropDeparted(view, recs);
    this.noteCouples(view, recs);
    this.settleDates(view);
    this.witness(view);
    this.shyGossip(view);
  }

  /** While asleep: crushes at 02:00, then couples and endings once a night. */
  night(view: WorldView): void {
    if (!this.enabled) return;
    const recs = this.records(view);
    this.dropDeparted(view, recs);
    this.noteCouples(view, recs);
    this.settleDates(view);
    const mod = minuteOfDay(view.now);
    const day = dayOf(view.now);
    if (mod >= CRUSH_AT && mod < 12 * 60 && this.crushNight < day) {
      this.crushNight = day;
      this.maybeCrush(view);
    }
    if (this.lastNight !== day && mod >= CRUSH_AT && mod < 12 * 60) {
      this.lastNight = day;
      for (const r of this.records(view)) {
        this.maybeCouple(view, r);
        this.maybeEnd(view, r);
      }
    }
  }

  /**
   * The nightly draw: 0.3 toward the best candidate, certain on the 3rd eligible night in a row
   * (spec v2 §7 guarantee). An ineligible night, or a night without a draw, restarts the count.
   */
  private maybeCrush(view: WorldView): void {
    const day = dayOf(view.now);
    const best = this.crushCandidate(view);
    if (!best) {
      this.crushStreak = 0;
      this.crushStreakNight = day;
      return;
    }
    const streak = this.crushStreakNight === day - 1 ? this.crushStreak + 1 : 1;
    this.crushStreakNight = day;
    if (streak < CRUSH_SURE_NIGHT && this.mind.deps.random() >= CRUSH_CHANCE) {
      this.crushStreak = streak;
      return;
    }
    this.crushStreak = 0;
    this.crushOn(view, best.id);
  }

  /** Romance state that is not in the memory stream (saved with the mind). */
  serialize(): RomanceSnapshot {
    return { crushStreak: this.crushStreak, crushStreakNight: this.crushStreakNight };
  }

  private crushCandidate(view: WorldView): { id: VillagerId; a: number } | null {
    const me = this.mind.id;
    if (!this.eligible(me)) return null;
    const mine = this.records(view).filter(isActive);
    if (mine.some((r) => r.stage === 'couple' || r.crushFrom.includes(me))) return null;
    const since = view.now - CRUSH_WINDOW;
    let best: { id: VillagerId; a: number } | null = null;
    for (const [id, rel] of Object.entries(view.self.relationships)) {
      if (id === me || !this.present(id, view) || !this.eligible(id)) continue;
      if (rel.affinity < (this.cfg?.crushAffinity ?? 6)) continue;
      const theirs = this.book.of(id).filter(isActive);
      if (theirs.some((r) => r.stage === 'couple' && !r.pair.includes(me))) continue;
      if (this.talks(id, since) < CRUSH_TALKS) continue;
      if (!best || rel.affinity > best.a || (rel.affinity === best.a && id < best.id))
        best = { id, a: rel.affinity };
    }
    return best;
  }

  private crushOn(view: WorldView, other: VillagerId): void {
    const me = this.mind.id;
    const id = romanceId(me, other);
    const old = this.book.pair(me, other);
    const now = view.now;
    const rec: Romance =
      old && isActive(old)
        ? { ...old, crushFrom: [...new Set([...old.crushFrom, me])] }
        : {
            id,
            pair: [me, other].sort() as [VillagerId, VillagerId],
            stage: 'crush',
            since: now,
            crushFrom: [me],
            dates: [],
            updatedAt: now,
          };
    this.write(rec);
    this.mind.addMemory({
      kind: 'reflection',
      at: now,
      text: `I think I have a crush on ${this.mind.nameOf(other, view)}.`,
      importance: 7,
    });
  }

  private maybeCouple(view: WorldView, r: Romance): void {
    if (!isActive(r) || r.stage === 'couple' || r.pair[0] !== this.mind.id) return;
    const [a, b] = r.pair;
    const pa = this.mind.town.minds.get(a)?.profile;
    const pb = this.mind.town.minds.get(b)?.profile;
    if (!pa || !pb || pa.transient || pb.transient) return;
    const done = r.dates.filter((d) => d.status === 'done').length;
    const need = this.cfg?.coupleAffinity ?? 7;
    if (done < (this.cfg?.datesForCouple ?? 2)) return;
    if (this.affinityOf(a, b) < need || this.affinityOf(b, a) < need) return;
    this.write({ ...r, stage: 'couple', crushFrom: [a, b] });
    const now = view.now;
    this.mind.deps.emit({
      type: 'toast',
      icon: '💕',
      text: `💕 ${pa.name} and ${pb.name} are now a couple!`,
    });
    this.mind.deps.emit({
      type: 'world.event',
      event: {
        id: `couple-${r.id}-${now}`,
        kind: 'couple',
        startedAt: now,
        endsAt: null,
        data: { romanceId: r.id, pair: [a, b] },
      },
    });
  }

  /** Each partner writes its own couple memory when it sees the record become a couple. */
  private noteCouples(view: WorldView, recs: readonly Romance[]): void {
    for (const r of recs) {
      if (r.stage !== 'couple') continue;
      const other = this.mind.nameOf(partnerOf(r, this.mind.id), view);
      const text = `${other} and I are a couple now!`;
      if (this.coupleNoted.has(text)) continue;
      this.coupleNoted.add(text);
      this.mind.addMemory({ kind: 'event', at: view.now, text, importance: 8 });
    }
  }

  /**
   * A visitor who left town ends any romance with them; otherwise the resident's open crush would
   * block every later crush.
   */
  private dropDeparted(view: WorldView, recs: readonly Romance[]): void {
    for (const r of recs) {
      if (!isActive(r)) continue;
      const other = partnerOf(r, this.mind.id);
      if (!this.present(other, view)) this.write({ ...r, stage: 'ended' });
    }
  }

  private present(id: VillagerId, view: WorldView): boolean {
    const mind = this.mind.town.minds.get(id);
    if (!mind) return false;
    if (!mind.profile.transient) return true;
    return (
      id in view.villagerNames && (mind.lastView === null || view.now - mind.lastView.now <= DEPARTED_AFTER)
    );
  }

  private maybeEnd(view: WorldView, r: Romance): void {
    if (!isActive(r)) return;
    const other = partnerOf(r, this.mind.id);
    if (this.affinityOf(this.mind.id, other) >= 0) {
      this.belowSince.delete(r.id);
      return;
    }
    const since = this.belowSince.get(r.id) ?? view.now;
    this.belowSince.set(r.id, since);
    if (view.now - since >= END_AFTER) {
      this.write({ ...r, stage: 'ended' });
      this.belowSince.delete(r.id);
    }
  }

  // ---------- asking ----------

  /** After a conversation with `other` ended: ask them on a date when the rules allow it. */
  afterConversation(other: VillagerId, conv: Conversation): void {
    const view = this.mind.lastView;
    if (!this.enabled || !view || conv.messages.length === 0) return;
    const r = this.book.pair(this.mind.id, other);
    if (!r || !isActive(r)) return;
    if (r.stage !== 'couple' && !r.crushFrom.includes(this.mind.id)) return;
    const now = this.mind.deps.now();
    const day = dayOf(now);
    if (this.askedDay >= day || this.mind.load() === 'overloaded') return;
    if (this.hasDateSoon(view, now)) return;
    if (r.shy && !this.shyMayDate(other, now)) return;
    if (!this.book.claimAsk(romanceId(this.mind.id, other), day)) return;
    this.askedDay = day;
    this.mind.job(`date.ask:${other}`, () => this.ask(view, r, other));
  }

  /** Shy pairs: not before day `shyMinDays`, both affinities 8+, and 6 conversations. */
  shyMayDate(other: VillagerId, now: GameMinutes): boolean {
    if (dayOf(now) < (this.cfg?.shyMinDays ?? 5)) return false;
    if (
      this.affinityOf(this.mind.id, other) < SHY_DATE_AFFINITY ||
      this.affinityOf(other, this.mind.id) < SHY_DATE_AFFINITY
    )
      return false;
    return this.talks(other) >= SHY_DATE_TALKS;
  }

  private dateOverlaps(view: WorldView, from: GameMinutes, to: GameMinutes): boolean {
    return this.mind
      .allEvents(view)
      .some(
        (e) =>
          e.kind === 'date' &&
          e.status !== 'cancelled' &&
          e.status !== 'done' &&
          (e.hostId === this.mind.id || e.accepted.includes(this.mind.id)) &&
          e.start < to &&
          e.end > from,
      );
  }

  private hasDateSoon(view: WorldView, now: GameMinutes): boolean {
    return this.mind
      .allEvents(view)
      .some(
        (e) =>
          e.kind === 'date' &&
          (e.status === 'scheduled' || e.status === 'happening' || e.status === 'proposed') &&
          (e.hostId === this.mind.id || e.invitees.includes(this.mind.id)) &&
          e.end > now &&
          e.start < now + MINUTES_PER_DAY,
      );
  }

  private venues(view: WorldView, start: GameMinutes): Location[] {
    const zoo = this.mind.zooHours();
    const mod = minuteOfDay(start);
    return view.locations.filter((l) => isDateVenue(l) && isOpenFor(l, mod, mod + DATE_MINUTES, zoo));
  }

  /** Two game hours from now before 15:00, else the next 17:00. */
  static fallbackStart(now: GameMinutes): GameMinutes {
    if (minuteOfDay(now) < FALLBACK_SOON_BEFORE) return now + 120;
    const today = dayOf(now) * MINUTES_PER_DAY + FALLBACK_DATE_AT;
    return today > now ? today : today + MINUTES_PER_DAY;
  }

  private async ask(view: WorldView, r: Romance, other: VillagerId): Promise<void> {
    const now = this.mind.deps.now();
    const fbStart = RomanceAgent.fallbackStart(now);
    const venues = this.venues(view, fbStart);
    if (venues.length === 0) return;
    const rot = r.dates.length % venues.length;
    const ordered = [...venues.slice(rot), ...venues.slice(0, rot)];
    const partnerName = this.mind.nameOf(other, view);
    const memories = await this.mind.recall(partnerName, now, { k: 4 }).catch(() => []);
    const fallback = {
      text: `Would you like to go to the ${ordered[0]!.name} with me?`,
      locationId: ordered[0]!.id,
      start: fbStart,
    };
    const res = await this.mind.ask({
      task: 'date.ask',
      ...dateAskPrompt(this.mind, partnerName, ordered, !!r.shy, now, memories),
      meta: {
        villagerId: this.mind.id,
        profile: this.mind.profile,
        partnerId: other,
        partnerName,
        venues: ordered.map((v) => ({ id: v.id, name: v.name })),
        shy: !!r.shy,
        now,
      },
      parse: (raw) => {
        const o = asRecord(raw);
        const text = asString(pick(o, 'text', 'invitation', 'say', 'message'));
        const loc = asString(pick(o, 'locationId', 'location', 'place', 'venue'));
        const clock = parseClockLoose(pick(o, 'start', 'time', 'at', 'when'));
        if (!text) return null;
        return { text: text.slice(0, 200), locationId: loc ?? '', clock };
      },
      fallback: () => ({
        text: fallback.text,
        locationId: fallback.locationId,
        clock: undefined as number | undefined,
      }),
      shape: '{"text":"...","locationId":"park","start":"17:00"}',
      deadline: now + DATE_TTL,
      temperature: this.mind.settings.temperature,
      maxTokens: 120,
    });
    const v = res.value;
    let start = v.clock !== undefined ? nextAt(now, v.clock) : fbStart;
    let open = this.venues(view, start);
    if (open.length === 0) {
      start = fbStart;
      open = this.venues(view, start);
    }
    const venue = open.find((l) => l.id === v.locationId) ?? open[rot % Math.max(1, open.length)];
    if (!venue) return;
    const partner = this.mind.town.minds.get(other);
    if (!partner) return;
    const answer = await partner.romance.decide(this.mind.id, v.text, venue, start);
    this.record(view, r, other, venue, start, v.text, res.source, answer);
  }

  /** The invited partner's answer (date.decide; fallback: accept at affinity 4+). */
  async decide(
    asker: VillagerId,
    text: string,
    venue: Location,
    start: GameMinutes,
  ): Promise<{ accept: boolean; reply: string; source: Provenance }> {
    const view = this.mind.lastView;
    const affinity = this.affinityOf(this.mind.id, asker);
    const askerName = this.mind.nameOf(asker, view);
    const now = this.mind.deps.now();
    // Hard rules, no model call: one date at a time, and one partner.
    const taken = this.records(view).some(
      (r) => isActive(r) && r.stage !== 'crush' && !r.pair.includes(asker),
    );
    if (taken || (view && this.dateOverlaps(view, start, start + DATE_MINUTES))) {
      this.mind.addMemory({
        kind: 'event',
        at: now,
        text: `${askerName} asked me on a date at the ${venue.name}, but I already have plans.`,
        importance: 5,
      });
      return { accept: false, reply: 'Sorry, I already have plans.', source: 'fallback' };
    }
    const res = await this.mind.ask({
      task: 'date.decide',
      ...dateDecidePrompt(
        this.mind,
        askerName,
        this.mind.relationText(view, asker, askerName),
        text,
        venue.name,
        start,
      ),
      meta: {
        villagerId: this.mind.id,
        askerId: asker,
        askerName,
        affinity,
        locationId: venue.id,
        start: formatClock(start),
        text,
      },
      parse: (raw) => {
        const o = asRecord(raw);
        const accept = asBool(pick(o, 'accept', 'accepted', 'yes', 'answer'));
        if (accept === undefined) return null;
        return { accept, reply: (asString(pick(o, 'reply', 'say', 'text')) ?? '').slice(0, 200) };
      },
      fallback: () => ({
        accept: affinity >= 4,
        reply: affinity >= 4 ? 'I would love to!' : 'Maybe another time.',
      }),
      shape: '{"accept":true,"reply":"..."}',
      offline: this.mind.load() === 'overloaded',
      deadline: now + DATE_TTL,
      temperature: this.mind.settings.temperature,
      maxTokens: 80,
    });
    const reply = res.value.reply || (res.value.accept ? 'I would love to!' : 'Maybe another time.');
    const place = venue.name;
    this.mind.addMemory({
      kind: 'event',
      at: this.mind.deps.now(),
      text: res.value.accept
        ? `${askerName} asked me on a date at the ${place}, ${formatClock(start)}. I said yes!`
        : `${askerName} asked me on a date at the ${place}. I said no.`,
      importance: 6,
    });
    if (res.value.accept) this.mind.world.setThought(reply);
    return { accept: res.value.accept, reply, source: res.source };
  }

  private record(
    view: WorldView,
    r: Romance,
    other: VillagerId,
    venue: Location,
    start: GameMinutes,
    text: string,
    source: Provenance,
    answer: { accept: boolean; source: Provenance },
  ): void {
    const now = this.mind.deps.now();
    const latest = this.book.get(r.id) ?? r;
    const otherName = this.mind.nameOf(other, view);
    const eventId = `date-${this.mind.id}-${other}-${Math.round(now)}`;
    const rec: DateRecord = {
      eventId,
      locationId: venue.id,
      at: start,
      askedBy: this.mind.id,
      status: answer.accept ? 'planned' : 'declined',
      source,
    };
    this.write({
      ...latest,
      stage: answer.accept && latest.stage === 'crush' ? 'dating' : latest.stage,
      dates: [...latest.dates, rec],
    });
    if (!answer.accept) {
      this.mind.addMemory({
        kind: 'event',
        at: now,
        text: `I asked ${otherName} on a date, but they said no.`,
        importance: 5,
      });
      return;
    }
    const event: VillageEvent = {
      id: eventId,
      title: `Date at the ${venue.name}`,
      description: text,
      hostId: this.mind.id,
      locationId: venue.id,
      start,
      end: start + DATE_MINUTES,
      invitees: [other],
      accepted: [other],
      declined: [],
      attendees: [],
      status: 'scheduled',
      source,
      kind: 'date',
    };
    this.mind.world.upsertEvent(event);
    this.mind.addMemory({
      kind: 'event',
      at: now,
      text: `${otherName} said yes to a date with me at the ${venue.name}, ${formatClock(start)}!`,
      importance: 6,
      meta: { eventId },
    });
    this.mind.world.setThought(`A date with ${otherName}! 💗`);
  }

  // ---------- after and during dates ----------

  private settleDates(view: WorldView): void {
    const me = this.mind.id;
    for (const e of this.mind.allEvents(view)) {
      if (e.kind !== 'date' || this.settled.has(e.id)) continue;
      if (e.hostId !== me && !e.invitees.includes(me)) continue;
      const over = e.status === 'done' || (e.status !== 'cancelled' && view.now >= e.end + 30);
      if (e.status === 'cancelled') {
        this.settled.add(e.id);
        continue;
      }
      if (!over) continue;
      this.settled.add(e.id);
      const other = e.hostId === me ? e.invitees[0]! : e.hostId;
      const both = e.attendees.includes(me) && e.attendees.includes(other);
      const name = this.mind.nameOf(other, view);
      const place = this.mind.locName(view, e.locationId);
      if (both) {
        this.mind.world.adjustRelationship(
          other,
          DATE_DONE_AFFINITY,
          `We had a lovely date at the ${place}.`,
        );
        this.mind.addMemory({
          kind: 'event',
          at: view.now,
          text: `I had a lovely date with ${name} at the ${place}.`,
          importance: 7,
          meta: { eventId: e.id },
        });
      } else if (e.attendees.includes(me)) {
        this.mind.world.adjustRelationship(other, DATE_MISSED_AFFINITY, `${name} did not come to our date.`);
        this.mind.addMemory({
          kind: 'event',
          at: view.now,
          text: `I waited for ${name} at the ${place}, but they never came to our date.`,
          importance: 6,
          meta: { eventId: e.id },
        });
      }
      if (e.hostId === me) {
        const r = this.book.pair(me, other);
        if (r)
          this.write({
            ...r,
            dates: r.dates.map((d) => (d.eventId === e.id ? { ...d, status: both ? 'done' : 'missed' } : d)),
          });
      }
    }
  }

  /** Villagers within 8 tiles of a date in progress see it (gossip-worthy). */
  private witness(view: WorldView): void {
    const me = this.mind.id;
    for (const e of this.mind.allEvents(view)) {
      if (e.kind !== 'date' || this.witnessed.has(e.id) || e.hostId === me || e.invitees.includes(me))
        continue;
      if (view.now < e.start || view.now >= e.end || e.status === 'cancelled' || e.status === 'done')
        continue;
      const loc = view.locations.find((l) => l.id === e.locationId);
      if (!loc || tilesTo(loc, view.self.pos) > WITNESS_TILES) continue;
      const other = e.invitees[0];
      if (!other || !isNear(this.mind, e.hostId, loc) || !isNear(this.mind, other, loc)) continue;
      this.witnessed.add(e.id);
      this.mind.addMemory({
        kind: 'observation',
        at: view.now,
        text: `I saw ${this.mind.nameOf(e.hostId, view)} and ${this.mind.nameOf(other, view)} on a date at the ${loc.name}.`,
        importance: 6,
        meta: { eventId: e.id },
      });
    }
  }

  /** "Franzi was at the post office again, chatting shyly with Laude": once per observer per day. */
  private shyGossip(view: WorldView): void {
    const post = view.locations.find((l) => l.id === POST_OFFICE);
    if (!post || tilesTo(post, view.self.pos) > WITNESS_TILES) return;
    const day = dayOf(view.now);
    for (const r of this.allShy()) {
      if (r.pair.includes(this.mind.id) || this.shySeenDay.get(r.id) === day) continue;
      const [a, b] = r.pair.map((id) => this.mind.town.minds.get(id)?.lastView);
      if (!a || !b || !a.self.conversationId || a.self.conversationId !== b.self.conversationId) continue;
      if (a.self.locationId !== POST_OFFICE || b.self.locationId !== POST_OFFICE) continue;
      this.shySeenDay.set(r.id, day);
      const [visitor, clerk] = this.visitorFirst(r, view);
      this.mind.addMemory({
        kind: 'observation',
        at: view.now,
        text: `${this.mind.nameOf(visitor, view)} was at the post office again, chatting shyly with ${this.mind.nameOf(clerk, view)}.`,
        importance: 5,
      });
    }
  }

  private allShy(): Romance[] {
    const seen = new Map<string, Romance>();
    for (const id of this.mind.town.minds.keys())
      for (const r of this.book.of(id)) if (r.shy && isActive(r)) seen.set(r.id, r);
    return [...seen.values()];
  }

  /** The one who works at the post office is named second. */
  private visitorFirst(r: Romance, view: WorldView): [VillagerId, VillagerId] {
    const works = (id: VillagerId) =>
      view.locations.find((l) => l.id === POST_OFFICE)?.ownerIds?.includes(id) ||
      /postm|postal|post office/i.test(this.mind.town.minds.get(id)?.profile.occupation ?? '');
    return works(r.pair[0]) ? [r.pair[1], r.pair[0]] : [r.pair[0], r.pair[1]];
  }

  /** Plan prompt line for couples. */
  planLine(view: WorldView): string | null {
    const r = this.active(view);
    if (!r || r.stage !== 'couple') return null;
    return `You and ${this.mind.nameOf(partnerOf(r, this.mind.id), view)} are a couple; plan some time together.`;
  }
}

function nextAt(now: GameMinutes, mod: number): GameMinutes {
  let t = dayOf(now) * MINUTES_PER_DAY + mod;
  while (t < now + 60) t += MINUTES_PER_DAY;
  return t;
}

/** Tiles from a point to a location's area (0 inside). */
function tilesTo(l: Location, p: { x: number; y: number }): number {
  const dx = Math.max(l.area.x - p.x, 0, p.x - (l.area.x + l.area.w - 1));
  const dy = Math.max(l.area.y - p.y, 0, p.y - (l.area.y + l.area.h - 1));
  return Math.max(dx, dy);
}

function isNear(mind: Mind, id: VillagerId, loc: Location): boolean {
  const v = id === mind.id ? mind.lastView : mind.town.minds.get(id)?.lastView;
  if (!v) return false;
  return v.self.locationId === loc.id || tilesTo(loc, v.self.pos) <= 2;
}
