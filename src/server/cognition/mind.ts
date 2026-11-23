/**
 * VillagerMind implementation (spec §7). `update()` is synchronous and cheap: it turns the current
 * plan block into an intent and schedules LLM jobs, whose results are applied when they resolve.
 * Every LLM-driven decision has a deterministic fallback.
 */
import { MINUTES_PER_DAY, dayOf, formatClock, minuteOfDay } from '../../shared/time.ts';
import {
  PLAYER_ID,
  type DayPlan,
  type DoorNote,
  type EventId,
  type GameMinutes,
  type LocationId,
  type Memory,
  type Needs,
  type NoteId,
  type PlanBlock,
  type Provenance,
  type VillageEvent,
  type VillagerId,
  type VillagerProfile,
} from '../../shared/types.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { createLogger } from '../log.ts';
import type {
  CreateMind,
  Intent,
  MindBookkeeping,
  MindDeps,
  MindSnapshot,
  MindWorld,
  Observation,
  PlayerInteraction,
  PlayerReply,
  RetrieveOptions,
  VillagerMind,
  WorldView,
} from './types.ts';
import { isTrivialObservation } from './importance.ts';
import { asArray, asBool, asNumber, asRecord, asString, clamp, parseClockLoose, pick } from './json.ts';
import { extractKeywords, keywordOverlap } from './keywords.ts';
import {
  ask,
  fallbackStats,
  gameTimer,
  loadTracker,
  statsLine,
  type AskResult,
  type AskSpec,
  type LoadLevel,
} from './llm.ts';
import { MemoryStore } from './memory.ts';
import {
  blockAt,
  describeBlocks,
  emojiFor,
  eventBlock,
  insertBlock,
  isAwake,
  makePlan,
  needOverride,
  normalizeBlocks,
  parseEventProposal,
  parsePlan,
  planDayFor,
  planEnd,
  rainSafe,
  resolveLocation,
  socialPlace,
  wakeWindow,
  withEvents,
  fallbackBlocks,
  type RawEventProposal,
  type WakeWindow,
} from './planning.ts';
import { selectNews, newsText } from './gossip.ts';
import { planDayPrompt, planRevisePrompt } from './prompts/plan.ts';
import {
  daySummaryPrompt,
  eventDecidePrompt,
  eventProposePrompt,
  importancePrompt,
  noteReplyPrompt,
  playerReplyPrompt,
  reflectPrompt,
  reflectQuestionsPrompt,
  taskDecidePrompt,
} from './prompts/misc.ts';
import { settingsFromConfig, type CognitionSettings } from './settings.ts';
import { villageFor, type Village } from './village.ts';

const log = createLogger('mind');

const SUMMARY_RE = /^Summary of day (\d+):/;

/**
 * Queue priorities set by cognition (TASK_PRIORITY has the defaults). On a slow model the order
 * decides what gets done at all: today's late plan first, then the daily event and the answers
 * it needs, then dialogue, then background work.
 */
/** Game minutes a note reply may wait for the model before the fallback reply is posted. */
const NOTE_REPLY_DEADLINE = 180;
/** Game minutes a retrieval waits for its query embedding before ranking by keywords alone. */
const RECALL_MAX_WAIT = 10;

export const PRIORITY = {
  planToday: 105,
  // Above convo.turn (100): one call a day that must not starve behind chatter.
  eventPropose: 101,
  convoFirstNews: 104,
  eventDecide: 92,
  noteReply: 108,
  planRetry: 90,
  planTomorrow: 70,
  reflect: 20,
} as const;

export class Mind implements VillagerMind {
  readonly id: VillagerId;
  readonly memory: MemoryStore;
  readonly settings: CognitionSettings;
  readonly window: WakeWindow;
  lastView: WorldView | null = null;

  private readonly village: Village<Mind>;
  private bookkeeping: MindBookkeeping = {
    importanceSinceReflection: 0,
    lastReflectionAt: null,
    lastPlanAt: null,
  };
  private plan: DayPlan | null = null;
  private readonly pending = new Set<string>();
  private readonly lastObs = new Map<string, { key: string; at: GameMinutes }>();
  private ratingQueue: Memory[] = [];
  private replanReason: string | null = null;
  private lastRevisionAt = -Infinity;
  private readonly decidedEvents = new Set<EventId>();
  private readonly processedNotes = new Set<NoteId>();
  private readonly repliedNotes = new Set<NoteId>();
  private readonly summarizedDays = new Set<number>();
  private readonly prepared = new Map<number, DayPlan>();
  private readonly planAttempts = new Map<number, number>();
  private readonly planSettled = new Set<number>();
  private readonly needFixedAt: Partial<Record<keyof Needs, GameMinutes>> = {};
  private readonly lastTalkedAt = new Map<VillagerId, GameMinutes>();
  private lastArchiveDay = -1;
  private eventRequested = false;
  private lastPlanJson = '';

  constructor(
    readonly profile: VillagerProfile,
    readonly deps: MindDeps,
    settings?: CognitionSettings,
  ) {
    this.id = profile.id;
    this.settings = settings ?? settingsFromConfig(deps.config);
    this.window = wakeWindow(profile);
    this.village = villageFor<Mind>(deps.queue);
    this.memory = new MemoryStore(profile.id, {
      weights: this.settings.retrievalWeights,
      defaultK: this.settings.retrievalK,
      embedder: this.village.embedder,
    });
    this.village.register(this);
    const snap = deps.snapshot;
    if (snap) {
      this.memory.load(snap.memories);
      this.bookkeeping = { ...snap.bookkeeping };
      for (const m of this.memory.all()) {
        const d = SUMMARY_RE.exec(m.text);
        if (m.kind === 'summary' && d) this.summarizedDays.add(Number(d[1]) - 1);
        if (m.meta.noteId && m.kind === 'note') this.processedNotes.add(m.meta.noteId);
      }
    } else {
      const at = deps.now();
      for (const text of profile.seedMemories ?? [])
        this.addMemory({ kind: 'observation', at, text, importance: 5 });
    }
  }

  get world(): MindWorld {
    return this.deps.world;
  }

  get currentPlan(): DayPlan | null {
    return this.plan;
  }

  // ---------- VillagerMind ----------

  update(view: WorldView): Intent {
    this.lastView = view;
    const now = view.now;
    const mod = minuteOfDay(now);
    this.flushRatings(now);
    if (view.self.status === 'talking' || view.self.conversationId) return { type: 'wait' };

    if (!isAwake(this.window, mod)) {
      this.night(view);
      if (view.self.locationId !== this.profile.homeId)
        return {
          type: 'goto',
          locationId: this.profile.homeId,
          activity: 'heading home to bed',
          emoji: '🌙',
        };
      return { type: 'sleep' };
    }

    const day = planDayFor(this.window, now);
    this.ensurePlan(view, day);
    // Plan tomorrow in the evening, while the model is less busy than at the morning rush.
    if (mod >= planEnd(this.window) - 90 && this.load() !== 'overloaded') this.prepareDay(view, day + 1);
    this.syncEvents(view, day);
    this.markDone(mod);
    if (view.self.locationId === this.profile.homeId) this.readNotes(view);
    this.maybeReflect(view);
    this.maybeDecideEvents(view);
    this.maybeProposeEvent(view, day, mod);
    this.maybeReplan(view, day, mod);

    return this.intentFor(this.effectiveBlock(view, mod), view);
  }

