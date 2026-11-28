import { dayOf, formatClock, minuteOfDay, parseClock } from '../../shared/time.ts';
import { NOTE_MAX_LENGTH, NOTICE_MAX_LENGTH, KEEP_PAGE_MAX } from '../../shared/protocol.ts';
import {
  PLAYER_ID,
  type GameMinutes,
  type KeepEntry,
  type KeepEntryKind,
  type Letter,
  type LetterId,
  type MemoryMeta,
  type Notice,
  type PlayerState,
  type Provenance,
  type VillageEvent,
  type VillagerId,
} from '../../shared/types.ts';
import { maxIdSuffix, type Ctx } from './context.ts';
import { distance, distanceToRect } from './geometry.ts';
import { POST_OFFICE_ID } from './house-visits.ts';
import type { CommandResult, KeepArchive, PostLogEvent, PostOfficeService } from './types.ts';

export const NOTICE_BOARD_ID = 'notice_board';
export const LAUDE_ID = 'laude';
/** `letter.send` works inside the post office or this close to its door (tiles). */
export const POST_BOX_DISTANCE = 2;
/** `notice.post` works this close to the notice board (tiles). */
export const NOTICE_BOARD_DISTANCE = 3;
export const KEEP_PAGE_DEFAULT = 20;
export const RETURNED_NOTE = 'moved away';
/** Laude's log memories (spec v2 §8.3): importance is set, never rated. */
const LOG_IMPORTANCE = 3;
const LOG_RUMOR_IMPORTANCE = 5;
const MAX_LETTERS = 500;

const STOPWORDS = new Set(
  'the and for are but not you all any can had her was one our out has have his how its may new now old see two way who did yes this that with from they them then than what when your about there their would could should into just like been were will'.split(
    ' ',
  ),
);

export function keywords(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    ),
  ];
}

/** Laude's cupboard of everything logged (spec v2 §8.4). Bounded by `post.keepMax`, oldest dropped. */
export class Keep implements KeepArchive {
  private entries: KeepEntry[];
  private seq: number;

  constructor(
    private readonly max: number,
    restored?: KeepEntry[],
  ) {
    const all = restored ?? [];
    this.entries = structuredClone(all).slice(-max);
    // Trimmed ids live on in Laude's memories (meta.keepId), so the count of kept entries is not enough.
    this.seq = Math.max(all.length, maxIdSuffix(all.map((e) => e.id)));
  }

  add(entry: Omit<KeepEntry, 'id'>): KeepEntry {
    const full: KeepEntry = { id: `keep_${Math.floor(entry.at)}_${++this.seq}`, ...entry };
    this.entries.push(full);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    return full;
  }

  list(opts: { query?: string; kind?: KeepEntryKind; offset?: number; limit?: number }): {
    entries: KeepEntry[];
    total: number;
  } {
    const words = keywords(opts.query ?? '');
    const matches = this.entries
      .filter((e) => !opts.kind || e.kind === opts.kind)
      .filter((e) => {
        if (words.length === 0) return true;
        const text = e.text.toLowerCase();
        return words.every((w) => text.includes(w));
      })
      .reverse();
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const limit = Math.min(KEEP_PAGE_MAX, Math.max(1, Math.floor(opts.limit ?? KEEP_PAGE_DEFAULT)));
    return { entries: matches.slice(offset, offset + limit), total: matches.length };
  }

  /** Entries sharing the most keywords with `query`; ties go to the newest. */
  search(query: string, k: number): KeepEntry[] {
    const words = keywords(query);
    if (words.length === 0 || k <= 0) return [];
    const scored: { e: KeepEntry; score: number; i: number }[] = [];
    this.entries.forEach((e, i) => {
      const text = keywords(e.text);
      const score = words.filter((w) => text.includes(w)).length;
      if (score > 0) scored.push({ e, score, i });
    });
    return scored
      .sort((a, b) => b.score - a.score || b.i - a.i)
      .slice(0, k)
      .map((s) => s.e);
  }

  size(): number {
    return this.entries.length;
  }

  all(): readonly KeepEntry[] {
    return this.entries;
  }
}

