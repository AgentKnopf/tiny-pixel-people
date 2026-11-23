import type { GameMinutes } from '../../shared/types.ts';
import type { ObserverSaveData, TownLogEntry } from '../persistence/types.ts';

/** Event types the town log records (observer API `GET /api/events`, spec v2 §17). */
export const TOWN_EVENT_TYPES = [
  'move',
  'chat',
  'plan_change',
  'reflection',
  'note_left',
  'note_read',
  'gossip_spread',
  'event_start',
  // romance; `romance` is the catch-all for other romance changes
  'romance',
  'crush',
  'date_asked',
  'date',
  'date_missed',
  'couple',
  'romance_ended',
  // post
  'letter_sent',
  'letter_delivered',
  'letter_read',
  'letter_replied',
  'notice_posted',
  'keep_logged',
  // visitors and the train
  'train_arrived',
  'train_departed',
  'visitor_arrived',
  'visitor_checked_in',
  'visitor_left',
  // animals
  'animal_born',
  'animal_died',
  'animal_butchered',
  // interiors
  'house_visit',
  'snooping',
  // rides and food
  'ride',
  'purchase',
] as const;
export type TownEventType = (typeof TOWN_EVENT_TYPES)[number];

/** About a week of game minutes; older game times are extrapolated at speed 1. */
const MAX_ANCHORS = 10_000;
/** A real-time anchor per game minute keeps derived timestamps stable once that minute has passed. */
const ANCHOR_EVERY_GAME_MINUTES = 1;

export interface TownLogOptions {
  size: number;
  now: () => GameMinutes;
  /** Real ms per game minute at speed 1; used before the first anchor. */
  realMsPerGameMinute: number;
  clockMs?: () => number;
  restore?: ObserverSaveData | undefined;
}

/**
 * Bounded log of things that happened in town, plus the anchors that map game time to real time.
 * Game time only moves forward, so a piecewise-linear map through [epochMs, gameMinutes] anchors
 * gives every memory, note or conversation a real timestamp without storing one per record.
 */
export class TownLog {
  private entries: TownLogEntry[] = [];
  private anchors: [number, number][] = [];
  private seq = 0;
  private lastMs = 0;
  private readonly size: number;
  private readonly now: () => GameMinutes;
  private readonly rate: number;
  private readonly clockMs: () => number;

  constructor(opts: TownLogOptions) {
    this.size = opts.size;
    this.now = opts.now;
    this.rate = opts.realMsPerGameMinute;
    this.clockMs = opts.clockMs ?? Date.now;
    const r = opts.restore;
    if (r && Array.isArray(r.log) && Array.isArray(r.anchors)) {
      this.entries = r.log.slice(-this.size);
      this.anchors = r.anchors.slice(-MAX_ANCHORS);
      for (const e of this.entries) {
        this.seq = Math.max(this.seq, e.seq);
        this.lastMs = Math.max(this.lastMs, Date.parse(e.ts) || 0);
      }
    }
  }

  add(type: TownEventType, agents: string[], text: string, data?: Record<string, unknown>): TownLogEntry {
    // Strictly increasing timestamps, so `since=<ts>` never skips an entry recorded in the same ms.
    let ms = this.clockMs();
    if (ms <= this.lastMs) ms = this.lastMs + 1;
    this.lastMs = ms;
    const entry: TownLogEntry = {
      seq: ++this.seq,
      ts: new Date(ms).toISOString(),
      tick: this.now(),
      type,
      agents,
      text,
      ...(data ? { data } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > this.size) this.entries.splice(0, this.entries.length - this.size);
    return entry;
  }

  list(): readonly TownLogEntry[] {
    return this.entries;
  }

  /** Record "game time is now(), real time is now" (periodically, or always with `force`). */
  anchor(force = false): void {
    const game = this.now();
    const last = this.anchors.at(-1);
    if (last && game < last[1]) return;
    if (!force && last && game - last[1] < ANCHOR_EVERY_GAME_MINUTES) return;
    const ms = this.clockMs();
    if (last && last[0] === ms && last[1] === game) return;
    this.anchors.push([ms, game]);
    if (this.anchors.length > MAX_ANCHORS) this.anchors.splice(0, this.anchors.length - MAX_ANCHORS);
  }

  /** Real epoch ms at which game time `g` was (approximately) reached. */
  msOf(g: GameMinutes): number {
    const pts = this.anchors;
    const live: [number, number] = [this.clockMs(), this.now()];
    const last = pts.at(-1);
    const all = last && last[1] >= live[1] ? pts : [...pts, live];
    if (g >= live[1]) return live[0];
    // First anchor at or after g; equal game times resolve to the earliest real time.
    let lo = 0;
    let hi = all.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid]![1] >= g) hi = mid;
      else lo = mid + 1;
    }
    const b = all[lo]!;
    if (b[1] === g || lo === 0) return Math.round(b[0] - (b[1] - g) * this.rate);
    const a = all[lo - 1]!;
    return Math.round(a[0] + ((b[0] - a[0]) * (g - a[1])) / (b[1] - a[1]));
  }

  tsOf(g: GameMinutes): string {
    return new Date(this.msOf(g)).toISOString();
  }

  serialize(): ObserverSaveData {
    const anchors = this.anchors.map((a) => [a[0], a[1]] as [number, number]);
    const game = this.now();
    if (!anchors.at(-1) || anchors.at(-1)![1] < game) anchors.push([this.clockMs(), game]);
    return { log: this.entries.map((e) => ({ ...e })), anchors };
  }
}