  observe(obs: Observation): void {
    if (obs.kind === 'observation') {
      const subject = (
        /^(.+?)\s+(?:is|are|was|were|has|have)\b/i.exec(obs.text)?.[1] ??
        obs.text.split(/\s+/).slice(0, 2).join(' ')
      )
        .toLowerCase()
        .trim();
      const key = obs.text.toLowerCase().replace(/\s+/g, ' ').trim();
      const prev = this.lastObs.get(subject);
      if (prev && (prev.key === key || obs.at - prev.at < this.settings.observationCooldownMinutes)) return;
      this.lastObs.set(subject, { key, at: obs.at });
    }
    if (obs.kind === 'event' && obs.meta?.eventId) {
      const kw = extractKeywords(obs.text);
      const dup = this.memory
        .all()
        .some(
          (m) =>
            m.kind === 'event' &&
            m.meta.eventId === obs.meta?.eventId &&
            keywordOverlap(kw, m.keywords) >= 0.5,
        );
      if (dup) return;
    }
    this.addMemory(obs);
  }

  onArrive(view: WorldView, locationId: LocationId): void {
    this.lastView = view;
    if (locationId === this.profile.homeId && isAwake(this.window, minuteOfDay(view.now)))
      this.readNotes(view);
  }

  wantsToTalkTo(view: WorldView, otherId: VillagerId): boolean {
    this.lastView = view;
    if (!isAwake(this.window, minuteOfDay(view.now))) return false;
    if (view.self.status === 'sleeping' || view.self.status === 'talking') return false;
    if (otherId === PLAYER_ID) return true;
    const last = this.lastTalkedAt.get(otherId) ?? view.self.relationships[otherId]?.lastTalkedAt;
    if (last !== undefined && view.now - last < this.settings.pairCooldownMinutes) return false;
    const affinity = view.self.relationships[otherId]?.affinity ?? 0;
    const other = this.village.minds.get(otherId);
    const news =
      this.newsFor(otherId, view.now, 1).length > 0 || (other?.newsFor(this.id, view.now, 1).length ?? 0) > 0;
    // A slow model can only carry a few conversations: keep the ones that spread news.
    const load = this.load();
    if (load === 'overloaded') return news;
    let p = 0.3 + 0.04 * affinity;
    if (news) p += 0.35;
    if (view.self.needs.social < 40) p += 0.15;
    if (load === 'busy' && !news) p *= 0.3;
    return this.deps.random() < clamp(p, 0.05, 0.95);
  }

  serialize(): MindSnapshot {
    return {
      villagerId: this.id,
      memories: this.memory.all().map((m) => ({ ...m, meta: { ...m.meta }, keywords: [...m.keywords] })),
      bookkeeping: { ...this.bookkeeping },
    };
  }

  requestEventProposal(): void {
    this.eventRequested = true;
  }

  async replyToPlayer(view: WorldView, input: PlayerInteraction): Promise<PlayerReply> {
    this.lastView = view;
    const now = view.now;
    const player = this.playerName();
    const text = input.text.trim().slice(0, 300);
    const gift = input.mode === 'gift';
    // Gift memories (and the affinity change) are stored by the player service (WP8).
    if (!gift)
      this.addMemory({
        kind: 'conversation',
        at: now,
        text: `${player} said to me: "${text}"`,
        meta: { heardFrom: PLAYER_ID },
      });
    const relation = this.relationText(view, PLAYER_ID, player);
    const memories = await this.recall(`${player} ${text}`, now, { k: 6 });
    const p = playerReplyPrompt(
      this.profile,
      player,
      relation,
      text,
      memories,
      view.self.activity.text || 'going about your day',
      input.mode,
    );
    const res = await this.ask({
      task: 'player.reply',
      ...p,
      meta: { ...this.baseMeta(view), text, mode: input.mode, itemId: input.itemId, liked: input.liked },
      parse: (raw) => cleanLine(asString(pick(asRecord(raw), 'reply', 'say', 'text', 'message', 'answer'))),
      acceptText: (t) => cleanLine(t),
      fallback: () => fallbackPlayerReply(this.profile, player, text, input),
      shape: '{"reply":"..."}',
      temperature: this.settings.temperature,
      maxTokens: 160,
    });
    let reply = res.value;
    let task: PlayerReply['task'];
    if (input.mode === 'ask') {
      task = await this.decideTask(view, text);
      if (task.accepted && !new RegExp(formatClock(task.start)).test(reply))
        reply = `${reply} I'll ${task.activity} at ${formatClock(task.start)}.`.slice(0, 300);
    }
    this.addMemory({
      kind: 'conversation',
      at: this.deps.now(),
      text: `I told ${player}: "${reply}"`,
      importance: 3,
      meta: { toldTo: [PLAYER_ID] },
    });
    this.world.setThought(reply);
    return task ? { reply, task } : { reply };
  }

  // ---------- memory ----------

  addMemory(obs: Observation): Memory {
    const explicit = obs.importance !== undefined;
    const m = this.memory.add(obs);
    this.bookkeeping.importanceSinceReflection += m.importance;
    if (
      !explicit &&
      this.settings.importanceMode === 'llm' &&
      !isTrivialObservation(m.kind, m.text) &&
      // Routine perception keeps its heuristic score; only notable ones are worth a model call.
      !(m.kind === 'observation' && m.importance <= 2) &&
      m.kind !== 'plan' &&
      m.kind !== 'summary' &&
      m.kind !== 'reflection'
    )
      this.ratingQueue.push(m);
    this.considerReplan(m);
    return m;
  }

  /** News this villager might share with `partnerId` (spec §7.6). */
  newsFor(partnerId: VillagerId, now: GameMinutes, max = 3): Memory[] {
    const events = this.lastView ? this.allEvents(this.lastView) : this.world.events();
    // Hosts and invitees already know about their event.
    const known = new Set(
      events.filter((e) => e.hostId === partnerId || e.invitees.includes(partnerId)).map((e) => e.id),
    );
    const candidates = this.memory.all().filter((m) => !m.meta.eventId || !known.has(m.meta.eventId));
    return selectNews(candidates, partnerId, now, max);
  }

  noteTalk(otherId: VillagerId, at: GameMinutes): void {
    this.lastTalkedAt.set(otherId, at);
  }

  relationText(view: WorldView | null, otherId: VillagerId, otherName: string): string {
    const r = view?.self.relationships[otherId];
    const a = r?.affinity ?? 0;
    const feel =
      a >= 6
        ? `${otherName} is one of your closest friends.`
        : a >= 2
          ? `You like ${otherName}.`
          : a <= -4
            ? `You do not get along with ${otherName}.`
            : a < 0
              ? `You are a bit wary of ${otherName}.`
              : `You know ${otherName} a little.`;
    return r?.summary ? `${feel} Last time: ${r.summary}` : feel;
  }

  playerName(): string {
    return this.settings.playerName && this.settings.playerName !== 'You'
      ? this.settings.playerName
      : 'the newcomer';
  }

  nameOf(id: VillagerId, view: WorldView | null = this.lastView): string {
    if (id === PLAYER_ID) return this.playerName();
    return view?.villagerNames[id] ?? this.village.minds.get(id)?.profile.name ?? id;
  }

  // ---------- jobs ----------

  private job(key: string, fn: () => Promise<void>): void {
    if (this.pending.has(key)) return;
    this.pending.add(key);
    fn()
      .catch((err: unknown) => log.warn(`${this.id} ${key} failed: ${(err as Error).message}`))
      .finally(() => this.pending.delete(key));
  }