export interface PostOfficeEvents {
  /** The crow caws when letters are posted or delivered. */
  caw(): void;
}

export interface PostOfficeSave {
  letters: Letter[];
  notices: Notice[];
  keep: KeepEntry[];
}

/** Letters, the notice board and the Keep (spec v2 §8). Works without Laude in the world. */
export class PostOffice implements PostOfficeService {
  readonly keep: Keep;
  private letterList: Letter[];
  private noticeList: Notice[];
  private readonly noticedEvents = new Set<string>();
  private readonly doneRounds = new Set<string>();

  constructor(
    private readonly ctx: Ctx,
    private readonly player: PlayerState,
    private readonly events: PostOfficeEvents,
    restored: Partial<PostOfficeSave> = {},
  ) {
    this.keep = new Keep(ctx.post.keepMax, restored.keep);
    this.letterList = structuredClone(restored.letters ?? []);
    this.noticeList = structuredClone(restored.notices ?? []);
    for (const n of this.noticeList) if (n.eventId) this.noticedEvents.add(n.eventId);
    // Rounds that already ran before a save (or before start) must not run again today.
    const now = ctx.host.now();
    for (const t of ctx.post.deliveryTimes)
      if (minuteOfDay(now) >= parseClock(t)) this.doneRounds.add(`${dayOf(now)}:${t}`);
  }

  letters(): readonly Letter[] {
    return this.letterList;
  }

  notices(): readonly Notice[] {
    return this.noticeList;
  }

  // ---------- letters ----------

