import type {
  ApplyInfluenceOptions,
  InfluenceBodies,
  InfluenceBudget,
  InfluenceEndpoint,
  InfluenceEntry,
  InfluenceId,
  InfluenceLogPage,
  InfluenceLogQuery,
  InfluenceOutcomes,
  InfluenceRefs,
  InfluenceRefusal,
  InfluenceRequest,
  InfluenceResult,
} from '../../shared/influence.ts';
import { INFLUENCE_LOG_PAGE_MAX } from '../../shared/influence.ts';
import { dayOf, formatClock, MINUTES_PER_DAY } from '../../shared/time.ts';
import type { GameMinutes, VillagerId } from '../../shared/types.ts';
import type { AppConfig } from '../config.ts';
import { createLogger } from '../log.ts';
import type { InfluenceSaveData } from '../persistence/types.ts';

const log = createLogger('influence');

const LOG_PAGE_DEFAULT = 100;

/**
 * Queued chat jobs at which the village counts as busy for influences: room for one influence
 * event's decisions (about 11) plus a few replies below the cap, where the queue starts dropping
 * the lowest-priority jobs. 75% keeps small caps sensible.
 */
export function queueBusyAt(maxQueued: number): number {
  return Math.max(Math.ceil(maxQueued * 0.75), maxQueued - 16);
}

export type InfluenceEntryOf<E extends InfluenceEndpoint> = Extract<InfluenceEntry, { endpoint: E }>;

/** Refusals an endpoint handler decides (422 / 409); 503 and 429 are the service's. */
export type HandlerRefusal = Extract<InfluenceRefusal, { status: 422 | 409 }>;

/** A checked influence, ready to apply. Nothing in the world has changed yet. */
export interface InfluencePlan<E extends InfluenceEndpoint> {
  targets: VillagerId[];
  /** The target is a visitor (rumour and nudge). */
  visitor?: boolean;
  /** Honest town log line ("It started raining for 2 hours"); " [influence]" is appended. */
  text: string;
  /** Starting outcomes; the entry is logged with them before `apply` runs. */
  outcomes: InfluenceOutcomes[E];
  /**
   * Change the world. Called at most once, only after the busy and budget checks passed. Every
   * check that can fail belongs in `check`; `apply` changes the world in one step at its end, so a
   * throw means nothing changed (the entry is then removed and the error rethrown). It may call
   * `updateOutcomes` for its own id, directly or through bus listeners it triggers.
   */
  apply(id: InfluenceId): { refs: InfluenceRefs };
}

/** One endpoint (I3-I7). */
export interface InfluenceHandler<E extends InfluenceEndpoint> {
  check(body: InfluenceBodies[E]): InfluencePlan<E> | HandlerRefusal;
  /** Called for each logged entry of this endpoint when the handler registers (after a restore). */
  resume?(entry: InfluenceEntryOf<E>): void;
}

export interface InfluenceServiceOptions {
  config: Pick<AppConfig['influence'], 'perGameDay' | 'logMax'>;
  now(): GameMinutes;
  /** Village overloaded: refuse with 503 instead of queueing more model work. */
  busy(): boolean;
  /** Adds the `influence` town log entry and returns its ts (the influence entry reuses it). */
  townLog(
    text: string,
    agents: VillagerId[],
    data: { influenceId: InfluenceId; endpoint: InfluenceEndpoint },
  ): string;
  /** Broadcast a `log` server message (replay.jsonl records it). */
  emit(text: string): void;
  restore?: InfluenceSaveData | undefined;
}

type AnyHandler = InfluenceHandler<InfluenceEndpoint>;

/**
 * Influence day budget, the bounded influence log and the endpoint registry (spec §3, §6, §7).
 * Order of decisions: handler checks (422 / 409), then overload (503), then budget (429).
 * Only accepted influences count and are logged.
 */
export class InfluenceService {
  private readonly handlers = new Map<InfluenceEndpoint, AnyHandler>();
  private entries: InfluenceEntry[] = [];
  private readonly byId = new Map<InfluenceId, InfluenceEntry>();
  private day = 0;
  private used = 0;
  private nextId = 1;
  private lastMs = 0;

  constructor(private readonly opts: InfluenceServiceOptions) {
    const r = opts.restore;
    if (!r) return;
    const entries = Array.isArray(r.entries) ? r.entries : [];
    this.day = Number.isInteger(r.day) ? r.day : 0;
    this.used = Number.isInteger(r.used) && r.used > 0 ? r.used : 0;
    let maxId = 0;
    for (const e of entries) {
      maxId = Math.max(maxId, Number(/^inf_(\d+)$/.exec(e.id)?.[1] ?? 0));
      this.lastMs = Math.max(this.lastMs, Date.parse(e.ts) || 0);
    }
    this.nextId = Math.max(Number.isInteger(r.nextId) ? r.nextId : 1, maxId + 1);
    this.entries = structuredClone(entries.slice(-opts.config.logMax));
    for (const e of this.entries) this.byId.set(e.id, e);
  }

  /**
   * Register an endpoint. `resume` runs here for every logged entry of it, so register in the
   * engine constructor only after the subsystems the handler re-attaches to (weather, rumours,
   * events, notes) have been restored.
   */
  register<E extends InfluenceEndpoint>(endpoint: E, handler: InfluenceHandler<E>): void {
    this.handlers.set(endpoint, handler as unknown as AnyHandler);
    if (!handler.resume) return;
    for (const e of this.entries) if (e.endpoint === endpoint) handler.resume(e as InfluenceEntryOf<E>);
  }