  /**
   * True once a plan.day request for `day` has finished (model plan or fallback) with no retry
   * pending, or a model plan for it is already in hand. The engine holds the dawn clock on this.
   */
  isPlanSettled(day: number): boolean {
    if (this.planSettled.has(day) || this.prepared.get(day)?.source === 'llm') return true;
    return this.plan?.day === day && this.plan.source === 'llm';
  }

  isBusy(key: string): boolean {
    return this.pending.has(key);
  }

  /** How far behind the model is; optional LLM work is skipped when it is not 'normal'. */
  load(): LoadLevel {
    return loadTracker(this.deps.queue).level(this.deps.now());
  }

  /**
   * Memory retrieval that waits at most RECALL_MAX_WAIT game minutes for the query embedding (one
   * local model server can keep it queued behind long generations), then ranks by keywords.
   */
  async recall(query: string, now: GameMinutes, opts: RetrieveOptions = {}): Promise<Memory[]> {
    const timer = gameTimer(() => this.deps.now(), this.deps.now() + RECALL_MAX_WAIT);
    try {
      return await this.memory.retrieve(query, now, opts, timer.done);
    } finally {
      timer.stop();
    }
  }

  ask<T>(spec: AskSpec<T>): Promise<AskResult<T>> {
    return ask(this.deps.queue, { now: () => this.deps.now(), ...spec });
  }

  private baseMeta(view: WorldView | null): Record<string, unknown> {
    return {
      villagerId: this.id,
      profile: this.profile,
      locations: view?.locations.map((l) => l.id) ?? [],
      now: view?.now ?? this.deps.now(),
    };
  }

  private emit(level: 'info' | 'warn', text: string): void {
    const msg: ServerMessage = { type: 'log', level, text, time: this.deps.now() };
    this.deps.emit(msg);
  }

  // ---------- importance ----------

  private flushRatings(now: GameMinutes): void {
    if (this.ratingQueue.length === 0 || this.pending.has('importance')) return;
    const oldest = this.ratingQueue[0]!.createdAt;
    if (this.ratingQueue.length < this.settings.importanceBatchSize && now - oldest < 30) return;
    const batch = this.ratingQueue.splice(0, this.settings.importanceBatchSize);
    // Under load the heuristic scores stay.
    if (this.load() !== 'normal') return;
    this.job('importance', async () => {
      const p = importancePrompt(this.profile, batch);
      const res = await this.ask({
        task: 'importance.rate',
        ...p,
        meta: {
          ...this.baseMeta(this.lastView),
          memories: batch.map((m) => ({ text: m.text, kind: m.kind })),
        },
        parse: (raw) => parseRatings(raw, batch.length),
        fallback: () => batch.map((m) => m.importance),
        shape: `{"ratings":[${batch.map(() => 3).join(',')}]}`,
        temperature: 0,
        maxTokens: 80,
      });
      batch.forEach((m, i) => {
        const v = res.value[i];
        if (v === undefined) return;
        const next = clamp(Math.round(v), 1, 10);
        this.bookkeeping.importanceSinceReflection += next - m.importance;
        m.importance = next;
        this.considerReplan(m);
      });
    });
  }

  private considerReplan(m: Memory): void {
    if (m.importance < 7 || !['note', 'heard', 'event', 'observation', 'conversation'].includes(m.kind))
      return;
    if (m.meta.eventId && m.kind === 'event') return;
    this.replanReason = m.text.slice(0, 200);
  }

  // ---------- planning ----------

  private ensurePlan(view: WorldView, day: number): void {
    // The engine's copy is the source of truth: other services (rain swaps, restores) may rewrite it.
    const external = view.self.plan;
    if (external && external !== this.plan) {
      const json = JSON.stringify(external);
      if (json !== this.lastPlanJson) {
        this.plan = structuredClone(external) as DayPlan;
        this.lastPlanJson = json;
      }
    }
    if (this.plan?.day === day) {
      const attempts = this.planAttempts.get(day) ?? 0;
      if (this.plan.source === 'fallback' && attempts < 3 && view.now - this.plan.createdAt >= 60 * attempts)
        this.requestDayPlan(view, day);
      return;
    }
    const prepared = this.prepared.get(day);
    this.prepared.delete(day);
    const blocks = prepared?.blocks ?? fallbackBlocks(this.profile, view.locations);
    const plan = prepared
      ? {
          ...prepared,
          blocks: normalizeBlocks(
            withEvents(prepared.blocks, view.events, this.id, day),
            this.window,
            this.profile.homeId,
          ),
        }
      : makePlan(
          day,
          `A normal day as the village ${this.profile.occupation}.`,
          normalizeBlocks(withEvents(blocks, view.events, this.id, day), this.window, this.profile.homeId),
          'fallback',
          view.now,
        );
    this.setPlan(plan);
    if (!prepared) this.requestDayPlan(view, day);
  }

  private setPlan(plan: DayPlan): void {
    this.plan = plan;
    this.lastPlanJson = JSON.stringify(plan);
    this.bookkeeping.lastPlanAt = this.deps.now();
    this.world.setPlan(plan);
  }

  private requestDayPlan(view: WorldView, day: number): void {
    this.planAttempts.set(day, (this.planAttempts.get(day) ?? 0) + 1);
    this.job(`plan.day:${day}`, async () => {
      let retrying = false;
      try {
        retrying = await this.dayPlanJob(view, day);
      } finally {
        if (!retrying) this.planSettled.add(day);
      }
    });
  }

  /** Returns true when an immediate retry was scheduled. */
  private async dayPlanJob(view: WorldView, day: number): Promise<boolean> {
    const now = view.now;
    const memories = await this.recall(
      `my plans for today ${this.profile.occupation} ${this.profile.name}`,
      now,
      { k: 5 },
    );
    const yesterday =
      [...this.memory.all()]
        .reverse()
        .find((m) => m.kind === 'summary')
        ?.text.replace(SUMMARY_RE, '')
        .trim() ?? '';
    const acceptedEvents = view.events.filter(
      (e) =>
        dayOf(e.start) === day &&
        e.status !== 'cancelled' &&
        (e.hostId === this.id || e.accepted.includes(this.id)),
    );
    const allowProposal =
      this.village.proposalsOn(day) < this.settings.maxProposalsPerDay && this.deps.random() < 0.2;
    const p = planDayPrompt({
      profile: this.profile,
      day,
      window: this.window,
      yesterday,
      memories,
      events: acceptedEvents,
      locations: view.locations,
      needs: view.self.needs,
      ...(view.weather ? { weather: view.weather } : {}),
      allowProposal,
    });
    const res = await this.ask({
      task: 'plan.day',
      ...p,
      meta: { ...this.baseMeta(view), day, acceptedEvents },
      parse: (raw) => parsePlan(raw, view.locations, this.profile.homeId),
      fallback: () => null,
      shape:
        '{"summary":"...","blocks":[{"start":"07:00","end":"09:00","location":"<id>","activity":"...","emoji":"🙂"}]}',
      dedupeKey: `plan:${this.id}:day${day}`,
      // Today's plan is late already (the villager runs on the fallback): ahead of everything.
      priority:
        day > dayOf(this.deps.now())
          ? PRIORITY.planTomorrow
          : (this.planAttempts.get(day) ?? 0) > 1
            ? PRIORITY.planRetry
            : PRIORITY.planToday,
      temperature: this.settings.temperature,
      maxTokens: 320,
    });
    const parsed = res.value;
    if (!parsed) {
      // Retry once right away: while the engine holds the clock for the morning plans, waiting
      // for a game-time retry would never happen.
      if (
        (this.planAttempts.get(day) ?? 0) === 1 &&
        !(this.plan?.day === day && this.plan.source === 'llm')
      ) {
        setTimeout(() => this.requestDayPlan(this.lastView ?? view, day), 0);
        return true;
      }
      return false;
    }
    const latest = this.lastView ?? view;
    const blocks = withEvents(parsed.blocks, this.world.events(), this.id, day);
    const summary = parsed.summary || `My plan for day ${day + 1}.`;
    if (this.plan?.day === day) {
      const mod = minuteOfDay(this.deps.now());
      const merged = mergeFrom(this.plan.blocks, blocks, dayOf(this.deps.now()) === day ? mod : 0);
      this.setPlan({
        ...this.plan,
        summary,
        blocks: normalizeBlocks(merged, this.window, this.profile.homeId),
        revision: this.plan.revision + 1,
        source: 'llm',
        createdAt: this.deps.now(),
      });
    } else if (!this.plan || day > this.plan.day) {
      this.prepared.set(
        day,
        makePlan(
          day,
          summary,
          normalizeBlocks(blocks, this.window, this.profile.homeId),
          'llm',
          this.deps.now(),
        ),
      );
      if (!isAwake(this.window, minuteOfDay(this.deps.now()))) this.publishPrepared(day);
    }
    this.addMemory({
      kind: 'plan',
      at: this.deps.now(),
      text: `My plan for day ${day + 1}: ${summary}`,
      importance: 3,
    });
    this.world.setThought(summary);
    if (parsed.proposeEvent && this.village.proposalsOn(day) < this.settings.maxProposalsPerDay)
      this.createEvent(parsed.proposeEvent, latest, 'llm');
    return false;
  }