  sendLetter(
    from: VillagerId,
    to: VillagerId,
    text: string,
    now: GameMinutes,
    opts: { replyTo?: LetterId; source?: Provenance } = {},
  ): Letter | CommandResult {
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) return { ok: false, reason: 'Write something first' };
    if (body.length > NOTE_MAX_LENGTH)
      return { ok: false, reason: `Keep it under ${NOTE_MAX_LENGTH} characters` };
    if (from === to) return { ok: false, reason: "You can't write to yourself" };
    if (to !== PLAYER_ID && !this.ctx.villager(to))
      return { ok: false, reason: `Nobody called "${to}" lives here` };
    const original = opts.replyTo ? this.letterList.find((l) => l.id === opts.replyTo) : undefined;
    if (from !== PLAYER_ID && !original) {
      const cap = this.villagerCapReason(to, now);
      if (cap) return { ok: false, reason: cap };
    }
    const letter: Letter = {
      id: this.ctx.id('letter'),
      from,
      to,
      text: body,
      postedAt: now,
      status: 'posted',
      ...(original ? { replyTo: original.id } : {}),
      ...(opts.source ? { source: opts.source } : {}),
    };
    this.letterList.push(letter);
    this.trimLetters();
    this.broadcastLetter(letter);
    if (original && original.status !== 'returned') {
      original.status = 'replied';
      this.broadcastLetter(original);
    }
    this.log({ kind: 'letter', letter }, now);
    this.events.caw();
    if (from === PLAYER_ID) this.ctx.toast('✉️', `Your letter to ${this.ctx.nameOf(to)} is in the post`);
    return letter;
  }

  /** The player's `letter.send`: inside the post office or at the post box by its door. */
  playerSend(to: VillagerId, text: string, now: GameMinutes): CommandResult {
    if (!this.atPostOffice()) return { ok: false, reason: 'Letters are sent from the post office' };
    const res = this.sendLetter(PLAYER_ID, to, text, now);
    return 'id' in res ? { ok: true } : res;
  }

  deliver(now: GameMinutes): Letter[] {
    const out: Letter[] = [];
    for (const l of this.letterList) {
      if (l.status !== 'posted' || l.postedAt > now) continue;
      if (l.to !== PLAYER_ID && !this.ctx.villager(l.to)) {
        l.status = 'returned';
        l.deliveredAt = now;
        this.broadcastLetter(l);
        if (l.from === PLAYER_ID)
          this.ctx.toast('📮', `Your letter to ${this.ctx.nameOf(l.to)} came back: ${RETURNED_NOTE}`);
        out.push(l);
        continue;
      }
      l.status = 'delivered';
      l.deliveredAt = now;
      this.broadcastLetter(l);
      out.push(l);
      if (l.to === PLAYER_ID)
        this.ctx.toast('📬', `A letter from ${this.ctx.nameOf(l.from)} is in your mailbox`);
    }
    if (out.length > 0) {
      this.events.caw();
      this.ctx.log(`The post delivered ${out.length} letter${out.length === 1 ? '' : 's'}`);
    }
    return out;
  }

  markRead(letterId: LetterId, now: GameMinutes): Letter | null {
    const l = this.letterList.find((x) => x.id === letterId);
    if (!l || l.status !== 'delivered') return null;
    l.status = 'read';
    l.readAt = now;
    this.broadcastLetter(l);
    return l;
  }

  /** The player's `letter.read`. */
  playerRead(letterId: LetterId, now: GameMinutes): CommandResult {
    const l = this.letterList.find((x) => x.id === letterId);
    if (!l || l.to !== PLAYER_ID) return { ok: false, reason: 'No such letter in your mailbox' };
    if (l.status === 'posted') return { ok: false, reason: 'That letter has not arrived yet' };
    if (l.status === 'delivered') this.markRead(letterId, now);
    return { ok: true };
  }

  /**
   * Villagers read delivered letters on arrival home (the door-note flow): awake and at their home
   * (visitors live at the hotel, so it is their mailbox). Returns the letters read now; each gives a `note` memory (meta.letterId).
   */
  readAtHome(now: GameMinutes): Letter[] {
    const read: Letter[] = [];
    for (const l of this.letterList) {
      if (l.status !== 'delivered' || l.to === PLAYER_ID) continue;
      const v = this.ctx.villager(l.to);
      const home = this.ctx.host.profile(l.to)?.homeId;
      if (!v || v.status === 'sleeping' || !home || v.locationId !== home) continue;
      this.markRead(l.id, now);
      const fromPlayer = l.from === PLAYER_ID;
      this.ctx.host.addMemory(l.to, {
        at: now,
        kind: 'note',
        text: `I read a letter from ${this.ctx.nameOf(l.from)}: "${l.text}"`,
        importance: fromPlayer ? 6 : 5,
        meta: { letterId: l.id },
      });
      read.push(l);
    }
    return read;
  }

  /** Daily villager letter caps (spec v2 §8.1); replies do not count. */
  private villagerCapReason(to: VillagerId, now: GameMinutes): string | null {
    const day = dayOf(now);
    const today = this.letterList.filter(
      (l) => l.from !== PLAYER_ID && !l.replyTo && dayOf(l.postedAt) === day,
    );
    if (today.length >= this.ctx.post.maxVillagerLettersPerDay)
      return 'The town has written enough letters today';
    if (to === PLAYER_ID && today.some((l) => l.to === PLAYER_ID))
      return 'The player already got a letter today';
    return null;
  }

  private broadcastLetter(letter: Letter): void {
    this.ctx.emit({ type: 'letter.updated', letter: structuredClone(letter) });
  }

  private atPostOffice(): boolean {
    if (this.player.inside?.locationId === POST_OFFICE_ID) return true;
    if (this.player.inside) return false;
    const loc = this.ctx.location(POST_OFFICE_ID);
    if (!loc) return false;
    return distance(loc.door ?? loc.entry, this.player.pos) <= POST_BOX_DISTANCE;
  }

  private trimLetters(): void {
    if (this.letterList.length <= MAX_LETTERS) return;
    // Drop the oldest finished letters first; letters still on their way are kept.
    const done = new Set<LetterStatus>(['read', 'replied', 'returned']);
    const extra = this.letterList.length - MAX_LETTERS;
    let dropped = 0;
    this.letterList = this.letterList.filter((l) => {
      if (dropped < extra && done.has(l.status)) {
        dropped++;
        return false;
      }
      return true;
    });
  }

  // ---------- notices ----------

  postNotice(
    authorId: VillagerId,
    text: string,
    now: GameMinutes,
    opts: { eventId?: string; expiresAt?: GameMinutes } = {},
  ): Notice | CommandResult {
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) return { ok: false, reason: 'Write something first' };
    if (body.length > NOTICE_MAX_LENGTH)
      return { ok: false, reason: `Keep it under ${NOTICE_MAX_LENGTH} characters` };
    const ttl = now + this.ctx.post.noticeTtlDays * 1440;
    const notice: Notice = {
      id: this.ctx.id('notice'),
      authorId,
      text: body,
      postedAt: now,
      expiresAt: Math.min(ttl, opts.expiresAt ?? ttl),
      originId: this.ctx.id('fact'),
      ...(opts.eventId ? { eventId: opts.eventId } : {}),
    };
    this.noticeList.push(notice);
    while (this.noticeList.length > this.ctx.post.maxNotices) this.removeNotice(this.noticeList[0]!);
    this.ctx.emit({ type: 'notice.updated', notice: structuredClone(notice) });
    this.log({ kind: 'notice', notice }, now);
    return notice;
  }

  /** The player's `notice.post`, near the board. */
  playerNotice(text: string, now: GameMinutes): CommandResult {
    const board = this.ctx.location(NOTICE_BOARD_ID);
    if (!board || this.player.inside) return { ok: false, reason: 'Stand by the notice board to post' };
    const near =
      distanceToRect(board.area, this.player.pos) <= NOTICE_BOARD_DISTANCE ||
      distance(board.entry, this.player.pos) <= NOTICE_BOARD_DISTANCE;
    if (!near) return { ok: false, reason: 'Stand by the notice board to post' };
    const res = this.postNotice(PLAYER_ID, text, now);
    if (!('id' in res)) return res;
    this.ctx.toast('📌', 'Your notice is up on the board');
    return { ok: true };
  }

  expireNotices(now: GameMinutes): Notice[] {
    const events = new Map(this.ctx.host.villageEvents().map((e) => [e.id, e]));
    const gone = this.noticeList.filter((n) => {
      if (n.expiresAt <= now) return true;
      const ev = n.eventId ? events.get(n.eventId) : undefined;
      return ev !== undefined && (ev.status === 'done' || ev.status === 'cancelled' || ev.end <= now);
    });
    for (const n of gone) this.removeNotice(n);
    return gone;
  }

  /** Every scheduled non-date event gets a template notice from its host (no LLM). */
  private postEventNotices(now: GameMinutes): void {
    for (const ev of this.ctx.host.villageEvents()) {
      if (this.noticedEvents.has(ev.id)) continue;
      if (ev.kind === 'date' || ev.status !== 'scheduled' || ev.end <= now) continue;
      this.noticedEvents.add(ev.id);
      this.postNotice(
        ev.hostId,
        eventNoticeText(
          ev,
          this.ctx.location(ev.locationId)?.name ?? ev.locationId,
          this.hostName(ev.hostId),
        ),
        now,
        {
          eventId: ev.id,
          expiresAt: ev.end,
        },
      );
    }
  }

  private removeNotice(n: Notice): void {
    this.noticeList = this.noticeList.filter((x) => x !== n);
    this.ctx.emit({ type: 'notice.updated', notice: structuredClone(n), removed: true });
  }

  private hostName(id: VillagerId): string {
    return id === PLAYER_ID ? this.player.name : this.ctx.nameOf(id);
  }

  // ---------- engine loop ----------

  update(now: GameMinutes): void {
    if (!this.ctx.post.enabled) return;
    const day = dayOf(now);
    for (const t of this.ctx.post.deliveryTimes) {
      const key = `${day}:${t}`;
      if (this.doneRounds.has(key) || minuteOfDay(now) < parseClock(t)) continue;
      this.doneRounds.add(key);
      this.deliver(now);
    }
    if (this.doneRounds.size > 16) {
      for (const k of this.doneRounds) if (!k.startsWith(`${day}:`)) this.doneRounds.delete(k);
    }
    this.postEventNotices(now);
    this.expireNotices(now);
  }

  // ---------- the Keep and Laude's instant knowledge (spec v2 §8.3) ----------

  log(event: PostLogEvent, now: GameMinutes): KeepEntry {
    const entry = this.keep.add(keepEntryFor(event, now, (id) => this.hostName(id)));
    this.ctx.emit({ type: 'keep.added', entry: structuredClone(entry) });
    if (this.ctx.villager(LAUDE_ID)) {
      const rumor = event.kind === 'rumor';
      const meta: MemoryMeta = { keepId: entry.id };
      if (event.kind === 'rumor') meta.originId = event.rumor.originMemoryId;
      if (event.kind === 'notice' && event.notice.originId) meta.originId = event.notice.originId;
      if (event.kind === 'letter') meta.letterId = event.letter.id;
      if (event.kind === 'notice') meta.noticeId = event.notice.id;
      if (event.kind === 'note') meta.noteId = event.note.id;
      this.ctx.host.addMemory(LAUDE_ID, {
        at: now,
        kind: rumor ? 'heard' : 'note',
        text: `📒 ${entry.text}`,
        importance: rumor ? LOG_RUMOR_IMPORTANCE : LOG_IMPORTANCE,
        meta,
      });
    }
    return entry;
  }

  /** `keep.open`: only inside the post office. */
  open(opts: {
    query?: string;
    kind?: KeepEntryKind;
    offset?: number;
    limit?: number;
  }): { ok: true; entries: KeepEntry[]; total: number; offset: number } | { ok: false; reason: string } {
    if (this.player.inside?.locationId !== POST_OFFICE_ID)
      return { ok: false, reason: 'The Keep is in the post office' };
    const page = this.keep.list(opts);
    return { ok: true, ...page, offset: Math.max(0, Math.floor(opts.offset ?? 0)) };
  }

  serialize(): PostOfficeSave {
    return structuredClone({
      letters: this.letterList,
      notices: this.noticeList,
      keep: [...this.keep.all()],
    });
  }
}