  apply(req: InfluenceRequest, opts: ApplyInfluenceOptions = {}): InfluenceResult {
    const handler = this.handlers.get(req.endpoint);
    if (!handler)
      return this.refuse(req.endpoint, {
        status: 422,
        error: 'invalid',
        message: `The ${req.endpoint} influence is not available yet.`,
      });
    const checked = handler.check(req.body);
    if ('status' in checked) return this.refuse(req.endpoint, checked);
    if (this.opts.busy()) return this.refuse(req.endpoint, { status: 503, error: 'busy' });
    const now = this.opts.now();
    this.rollover(dayOf(now));
    const limit = this.opts.config.perGameDay;
    if (limit > 0 && this.used >= limit)
      return this.refuse(req.endpoint, { status: 429, error: 'limit', resetsAtTick: this.resetsAt(now) });

    const id = `inf_${this.nextId++}`;
    const entry = {
      id,
      tick: now,
      ts: '',
      // 1-based, like the observer API's `day`; InfluenceSaveData.day stays dayOf(tick).
      day: dayOf(now) + 1,
      time: formatClock(now),
      endpoint: req.endpoint,
      payload: structuredClone(req.body),
      targets: [...checked.targets],
      refs: {},
      outcomes: checked.outcomes,
      ...(checked.visitor ? { visitor: true } : {}),
    } as InfluenceEntry;
    // Logged before apply() so outcome updates it triggers synchronously land on the entry.
    this.entries.push(entry);
    this.byId.set(id, entry);
    let refs: InfluenceRefs;
    try {
      ({ refs } = checked.apply(id));
    } catch (err) {
      this.entries.splice(this.entries.indexOf(entry), 1);
      this.byId.delete(id);
      log.error(`${req.endpoint} ${id}: apply failed`, err);
      throw err;
    }
    this.used++;
    entry.refs = { ...refs };
    const text = `${checked.text} [influence]`;
    const townTs = this.opts.townLog(text, entry.targets, { influenceId: id, endpoint: req.endpoint });
    entry.ts = this.increasing(opts.ts ?? townTs);
    this.trim();
    this.opts.emit(text);
    return { ok: true, id, tick: now, refs: { ...refs } };
  }

  /** Update the outcomes of a logged influence (no-op once it has left the log). */
  updateOutcomes<E extends InfluenceEndpoint>(
    endpoint: E,
    id: InfluenceId,
    update: (outcomes: InfluenceOutcomes[E]) => void,
  ): void {
    const e = this.byId.get(id);
    if (e?.endpoint === endpoint) update(e.outcomes as InfluenceOutcomes[E]);
  }

  budget(): InfluenceBudget {
    const now = this.opts.now();
    return {
      limit: this.opts.config.perGameDay,
      usedToday: this.day === dayOf(now) ? this.used : 0,
      resetsAtTick: this.resetsAt(now),
    };
  }

  /**
   * Oldest first. Without `since`: the newest `limit` entries. With `since` (a game tick or an
   * ISO-8601 timestamp): the first `limit` entries after it. Throws RangeError on a bad query.
   */
  log(q: InfluenceLogQuery): InfluenceLogPage {
    const limit = q.limit ?? LOG_PAGE_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('"limit" must be a positive integer');
    const max = Math.min(limit, INFLUENCE_LOG_PAGE_MAX);
    let after: ((e: InfluenceEntry) => boolean) | null = null;
    if (typeof q.since === 'number') {
      const tick = q.since;
      after = (e) => e.tick > tick;
    } else if (typeof q.since === 'string' && q.since.trim() !== '') {
      const ms = Date.parse(q.since);
      if (Number.isNaN(ms)) throw new RangeError('"since" must be a game tick or an ISO-8601 timestamp');
      after = (e) => Date.parse(e.ts) > ms;
    }
    const picked = after ? this.entries.filter(after).slice(0, max) : this.entries.slice(-max);
    const last = picked.at(-1);
    return {
      entries: structuredClone(picked),
      ...(last ? { nextSince: last.ts } : {}),
      budget: this.budget(),
    };
  }

  serialize(): InfluenceSaveData {
    return { day: this.day, used: this.used, nextId: this.nextId, entries: structuredClone(this.entries) };
  }

  private rollover(today: number): void {
    if (this.day === today) return;
    this.day = today;
    this.used = 0;
  }

  private resetsAt(now: GameMinutes): GameMinutes {
    return (dayOf(now) + 1) * MINUTES_PER_DAY;
  }

  /** Strictly increasing, so paging with `since=<ts>` never skips an entry (a passed-in ts counts too). */
  private increasing(ts: string): string {
    const parsed = Date.parse(ts);
    const ms = Number.isNaN(parsed) || parsed <= this.lastMs ? this.lastMs + 1 : parsed;
    this.lastMs = ms;
    return new Date(ms).toISOString();
  }

  private trim(): void {
    const over = this.entries.length - this.opts.config.logMax;
    if (over <= 0) return;
    const dropped = this.entries.splice(0, over);
    for (const e of dropped) this.byId.delete(e.id);
    log.info(
      `influence log full (logMax ${this.opts.config.logMax}); dropped ${dropped.map((e) => e.id).join(', ')}`,
    );
  }

  private refuse(endpoint: InfluenceEndpoint, r: InfluenceRefusal): InfluenceResult {
    log.info(`${endpoint}: refused ${r.status} ${r.error}`);
    return { ok: false, ...r };
  }
}