  private maybeReplan(view: WorldView, day: number, mod: number): void {
    const reason = this.replanReason;
    if (!reason || !this.plan || this.plan.day !== day) return;
    if (view.now - this.lastRevisionAt < this.settings.replanMinGapMinutes) return;
    const end = planEnd(this.window);
    if (mod > end - 60 || this.pending.has('plan.revise')) return;
    this.replanReason = null;
    if (this.load() !== 'normal') {
      this.goShareNews(view, mod);
      return;
    }
    this.lastRevisionAt = view.now;
    this.job('plan.revise', async () => {
      const plan = this.plan!;
      const memories = await this.recall(reason, view.now, { k: 6 });
      const p = planRevisePrompt({
        profile: this.profile,
        now: mod,
        plan,
        reason,
        memories,
        locations: view.locations,
        needs: view.self.needs,
        ...(view.weather ? { weather: view.weather } : {}),
        endOfDay: end,
      });
      const res = await this.ask({
        task: 'plan.revise',
        ...p,
        meta: { ...this.baseMeta(view), plan, reason },
        parse: (raw) => parsePlan(raw, view.locations, this.profile.homeId),
        fallback: () => null,
        shape:
          '{"summary":"...","blocks":[{"start":"14:00","end":"15:00","location":"<id>","activity":"...","emoji":"🙂"}]}',
        temperature: this.settings.temperature,
        maxTokens: 500,
      });
      if (!res.value || this.plan?.day !== day) return;
      const nowMod = minuteOfDay(this.deps.now());
      const merged = mergeFrom(
        this.plan.blocks,
        withEvents(res.value.blocks, this.world.events(), this.id, day),
        nowMod,
      );
      this.setPlan({
        ...this.plan,
        summary: res.value.summary || this.plan.summary,
        blocks: normalizeBlocks(merged, this.window, this.profile.homeId),
        revision: this.plan.revision + 1,
        source: 'llm',
      });
      if (res.value.summary) this.world.setThought(res.value.summary);
    });
  }

  /** Without a model to re-plan: spend a little while where people meet, to pass the news on. */
  private goShareNews(view: WorldView, mod: number): void {
    const place = socialPlace(view.locations);
    if (!place || !this.plan || mod + 60 > planEnd(this.window)) return;
    const start = mod + 5;
    if (this.plan.blocks.some((b) => (b.eventId || b.taskId) && b.start < start + 45 && b.end > start))
      return;
    this.lastRevisionAt = view.now;
    this.setPlan({
      ...this.plan,
      blocks: normalizeBlocks(
        insertBlock(this.plan.blocks, {
          start,
          end: start + 45,
          locationId: place.id,
          activity: 'share the news with friends',
          emoji: '💬',
        }),
        this.window,
        this.profile.homeId,
      ),
    });
  }

  private markDone(mod: number): void {
    const plan = this.plan;
    if (!plan) return;
    let changed = false;
    for (const b of plan.blocks) {
      if (b.done || b.end > mod) continue;
      b.done = true;
      changed = true;
      if (b.taskId) {
        this.world.taskCompleted?.(b.taskId, b);
        this.addMemory({
          kind: 'event',
          at: this.deps.now(),
          text: `I did what ${this.playerName()} asked: ${b.activity}`,
          importance: 5,
        });
      }
    }
    if (changed) this.setPlan(plan);
  }

  private effectiveBlock(view: WorldView, mod: number): PlanBlock {
    let block = blockAt(this.plan, mod) ?? {
      start: mod,
      end: Math.min(MINUTES_PER_DAY, mod + 30),
      locationId: this.profile.homeId,
      activity: 'relax at home',
      emoji: '🏠',
    };
    if (this.settings.needsEnabled && this.plan) {
      const o = needOverride(view.self.needs, block, view.locations, this.profile.homeId, mod, (need) => {
        const at = this.needFixedAt[need];
        return at !== undefined && view.now - at < 120;
      });
      if (o) {
        this.needFixedAt[o.need] = view.now;
        this.setPlan({
          ...this.plan,
          blocks: normalizeBlocks(insertBlock(this.plan.blocks, o.block), this.window, this.profile.homeId),
        });
        block = o.block;
      }
    }
    for (const e of view.events) {
      if (e.status !== 'happening' || (e.hostId !== this.id && !e.accepted.includes(this.id))) continue;
      if (view.now >= e.start && view.now < e.end) block = eventBlock(e, this.id);
    }
    return rainSafe(block, view.weather, view.locations, this.profile.homeId);
  }

  private intentFor(block: PlanBlock, view: WorldView): Intent {
    const emoji = block.emoji ?? emojiFor(block.activity);
    if (view.self.locationId !== block.locationId)
      return { type: 'goto', locationId: block.locationId, activity: block.activity, emoji };
    return { type: 'act', activity: block.activity, emoji };
  }

  // ---------- reflection ----------