type LetterStatus = Letter['status'];

export function eventNoticeText(ev: VillageEvent, place: string, host: string): string {
  return `📌 ${ev.title} at ${place}, ${formatClock(ev.start)}. All welcome! (${host})`;
}

function keepEntryFor(
  event: PostLogEvent,
  at: GameMinutes,
  name: (id: VillagerId) => string,
): Omit<KeepEntry, 'id'> {
  switch (event.kind) {
    case 'note': {
      const n = event.note;
      const replied = n.status === 'replied' && n.reply;
      return replied
        ? {
            kind: 'reply',
            at,
            refId: n.id,
            authorId: n.ownerId,
            recipientId: n.authorId,
            text: `${name(n.ownerId)} replied to ${name(n.authorId)}'s door note: ${n.reply}`,
          }
        : {
            kind: 'note',
            at,
            refId: n.id,
            authorId: n.authorId,
            recipientId: n.ownerId,
            text: `${n.status === 'read' ? `${name(n.ownerId)} read a door note from ${name(n.authorId)}` : `Door note from ${name(n.authorId)} to ${name(n.ownerId)}`}: ${n.text}`,
          };
    }
    case 'letter': {
      const l = event.letter;
      return {
        kind: l.replyTo ? 'reply' : 'letter',
        at,
        refId: l.id,
        authorId: l.from,
        recipientId: l.to,
        text: `${l.replyTo ? 'Reply' : 'Letter'} from ${name(l.from)} to ${name(l.to)}: ${l.text}`,
      };
    }
    case 'notice':
      return {
        kind: 'notice',
        at,
        refId: event.notice.id,
        authorId: event.notice.authorId,
        text: `Notice by ${name(event.notice.authorId)}: ${event.notice.text}`,
      };
    case 'rumor': {
      const r = event.rumor;
      const hop = event.hop;
      return hop
        ? {
            kind: 'rumor',
            at,
            refId: r.id,
            authorId: hop.from,
            recipientId: hop.to,
            text: `${name(hop.from)} told ${name(hop.to)} the rumor: ${r.text}`,
          }
        : {
            kind: 'rumor',
            at,
            refId: r.id,
            authorId: r.startedBy,
            text: `Rumor started by ${event.authorLabel ?? name(r.startedBy)}: ${r.text}`,
          };
    }
  }
}