  private maybeReflect(view: WorldView): void {
    const b = this.bookkeeping;
    if (b.importanceSinceReflection < this.settings.reflectionThreshold) return;
    if (b.lastReflectionAt !== null && view.now - b.lastReflectionAt < this.settings.reflectionMinGapMinutes)
      return;
    // Reflection waits until the model has time again (the importance keeps adding up).
    if (this.load() !== 'normal') return;
    b.importanceSinceReflection = 0;
    b.lastReflectionAt = view.now;
    this.job('reflect', async () => {
      const recent = this.memory
        .all()
        .filter((m) => m.kind !== 'plan' && !m.meta.archived)
        .slice(-20);
      let sources = recent;
      if (this.settings.reflectionMode === 'two-step') {
        const q = await this.ask({
          task: 'reflect.questions',
          ...reflectQuestionsPrompt(this.profile, recent),
          meta: { ...this.baseMeta(view), memories: recent.map((m) => ({ text: m.text })) },
          parse: (raw) => {
            const qs = asArray(pick(asRecord(raw), 'questions') ?? raw)
              .map((x) => asString(x))
              .filter((x): x is string => !!x);
            return qs.length ? qs.slice(0, 3) : null;
          },
          fallback: () => [],
          shape: '{"questions":["..."]}',
          maxTokens: 150,
        });
        if (q.value.length) {
          const found = new Map<string, Memory>();
          for (const question of q.value)
            for (const m of await this.recall(question, view.now, { k: 6 })) found.set(m.id, m);
          if (found.size) sources = [...found.values()].slice(0, 20);
        }
      }
      if (sources.length === 0) return;
      const res = await this.ask({
        task: 'reflect',
        ...reflectPrompt(this.profile, sources),
        meta: { ...this.baseMeta(view), memories: sources.map((m) => ({ text: m.text })) },
        parse: (raw) => parseInsights(raw, sources),
        fallback: () => [],
        shape: '{"insights":[{"text":"...","because":[1,2]}]}',
        priority: PRIORITY.reflect,
        deadline: view.now + 180,
        temperature: this.settings.temperature,
        maxTokens: 300,
      });
      for (const ins of res.value.slice(0, 3)) {
        this.addMemory({
          kind: 'reflection',
          at: this.deps.now(),
          text: ins.text,
          importance: 7,
          meta: { sourceIds: ins.sourceIds },
        });
      }
      if (res.value[0]) this.world.setThought(res.value[0].text);
    });
  }

  // ---------- events ----------

  private allEvents(view: WorldView): VillageEvent[] {
    const byId = new Map<EventId, VillageEvent>();
    for (const e of view.events) byId.set(e.id, e);
    for (const e of this.world.events()) byId.set(e.id, e);
    return [...byId.values()];
  }

  /** Accepted/hosted events always have a block; finished events leave a memory. */
  private syncEvents(view: WorldView, day: number): void {
    const plan = this.plan;
    for (const e of this.allEvents(view)) {
      const mine = e.hostId === this.id || e.accepted.includes(this.id);
      if (
        plan &&
        mine &&
        dayOf(e.start) === day &&
        e.status !== 'cancelled' &&
        e.status !== 'done' &&
        !plan.blocks.some((b) => b.eventId === e.id)
      ) {
        this.setPlan({
          ...plan,
          blocks: normalizeBlocks(
            insertBlock(plan.blocks, eventBlock(e, this.id)),
            this.window,
            this.profile.homeId,
          ),
        });
      }
      if (e.status === 'done' && e.attendees.includes(this.id) && !this.decidedEvents.has(`done:${e.id}`)) {
        this.decidedEvents.add(`done:${e.id}`);
        const others = e.attendees.filter((a) => a !== this.id).map((a) => this.nameOf(a, view));
        const text = `I attended ${e.title} at ${this.locName(view, e.locationId)}${others.length ? ` with ${others.join(', ')}` : ''}.`;
        this.addMemory({ kind: 'event', at: view.now, text, importance: 6, meta: { eventId: e.id } });
      }
    }
  }

  private maybeDecideEvents(view: WorldView): void {
    for (const e of this.allEvents(view)) {
      if (e.hostId === this.id || this.decidedEvents.has(e.id)) continue;
      if (e.status !== 'proposed' && e.status !== 'scheduled') continue;
      if (e.end <= view.now || e.accepted.includes(this.id) || e.declined.includes(this.id)) continue;
      if (!e.invitees.includes(this.id) && !this.heardAbout(e)) continue;
      this.decidedEvents.add(e.id);
      this.decideEvent(view, e);
    }
  }

  private heardAbout(e: VillageEvent): boolean {
    const kw = extractKeywords(e.title);
    if (kw.length === 0) return false;
    return this.memory
      .all()
      .some((m) => m.meta.eventId === e.id || (m.kind === 'heard' && keywordOverlap(kw, m.keywords) >= 0.6));
  }

  private decideEvent(view: WorldView, e: VillageEvent): void {
    this.job(`event.decide:${e.id}`, async () => {
      const affinity = view.self.relationships[e.hostId]?.affinity ?? 0;
      const hostName = this.nameOf(e.hostId, view);
      const day = dayOf(e.start);
      const s = minuteOfDay(e.start);
      const en = dayOf(e.end) > day ? MINUTES_PER_DAY : minuteOfDay(e.end);
      const plan = this.plan?.day === day ? this.plan : null;
      const overlapping = (plan?.blocks ?? []).filter(
        (b) => b.start < en && b.end > s && b.activity !== 'relax at home',
      );
      const pinnedConflict = overlapping.some((b) => b.eventId || b.taskId);
      const memories = await this.recall(`${e.title} ${hostName}`, view.now, { k: 5 });
      const p = eventDecidePrompt(
        this.profile,
        e,
        hostName,
        this.relationText(view, e.hostId, hostName),
        overlapping.map((b) => b.activity).join('; '),
        memories,
      );
      const res = await this.ask({
        task: 'event.decide',
        ...p,
        meta: { ...this.baseMeta(view), event: e, affinity },
        parse: (raw) => {
          const r = asRecord(raw);
          const accept = asBool(pick(r, 'accept', 'go', 'attend', 'decision', 'answer'));
          if (accept === undefined) return null;
          return { accept, reason: asString(pick(r, 'reason', 'why', 'because')) ?? '' };
        },
        fallback: () => ({
          accept: affinity >= 0 && !pinnedConflict,
          reason: pinnedConflict
            ? 'I already have plans then.'
            : affinity >= 0
              ? 'Sounds fun.'
              : 'Not really my thing.',
        }),
        shape: '{"accept":true,"reason":"..."}',
        priority: PRIORITY.eventDecide,
        offline: this.load() === 'overloaded',
        deadline: Math.min(e.start - 30, view.now + (this.load() === 'normal' ? 120 : 45)),
        noRepair: this.load() !== 'normal',
        temperature: this.settings.temperature,
        maxTokens: 100,
      });
      const accept = res.value.accept && !pinnedConflict;
      const reason = res.value.reason.slice(0, 160) || (accept ? 'Sounds fun.' : 'I am busy.');
      const latest = this.world.events().find((x) => x.id === e.id) ?? e;
      if (latest.status === 'cancelled' || latest.status === 'done') return;
      this.world.upsertEvent({
        ...latest,
        accepted: accept
          ? [...new Set([...latest.accepted, this.id])]
          : latest.accepted.filter((x) => x !== this.id),
        declined: accept
          ? latest.declined.filter((x) => x !== this.id)
          : [...new Set([...latest.declined, this.id])],
      });
      if (accept && this.plan && this.plan.day === day)
        this.setPlan({
          ...this.plan,
          blocks: normalizeBlocks(
            insertBlock(this.plan.blocks, eventBlock(latest, this.id)),
            this.window,
            this.profile.homeId,
          ),
        });
      this.addMemory({
        kind: 'event',
        at: this.deps.now(),
        text: accept
          ? `I will go to ${latest.title} by ${hostName} at ${formatClock(latest.start)}. ${reason}`
          : `I decided not to go to ${latest.title} by ${hostName}. ${reason}`,
        importance: 4,
        meta: { eventId: latest.id },
      });
      this.world.setThought(accept ? `Going to ${latest.title}!` : `Skipping ${latest.title}.`);
    });
  }

  private maybeProposeEvent(view: WorldView, day: number, mod: number): void {
    if (this.pending.has('event.propose')) return;
    if (this.eventRequested) {
      this.eventRequested = false;
      this.proposeEvent(view);
      return;
    }
    if (!this.settings.ensureDailyEvent || mod < this.settings.ensureDailyAt || mod >= 15 * 60) return;
    if (this.village.proposalsOn(day) >= Math.max(1, this.settings.maxProposalsPerDay)) return;
    const today = this.allEvents(view).some((e) => dayOf(e.start) === day && e.status !== 'cancelled');
    if (today || this.village.bestHost() !== this.id || !this.village.claimDaily(day, this.id)) return;
    this.proposeEvent(view);
  }

  private proposeEvent(view: WorldView): void {
    this.job('event.propose', async () => {
      const memories = await this.recall(`host a fun event ${this.profile.occupation}`, view.now, {
        k: 6,
      });
      const villagers = Object.entries(view.villagerNames)
        .filter(([id]) => id !== this.id && id !== PLAYER_ID)
        .map(([id, name]) => ({ id, name, affinity: view.self.relationships[id]?.affinity ?? 0 }))
        .sort((a, b) => b.affinity - a.affinity || a.id.localeCompare(b.id));
      const p = eventProposePrompt(
        this.profile,
        view.now,
        memories,
        view.locations,
        villagers.slice(0, 8).map((v) => v.name),
      );
      const res = await this.ask({
        task: 'event.propose',
        ...p,
        meta: { ...this.baseMeta(view), villagers },
        parse: (raw) => parseEventProposal(raw),
        fallback: () => fallbackProposal(this.profile, view),
        shape:
          '{"title":"...","description":"...","location":"<id>","start":"15:00","durationMinutes":120,"invitees":["Name"]}',
        priority: PRIORITY.eventPropose,
        // Never expires in the queue, so the model gets at least one try; the fallback event is
        // used only if nothing came back by early afternoon.
        expiresAt: Number.MAX_SAFE_INTEGER,
        deadline: Math.max(view.now + 60, dayOf(view.now) * MINUTES_PER_DAY + 13 * 60),
        temperature: this.settings.temperature,
        maxTokens: 200,
      });
      this.createEvent(res.value, this.lastView ?? view, res.source);
    });
  }

  private createEvent(raw: RawEventProposal, view: WorldView, source: Provenance): VillageEvent | null {
    const now = this.deps.now();
    const end = planEnd(this.window);
    let day = dayOf(now);
    let start = raw.start ?? 15 * 60;
    const earliest = minuteOfDay(now) + 60;
    if (start < earliest) start = Math.ceil((minuteOfDay(now) + 90) / 15) * 15;
    const dur = clamp(Math.round(raw.durationMinutes ?? 120), 45, 180);
    if (start + 45 > end) {
      day += 1;
      start = raw.start !== undefined && raw.start >= this.window.wake + 60 ? raw.start : 15 * 60;
    }
    const startAbs = day * MINUTES_PER_DAY + start;
    const endAbs = day * MINUTES_PER_DAY + Math.min(end, start + dur);
    const locationId =
      resolveLocation(raw.location, view.locations, this.profile.homeId) ??
      socialPlace(view.locations)?.id ??
      this.profile.homeId;
    const nameToId = new Map<string, VillagerId>();
    for (const [id, name] of Object.entries(view.villagerNames)) {
      nameToId.set(name.toLowerCase(), id);
      nameToId.set(name.split(/\s+/)[0]!.toLowerCase(), id);
      nameToId.set(id.toLowerCase(), id);
    }
    const invitees = new Set<VillagerId>();
    for (const n of raw.invitees) {
      const id = nameToId.get(n.toLowerCase().trim()) ?? nameToId.get(n.toLowerCase().split(/\s+/)[0] ?? '');
      if (id && id !== this.id && id !== PLAYER_ID) invitees.add(id);
    }
    const others = Object.keys(view.villagerNames)
      .filter((id) => id !== this.id && id !== PLAYER_ID && !invitees.has(id))
      .sort(
        (a, b) =>
          (view.self.relationships[b]?.affinity ?? 0) - (view.self.relationships[a]?.affinity ?? 0) ||
          a.localeCompare(b),
      );
    while (invitees.size < 5 && others.length) invitees.add(others.shift()!);
    const event: VillageEvent = {
      source,
      id: `ev-${this.id}-${Math.round(now)}`,
      title: raw.title,
      description: raw.description,
      hostId: this.id,
      locationId,
      start: startAbs,
      end: endAbs,
      invitees: [...invitees],
      accepted: [],
      declined: [],
      attendees: [],
      status: 'scheduled',
    };
    this.world.upsertEvent(event);
    this.village.countProposal(startAbs);
    const where = this.locName(view, locationId);
    this.addMemory({
      kind: 'event',
      at: now,
      text: `I am hosting ${event.title} at ${where} on day ${day + 1} at ${formatClock(startAbs)}.`,
      importance: 6,
      meta: { eventId: event.id },
    });
    if (this.plan?.day === day)
      this.setPlan({
        ...this.plan,
        blocks: normalizeBlocks(
          insertBlock(this.plan.blocks, eventBlock(event, this.id)),
          this.window,
          this.profile.homeId,
        ),
      });
    for (const id of event.invitees) {
      this.village.minds.get(id)?.observe({
        kind: 'event',
        at: now,
        text: `${this.profile.name} invited me to ${event.title} at ${where} at ${formatClock(startAbs)}.`,
        importance: 6,
        meta: { eventId: event.id },
      });
    }
    this.world.setThought(`Hosting ${event.title} at ${formatClock(startAbs)}!`);
    this.emit('info', `${this.profile.name} is hosting ${event.title} at ${where}, ${formatClock(startAbs)}`);
    return event;
  }

  locName(view: WorldView | null, id: LocationId): string {
    if (id === this.profile.homeId) return 'my home';
    return view?.locations.find((l) => l.id === id)?.name ?? id;
  }

  // ---------- door notes ----------

  private readNotes(view: WorldView): void {
    const notes = [
      ...view.notesAtHome,
      ...this.world.notes().filter((n) => n.houseId === this.profile.homeId),
    ]
      .filter((n, i, all) => all.findIndex((x) => x.id === n.id) === i)
      .filter(
        (n) =>
          n.status === 'unread' &&
          (n.ownerId === this.id || n.houseId === this.profile.homeId) &&
          n.authorId !== this.id,
      )
      .filter((n) => !this.processedNotes.has(n.id))
      .sort((a, b) => a.postedAt - b.postedAt);
    // Read but never answered (reply job lost, or restored from a save between read and reply).
    for (const n of this.world.notes()) {
      if (n.houseId !== this.profile.homeId || n.authorId === this.id) continue;
      if (n.status !== 'read' || n.reply || this.repliedNotes.has(n.id)) continue;
      if (this.pending.has(`note.reply:${n.id}`)) continue;
      this.processedNotes.add(n.id);
      const who = n.authorId === PLAYER_ID ? this.playerName() : this.nameOf(n.authorId, view);
      this.replyToNote(view, n, who);
    }
    for (const note of notes) {
      this.processedNotes.add(note.id);
      const now = view.now;
      this.world.upsertNote({ ...note, status: 'read', readAt: now });
      const author = note.authorId === PLAYER_ID ? this.playerName() : this.nameOf(note.authorId, view);
      this.addMemory({
        kind: 'note',
        at: now,
        text: `I found a note on my door from ${author}: "${note.text.slice(0, 300)}"`,
        importance: 8,
        // originId = note id, so rumor tracking can start from the note without knowing memory ids.
        meta: { noteId: note.id, originId: note.id, heardFrom: note.authorId },
      });
      this.replyToNote(view, note, author);
    }
  }

  private replyToNote(view: WorldView, note: DoorNote, author: string): void {
    this.job(`note.reply:${note.id}`, async () => {
      try {
        await this.writeNoteReply(view, note, author);
      } catch (err) {
        log.warn(`${this.id} note reply failed (${(err as Error).message}); replying without the model`);
        this.postNoteReply(
          view,
          note,
          author,
          ensureReference(fallbackNoteReply(this.profile, note.text), note.text),
          'fallback',
        );
      }
    });
  }

  private async writeNoteReply(view: WorldView, note: DoorNote, author: string): Promise<void> {
    let memories: Memory[] = [];
    try {
      memories = await this.recall(note.text, view.now, { k: 5 });
    } catch (err) {
      log.debug(`${this.id} note memories unavailable: ${(err as Error).message}`);
    }
    const res = await this.ask({
      task: 'note.reply',
      ...noteReplyPrompt(this.profile, author, note.text, memories),
      meta: { ...this.baseMeta(view), noteText: note.text, noteId: note.id, authorId: note.authorId },
      parse: (raw) =>
        cleanLine(asString(pick(asRecord(raw), 'reply', 'text', 'message', 'answer', 'note')), 400),
      acceptText: (t) => cleanLine(t, 400),
      fallback: () => fallbackNoteReply(this.profile, note.text),
      shape: '{"reply":"..."}',
      priority: PRIORITY.noteReply,
      // Never left unanswered: after a few game hours the fallback reply goes up instead.
      deadline: view.now + NOTE_REPLY_DEADLINE,
      temperature: this.settings.temperature,
      maxTokens: 200,
    });
    const reply = ensureReference(res.value, note.text);
    // A reply we had to patch to reference the note counts as a fallback.
    const replySource: Provenance = res.source === 'llm' && reply === res.value ? 'llm' : 'fallback';
    this.postNoteReply(view, note, author, reply, replySource);
  }

  private postNoteReply(
    view: WorldView,
    note: DoorNote,
    author: string,
    reply: string,
    replySource: Provenance,
  ): void {
    if (this.repliedNotes.has(note.id)) return;
    this.repliedNotes.add(note.id);
    const at = this.deps.now();
    const latest = this.world.notes().find((n) => n.id === note.id) ?? {
      ...note,
      status: 'read' as const,
      readAt: view.now,
    };
    const replied: DoorNote = {
      ...latest,
      status: 'replied',
      reply,
      repliedAt: at,
      replySource,
    };
    this.world.upsertNote(replied);
    this.addMemory({
      kind: 'note',
      at,
      text: `I replied to the note from ${author}: "${reply}"`,
      importance: 4,
      meta: { noteId: note.id },
    });
    this.world.setThought(reply);
  }

  // ---------- player tasks ----------

  private async decideTask(view: WorldView, text: string): Promise<NonNullable<PlayerReply['task']>> {
    const now = view.now;
    const mod = minuteOfDay(now);
    const end = planEnd(this.window);
    const player = this.playerName();
    const rest = (this.plan?.blocks ?? []).filter((b) => b.end > mod);
    const affinity = view.self.relationships[PLAYER_ID]?.affinity ?? 0;
    const guessLoc =
      resolveLocation(text, view.locations, this.profile.homeId) ??
      blockAt(this.plan, mod)?.locationId ??
      this.profile.homeId;
    const res = await this.ask({
      task: 'task.decide',
      ...taskDecidePrompt(
        this.profile,
        player,
        this.relationText(view, PLAYER_ID, player),
        text,
        describeBlocks(rest),
        mod,
        view.locations,
      ),
      meta: { ...this.baseMeta(view), text },
      parse: (raw) => {
        const r = asRecord(raw);
        const accept = asBool(pick(r, 'accept', 'accepted', 'yes', 'decision', 'will'));
        if (accept === undefined) return null;
        return {
          accept,
          activity: asString(pick(r, 'activity', 'task', 'what', 'action')) ?? '',
          location: pick(r, 'location', 'place', 'where'),
          time: parseClockLoose(pick(r, 'time', 'start', 'when', 'at')),
        };
      },
      fallback: () => ({
        accept: affinity >= -2 && mod < end - 60,
        activity: '',
        location: undefined,
        time: undefined,
      }),
      shape: '{"accept":true,"activity":"...","location":"<id>","time":"16:00"}',
      temperature: this.settings.temperature,
      maxTokens: 150,
    });
    const v = res.value;
    const activity = (v.activity || taskActivity(text)).replace(/\s+/g, ' ').slice(0, 80);
    const locationId = resolveLocation(v.location, view.locations, this.profile.homeId) ?? guessLoc;
    let start = v.time ?? mod + 30;
    if (start < mod + 10) start = mod + 30;
    start = Math.round(start);
    const accepted = v.accept && start + 15 <= end;
    if (!accepted || start + 30 > end) start = Math.min(start, Math.max(mod, end - 30));
    const day = dayOf(now);
    const taskId = `task-${this.id}-${Math.round(now)}`;
    if (accepted && this.plan) {
      const block: PlanBlock = {
        start,
        end: Math.min(end, start + 60),
        locationId,
        activity,
        emoji: emojiFor(activity),
        taskId,
      };
      this.setPlan({
        ...this.plan,
        blocks: normalizeBlocks(insertBlock(this.plan.blocks, block), this.window, this.profile.homeId),
      });
      this.addMemory({
        kind: 'plan',
        at: now,
        text: `I promised ${player} to ${activity} at ${formatClock(start)}.`,
        importance: 6,
      });
    }
    return { taskId, accepted, activity, locationId, start: day * MINUTES_PER_DAY + start };
  }

  // ---------- night ----------

  private night(view: WorldView): void {
    const now = view.now;
    const nextDay = planDayFor(this.window, now);
    const ended = nextDay - 1;
    if (ended >= dayOf(0) && !this.summarizedDays.has(ended)) {
      const from = ended * MINUTES_PER_DAY;
      const mems = this.memory.between(from, now + 1).filter((m) => m.kind !== 'plan' && !m.meta.archived);
      this.summarizedDays.add(ended);
      if (mems.length > 0) this.summarizeDay(view, ended, mems);
    }
    if (this.lastArchiveDay !== nextDay) {
      this.lastArchiveDay = nextDay;
      this.memory.archiveOld(now);
    }
    this.prepareDay(view, nextDay);
    this.publishPrepared(nextDay);
    if (this.village.claimStatsLog(ended)) {
      const line = statsLine(fallbackStats(this.deps.queue));
      if (line) this.emit('info', `LLM use so far (model / fallback): ${line}`);
    }
  }

  /**
   * While asleep, a plan prepared for the coming day goes to the engine at once, so the world shows
   * whether everyone's morning plan came from the model (the engine can wait for it at dawn).
   */
  private publishPrepared(day: number): void {
    const p = this.prepared.get(day);
    if (!p || this.plan?.day === day) return;
    this.prepared.delete(day);
    this.setPlan({
      ...p,
      blocks: normalizeBlocks(
        withEvents(p.blocks, this.world.events(), this.id, day),
        this.window,
        this.profile.homeId,
      ),
    });
  }

  private prepareDay(view: WorldView, day: number): void {
    if (!this.prepared.has(day) && this.plan?.day !== day && (this.planAttempts.get(day) ?? 0) === 0)
      this.requestDayPlan(view, day);
  }

  private summarizeDay(view: WorldView, day: number, mems: Memory[]): void {
    this.job(`day.summarize:${day}`, async () => {
      const top = [...mems]
        .sort((a, b) => b.importance - a.importance || a.createdAt - b.createdAt)
        .slice(0, 25);
      top.sort((a, b) => a.createdAt - b.createdAt);
      const res = await this.ask({
        task: 'day.summarize',
        ...daySummaryPrompt(this.profile, day, top),
        meta: {
          ...this.baseMeta(view),
          day,
          memories: top.map((m) => ({ text: m.text, kind: m.kind, importance: m.importance })),
        },
        parse: (raw) => cleanLine(asString(pick(asRecord(raw), 'summary', 'text', 'day')), 500),
        acceptText: (t) => cleanLine(t, 500),
        fallback: () => {
          const highlights = [...top]
            .sort((a, b) => b.importance - a.importance)
            .slice(0, 3)
            .map((m) => m.text);
          return `A day as the village ${this.profile.occupation}. Highlights: ${highlights.join(' ')}`.slice(
            0,
            500,
          );
        },
        shape: '{"summary":"..."}',
        offline: this.load() !== 'normal',
        temperature: 0.3,
        maxTokens: 220,
      });
      this.addMemory({
        kind: 'summary',
        at: this.deps.now(),
        text: `Summary of day ${day + 1}: ${res.value}`,
        importance: 5,
      });
    });
  }
}

// ---------- helpers ----------

/** Keep old blocks before `mod`, take new blocks from `mod` on, keep pinned (event/task) future blocks. */
export function mergeFrom(
  oldBlocks: readonly PlanBlock[],
  newBlocks: readonly PlanBlock[],
  mod: number,
): PlanBlock[] {
  const past: PlanBlock[] = [];
  for (const b of oldBlocks) {
    if (b.end <= mod) past.push(b);
    else if (b.start < mod) past.push({ ...b, end: mod });
  }
  let out: PlanBlock[] = [...past];
  for (const b of newBlocks) {
    if (b.end <= mod) continue;
    out.push({ ...b, start: Math.max(b.start, mod) });
  }
  for (const b of oldBlocks)
    if (
      (b.eventId || b.taskId) &&
      b.end > mod &&
      !out.some((x) => x.eventId === b.eventId && x.taskId === b.taskId && x.start === b.start)
    )
      out = insertBlock(out, b);
  return out;
}

export function parseRatings(raw: unknown, n: number): number[] | null {
  const r = asRecord(raw);
  const list = Array.isArray(raw) ? raw : asArray(pick(r, 'ratings', 'scores', 'importance', 'rating'));
  const nums = list
    .map((x) => asNumber(x) ?? asNumber(pick(asRecord(x), 'importance', 'rating', 'score')))
    .filter((x): x is number => x !== undefined);
  if (nums.length === 0) return null;
  if (nums.length === 1 && n > 1) return new Array<number>(n).fill(nums[0]!);
  return nums.slice(0, n);
}

export function parseInsights(
  raw: unknown,
  sources: readonly Memory[],
): { text: string; sourceIds: string[] }[] | null {
  const r = asRecord(raw);
  const list = Array.isArray(raw) ? raw : asArray(pick(r, 'insights', 'reflections', 'insight'));
  const out: { text: string; sourceIds: string[] }[] = [];
  for (const item of list) {
    const ir = asRecord(item);
    const text = asString(ir ? pick(ir, 'text', 'insight', 'statement') : item);
    if (!text) continue;
    const idx = asArray(pick(ir, 'because', 'sources', 'evidence', 'cites'))
      .map((x) => asNumber(x))
      .filter((x): x is number => x !== undefined);
    const zeroBased = idx.includes(0);
    const sourceIds = idx.map((i) => sources[zeroBased ? i : i - 1]?.id).filter((x): x is string => !!x);
    out.push({ text: text.slice(0, 240), sourceIds: [...new Set(sourceIds)] });
  }
  return out.length ? out : null;
}

export function cleanLine(s: string | undefined, max = 300): string | null {
  if (!s) return null;
  let t = s
    .replace(/^```[\s\S]*?\n/, '')
    .replace(/```$/, '')
    .replace(/^\s*[A-Z][\w .'-]{0,24}:\s+/, (m) => (/^\s*(Note|PS)\b/i.test(m) ? m : ''))
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/^["'“]+|["'”]+$/g, '').trim();
  if (!t || t.startsWith('{')) return null;
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t;
}

function snippet(text: string, words = 6): string {
  const w = text.replace(/\s+/g, ' ').trim().split(' ');
  return w.slice(0, words).join(' ') + (w.length > words ? '…' : '');
}

/** Make sure a note reply addresses the note: prefix a quote when no content keyword appears. */
export function ensureReference(reply: string, note: string): string {
  const kw = extractKeywords(note).filter((k) => k.length >= 3);
  if (kw.length === 0) return reply;
  const replyKw = new Set(extractKeywords(reply, 64));
  if (kw.some((k) => replyKw.has(k))) return reply;
  return `About your note "${snippet(note)}": ${reply}`;
}

export function fallbackNoteReply(p: VillagerProfile, note: string): string {
  return `Thanks for your note about "${snippet(note)}". I'll think about it. — ${p.name}`;
}

function fallbackPlayerReply(
  p: VillagerProfile,
  player: string,
  text: string,
  input: PlayerInteraction,
): string {
  if (input.mode === 'gift')
    return input.liked
      ? `Oh, ${text}! I love these, thank you so much!`
      : `How kind of you, thank you for the ${text}!`;
  if (input.mode === 'ask') return `Hmm, "${snippet(text, 8)}"? Let me see what I can do.`;
  if (/\?\s*$/.test(text))
    return `Good question! As the village ${p.occupation}, I'd say it depends. What do you think, ${player}?`;
  return `Oh, hello! "${snippet(text, 8)}" — nice of you to tell me.`;
}

function taskActivity(text: string): string {
  const t = text
    .replace(/^(could|can|would|will) you (please )?/i, '')
    .replace(/^please /i, '')
    .replace(/[?.!]+$/, '')
    .trim();
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : 'help the newcomer';
}

function fallbackProposal(p: VillagerProfile, view: WorldView): RawEventProposal {
  const occ = `${p.occupation} ${p.bio}`.toLowerCase();
  const social = socialPlace(view.locations)?.id ?? p.homeId;
  if (/bak|pastr|bread|cake/.test(occ))
    return {
      title: 'Bake-off',
      description: 'Bring your best pie or cake!',
      location: social,
      start: 15 * 60,
      durationMinutes: 120,
      invitees: [],
    };
  if (/music|sing|guitar/.test(occ))
    return {
      title: 'Evening concert',
      description: 'Songs by the fountain.',
      location: social,
      start: 17 * 60,
      durationMinutes: 90,
      invitees: [],
    };
  if (/garden|farm|flower/.test(occ))
    return {
      title: 'Garden picnic',
      description: 'A picnic with fresh produce.',
      location: 'park',
      start: 15 * 60,
      durationMinutes: 120,
      invitees: [],
    };
  return {
    title: 'Village picnic',
    description: 'Snacks and chatter for everyone.',
    location: 'park',
    start: 16 * 60,
    durationMinutes: 120,
    invitees: [],
  };
}

export { newsText };

export const createMind: CreateMind = (profile, deps) => new Mind(profile, deps);
