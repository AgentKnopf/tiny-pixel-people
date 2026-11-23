/**
 * Deterministic mock provider for tests and offline demos. Owned by WP6.
 * Answers by `req.task` using `req.meta` (structured context the prompt builders pass alongside the
 * prompt). See specs/technical-spec.md §13. Same input => same output, no randomness, no I/O.
 *
 * Meta contract (all keys optional; missing keys degrade to generic answers):
 * - common:          villagerId, profile (VillagerProfile), locations (Location[] | LocationId[]), now (GameMinutes)
 * - plan.day:        acceptedEvents (VillageEvent[])
 * - plan.revise:     plan (DayPlan), acceptedEvents
 * - convo.turn:      partnerId, partnerName, news [{ id, text }], transcript (ConversationMessage[])
 * - convo.summarize: participants [aId, bId], offered [{ id, text, by }], transcript, names (Record<id, name>)
 * - event.propose:   villagers [{ id, name, affinity? }]
 * - event.decide:    event (VillageEvent), affinity (number, with the host)
 * - note.reply:      noteText
 * - importance.rate: memories [{ text, kind }]
 * - reflect:         memories [{ text }] (numbered from 1 in the prompt)
 * - day.summarize:   memories [{ text }]
 * - player.reply:    text, canLeaveNote
 * - task.decide:     text
 * v2 (technical-spec-v2.md §11):
 * - plan.day:        day (number) or now; v2 places in `locations` (rides, burger_joint, ice cream trucks,
 *                    forest_grove, post_office) give some villagers outings, keyed on villager + day
 * - visit.greet:     playerName, houseId, affinity, now          -> { reply } naming the player, time of day
 * - letter.reply:    letterText, fromName                         -> { reply } naming the sender, quoting the letter
 * - letter.write:    toName, reason ('thanks' | 'missYou' | 'shy') -> { text } short template per reason
 * - visitor.create:  existingNames, sprites                       -> a pool-style visitor with a unique name
 * - date.ask:        partnerName, venues [{ id, name }], shy      -> the first venue at 17:00
 * - date.decide:     askerName, affinity, locationId, start       -> accept when affinity >= 4
 */
import { formatClock, minuteOfDay, parseClock } from '../../../shared/time.ts';
import { LlmError } from '../errors.ts';
import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  EmbeddingProvider,
  HealthResult,
  LlmTask,
} from '../types.ts';

export type MockHandler = (req: ChatRequest) => string | Promise<string>;

export interface MockCall {
  task: LlmTask;
  meta: Record<string, unknown> | undefined;
  /** Index of the call (0-based) in the order the provider received them. */
  seq: number;
}

type Latency = number | ((req: ChatRequest) => number);

export class MockChatProvider implements ChatProvider {
  readonly kind = 'mock' as const;
  /** Every request received, in order (bounded by `maxRecordedCalls`). */
  readonly calls: MockCall[] = [];
  maxRecordedCalls = 50_000;
  private readonly scripts = new Map<LlmTask, MockHandler>();
  private readonly failures = new Map<LlmTask | '*', { remaining: number; error: () => Error }>();
  private readonly hung = new Set<LlmTask | '*'>();
  private hangingNow = 0;
  private latency: Latency = 0;
  private seq = 0;

  constructor(readonly model: string = 'mock') {}

  /** Override the answer for one task (tests). Pass null to restore the default. */
  setScript(task: LlmTask, handler: MockHandler | null): void {
    if (handler) this.scripts.set(task, handler);
    else this.scripts.delete(task);
  }

  /** Real-time delay before answering (ms), fixed or per request. */
  setLatency(latency: Latency): void {
    this.latency = latency;
  }

  /** Fail the next `count` requests for `task` ('*' = any task). Default error: retryable network error. */
  failNext(task: LlmTask | '*', count = 1, error?: () => Error): void {
    this.failures.set(task, {
      remaining: count,
      error: error ?? (() => new LlmError('network', `mock: injected failure for ${task}`)),
    });
  }

  /**
   * Never answer requests for `task` ('*' = every task): each one stays pending until its AbortSignal
   * fires (the queue's timeout), then rejects as a timeout. Models a hung model server.
   */
  hang(task: LlmTask | '*' = '*'): void {
    this.hung.add(task);
  }

  /** Answer normally again (requests already hanging stay pending until aborted). */
  unhang(task: LlmTask | '*' = '*'): void {
    this.hung.delete(task);
  }

  /** Requests currently hanging. */
  get hanging(): number {
    return this.hangingNow;
  }

  callCount(task?: LlmTask): number {
    return task ? this.calls.filter((c) => c.task === task).length : this.calls.length;
  }

  reset(): void {
    this.calls.length = 0;
    this.scripts.clear();
    this.failures.clear();
    this.hung.clear();
    this.latency = 0;
    this.seq = 0;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const seq = this.seq++;
    if (this.calls.length < this.maxRecordedCalls) this.calls.push({ task: req.task, meta: req.meta, seq });
    if (this.hung.has(req.task) || this.hung.has('*')) {
      this.hangingNow++;
      try {
        await untilAborted(req.signal);
      } finally {
        this.hangingNow--;
      }
      throw new LlmError('timeout', 'mock: hung request aborted');
    }
    const delay = typeof this.latency === 'function' ? this.latency(req) : this.latency;
    if (delay > 0) await sleep(delay, req.signal);
    if (req.signal?.aborted) throw new LlmError('timeout', 'mock: request aborted');
    for (const key of [req.task, '*'] as const) {
      const f = this.failures.get(key);
      if (f && f.remaining > 0) {
        f.remaining--;
        if (f.remaining === 0) this.failures.delete(key);
        throw f.error();
      }
    }
    const handler = this.scripts.get(req.task);
    const text = handler ? await handler(req) : mockAnswer(req);
    const inputChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    return {
      text,
      model: this.model,
      usage: { inputTokens: Math.ceil(inputChars / 4), outputTokens: Math.ceil(text.length / 4) },
      latencyMs: Date.now() - started,
    };
  }

  async health(): Promise<HealthResult> {
    return { ok: true, message: `mock provider (model "${this.model}")` };
  }
}

function untilAborted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

// ---------- Default per-task answers ----------

/** The deterministic default answer for a request (exported for tests and offline demos). */
export function mockAnswer(req: ChatRequest): string {
  const meta = req.meta ?? {};
  switch (req.task) {
    case 'importance.rate':
      return json(rateImportance(meta));
    case 'plan.day':
      return json(dayPlan(meta));
    case 'plan.revise':
      return json(revisePlan(meta));
    case 'convo.turn':
      return json(convoTurn(meta));
    case 'convo.summarize':
      return json(convoSummary(meta));
    case 'reflect':
      return json(reflection(meta));
    case 'reflect.questions':
      return json({ questions: ['What has been on my mind lately?', 'Who have I been spending time with?'] });
    case 'event.propose':
      return json(proposeEvent(meta));
    case 'event.decide':
      return json(decideEvent(meta));
    case 'note.reply':
      return json(noteReply(meta));
    case 'day.summarize':
      return json(daySummary(meta));
    case 'player.reply':
      return json(playerReply(meta));
    case 'task.decide':
      return json(taskDecide(meta));
    case 'stranger.create':
      return json(STRANGER);
    case 'visit.greet':
      return json(visitGreet(meta));
    case 'letter.reply':
      return json(letterReply(meta));
    case 'letter.write':
      return json(letterWrite(meta));
    case 'visitor.create':
      return json(mockVisitor(meta));
    case 'date.ask':
      return json(dateAsk(meta));
    case 'date.decide':
      return json(dateDecide(meta));
    case 'health':
      return json({ ok: true });
  }
}

const json = (v: unknown) => JSON.stringify(v);

// ---------- meta readers (meta is untyped by design) ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const objs = (v: unknown): Obj[] => arr(v).filter(isObj);

interface Loc {
  id: string;
  name: string;
  kind: string;
}

function locations(meta: Obj): Loc[] {
  return arr(meta.locations)
    .map((l): Loc | null => {
      if (typeof l === 'string') return { id: l, name: l, kind: '' };
      if (isObj(l) && typeof l.id === 'string')
        return { id: l.id, name: str(l.name, l.id), kind: str(l.kind) };
      return null;
    })
    .filter((l): l is Loc => l !== null);
}

function findLoc(locs: Loc[], pattern: RegExp): Loc | undefined {
  return locs.find((l) => pattern.test(l.id)) ?? locs.find((l) => pattern.test(l.name));
}

function profileOf(meta: Obj): Obj {
  return isObj(meta.profile) ? meta.profile : {};
}

function villagerId(meta: Obj): string {
  return str(meta.villagerId, str(profileOf(meta).id, 'someone'));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function words(text: string, n: number): string {
  return text.trim().split(/\s+/).slice(0, n).join(' ');
}

function clockOr(v: unknown, d: string): number {
  try {
    return parseClock(str(v, d));
  } catch {
    return parseClock(d);
  }
}

// ---------- importance ----------

const KIND_IMPORTANCE: Record<string, number> = {
  note: 8,
  heard: 5,
  event: 6,
  conversation: 4,
  observation: 2,
  reflection: 7,
  summary: 5,
  plan: 3,
};

function rateImportance(meta: Obj) {
  const ratings = objs(meta.memories).map((m) => KIND_IMPORTANCE[str(m.kind)] ?? 3);
  return { ratings, importance: ratings[0] ?? 3 };
}

// ---------- planning ----------

interface BlockOut {
  start: string;
  end: string;
  location: string;
  activity: string;
  emoji: string;
  eventId?: string;
}

interface Block {
  start: number;
  end: number;
  location: string;
  activity: string;
  emoji: string;
  eventId?: string;
}

const WORKPLACES: [RegExp, RegExp, string, string][] = [
  [/bak/i, /bakery/i, 'Baking bread', '🍞'],
  [/barista|cafe|café|cook|chef/i, /cafe|café/i, 'Serving coffee', '☕'],
  [/farm/i, /farm/i, 'Tending the fields', '🌾'],
  [/garden|florist/i, /park|garden/i, 'Tending the flowers', '🌸'],
  [/shop|merchant|grocer|tailor|smith/i, /shop|store|market/i, 'Minding the shop', '🛍️'],
  [/teach|school/i, /school/i, 'Teaching', '📚'],
  [/librar|writer|author|poet/i, /library|park/i, 'Writing', '✍️'],
  [/fish/i, /pond|lake|river/i, 'Fishing', '🎣'],
  [/artist|paint|music/i, /park|plaza|square/i, 'Making art', '🎨'],
];

function workplace(meta: Obj, locs: Loc[], homeId: string): { loc: string; activity: string; emoji: string } {
  const occupation = str(profileOf(meta).occupation);
  for (const [occ, place, activity, emoji] of WORKPLACES) {
    if (!occ.test(occupation)) continue;
    const loc = findLoc(locs, place);
    if (loc) return { loc: loc.id, activity, emoji };
  }
  const shared = locs.filter((l) => l.kind === 'shop' || l.kind === 'public' || l.kind === 'nature');
  const pick = shared[hash(villagerId(meta)) % Math.max(1, shared.length)];
  return {
    loc: pick?.id ?? homeId,
    activity: occupation ? `Working as ${occupation}` : 'Pottering about',
    emoji: '🛠️',
  };
}

function homeOf(meta: Obj, locs: Loc[]): string {
  const p = profileOf(meta);
  return str(p.homeId) || findLoc(locs, /house|home/i)?.id || locs[0]?.id || 'home';
}

function socialSpot(locs: Loc[], fallback: string): string {
  return (findLoc(locs, /square|plaza/i) ?? findLoc(locs, /park/i) ?? { id: fallback }).id;
}

function eatSpot(locs: Loc[], fallback: string): string {
  return (findLoc(locs, /cafe|café/i) ?? findLoc(locs, /bakery/i) ?? { id: fallback }).id;
}

function toOut(b: Block): BlockOut {
  const out: BlockOut = {
    start: formatClock(b.start),
    end: b.end >= 1440 ? '24:00' : formatClock(b.end),
    location: b.location,
    activity: b.activity,
    emoji: b.emoji,
  };
  if (b.eventId) out.eventId = b.eventId;
  return out;
}

/** Insert `ins`, clipping or splitting blocks it overlaps. */
function insertBlock(blocks: Block[], ins: Block): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.end <= ins.start || b.start >= ins.end) {
      out.push(b);
      continue;
    }
    if (b.start < ins.start) out.push({ ...b, end: ins.start });
    if (b.end > ins.end) out.push({ ...b, start: ins.end });
  }
  out.push(ins);
  return out.sort((a, b) => a.start - b.start);
}

function eventBlocks(meta: Obj): Block[] {
  return objs(meta.acceptedEvents).map((e) => ({
    start: minuteOfDay(num(e.start, 0)),
    end: Math.min(1440, minuteOfDay(num(e.start, 0)) + Math.max(15, num(e.end, 0) - num(e.start, 0))),
    location: str(e.locationId, 'square'),
    activity: `Attending ${str(e.title, 'an event')}`,
    emoji: '🎉',
    eventId: str(e.id),
  }));
}

/** A v2 outing (spec v2 §2.1, §10): a place, a time window and what the villager does there. */
interface Outing {
  match: RegExp;
  /** 'lunch' replaces the lunch block; 'afternoon' starts when work ends. */
  slot: 'lunch' | 'afternoon';
  minutes: number;
  activity: (name: string) => string;
  emoji: string;
}

const OUTINGS: Outing[] = [
  {
    match: /^(rollercoaster|ferris_wheel|carousel)$/,
    slot: 'afternoon',
    minutes: 60,
    activity: (n) => `A ride on the ${n}`,
    emoji: '🎢',
  },
  {
    match: /^burger_joint$/,
    slot: 'lunch',
    minutes: 60,
    activity: () => 'Burger lunch at the zoo',
    emoji: '🍔',
  },
  {
    match: /^ice_cream_truck_\d+$/,
    slot: 'afternoon',
    minutes: 30,
    activity: () => 'An ice cream at the zoo',
    emoji: '🍦',
  },
  {
    match: /^forest_grove$/,
    slot: 'afternoon',
    minutes: 60,
    activity: () => 'A walk and a picnic in the grove',
    emoji: '🌳',
  },
  { match: /^post_office$/, slot: 'afternoon', minutes: 30, activity: () => 'Posting letters', emoji: '✉️' },
  { match: /^zoo_gate$/, slot: 'afternoon', minutes: 60, activity: () => 'A visit to the zoo', emoji: '🦁' },
];

/**
 * About a third of the villagers go on an outing each day, keyed on villager + day so a day's plans
 * are stable. The outing kind rotates by day, so a few days cover every v2 place the map has.
 */
function outingBlock(
  meta: Obj,
  locs: Loc[],
  times: { lunchAt: number; workEnd: number; eveningEnd: number },
): Block | null {
  const available = OUTINGS.map((o) => ({ o, places: locs.filter((l) => o.match.test(l.id)) })).filter(
    (x) => x.places.length > 0,
  );
  if (available.length === 0) return null;
  const id = villagerId(meta);
  const day = typeof meta.day === 'number' ? meta.day : Math.floor(num(meta.now, 0) / 1440);
  const h = hash(id);
  if ((h + day) % 3 !== 0) return null;
  const { o, places } = available[(Math.floor(h / 3) + day) % available.length]!;
  const place = places[hash(`${id}:${day}`) % places.length]!;
  const start = o.slot === 'lunch' ? times.lunchAt : times.workEnd;
  const end = start + o.minutes;
  if (o.slot === 'afternoon' && end > times.eveningEnd) return null;
  const name = place.name === place.id ? place.id.replace(/_/g, ' ') : place.name;
  return { start, end, location: place.id, activity: o.activity(name), emoji: o.emoji };
}

function dayPlan(meta: Obj) {
  const locs = locations(meta);
  const p = profileOf(meta);
  const home = homeOf(meta, locs);
  const wake = clockOr(p.wakeTime, '07:00');
  const sleepAt = Math.max(wake + 8 * 60, clockOr(p.sleepTime, '22:00'));
  const work = workplace(meta, locs, home);
  const social = socialSpot(locs, home);
  const lunchAt = Math.max(12 * 60, wake + 120);
  const lunchEnd = lunchAt + 60;
  const workEnd = Math.max(lunchEnd + 60, 17 * 60);
  const eveningEnd = Math.min(sleepAt, Math.max(workEnd + 60, 19 * 60));
  let blocks: Block[] = [
    { start: wake, end: wake + 60, location: home, activity: 'Breakfast at home', emoji: '🍳' },
    { start: wake + 60, end: lunchAt, location: work.loc, activity: work.activity, emoji: work.emoji },
    { start: lunchAt, end: lunchEnd, location: eatSpot(locs, home), activity: 'Having lunch', emoji: '🥪' },
    { start: lunchEnd, end: workEnd, location: work.loc, activity: work.activity, emoji: work.emoji },
    { start: workEnd, end: eveningEnd, location: social, activity: 'Chatting with neighbours', emoji: '💬' },
    { start: eveningEnd, end: sleepAt, location: home, activity: 'Dinner and a good book', emoji: '📖' },
  ].filter((b) => b.end > b.start);
  const outing = outingBlock(meta, locs, { lunchAt, workEnd, eveningEnd });
  if (outing) blocks = insertBlock(blocks, outing);
  for (const ev of eventBlocks(meta)) blocks = insertBlock(blocks, ev);
  const name = str(p.name, 'I');
  return { summary: `${name} works, has lunch, then catches up with neighbours.`, blocks: blocks.map(toOut) };
}

function revisePlan(meta: Obj) {
  const now = minuteOfDay(num(meta.now, 0));
  const plan = isObj(meta.plan) ? meta.plan : {};
  let blocks: Block[] = objs(plan.blocks)
    .map((b) => ({
      start: num(b.start, 0),
      end: num(b.end, 0),
      location: str(b.locationId, str(b.location)),
      activity: str(b.activity, 'Carrying on'),
      emoji: str(b.emoji, '🙂'),
      ...(typeof b.eventId === 'string' ? { eventId: b.eventId } : {}),
    }))
    .filter((b) => b.end > now)
    .map((b) => ({ ...b, start: Math.max(b.start, now) }));
  for (const ev of eventBlocks(meta)) if (ev.end > now) blocks = insertBlock(blocks, ev);
  return { summary: str(plan.summary, 'Carrying on with my day.'), blocks: blocks.map(toOut) };
}

// ---------- conversation ----------

const SMALL_TALK = [
  "That's interesting, tell me more.",
  'I know what you mean.',
  'Ha, that sounds just like this village.',
  'Well, I should get going soon.',
  'Lovely talking to you!',
];

function convoTurn(meta: Obj) {
  const self = villagerId(meta);
  const transcript = objs(meta.transcript);
  const mine = transcript.filter((m) => m.speakerId === self).length;
  const partner = str(meta.partnerName, 'friend');
  const news = objs(meta.news);
  const first = news[0];
  let say: string;
  if (mine === 0 && first && str(first.text)) say = `Did you hear? ${str(first.text)}`;
  else if (mine === 0) say = `Hi ${partner}! How is your day going?`;
  else say = SMALL_TALK[(mine - 1 + (hash(self) % 2)) % SMALL_TALK.length]!;
  return { say, end: transcript.length >= 3 };
}

/** Text without a leading "Did you hear?" so learned facts stay verbatim. */
function stripLead(text: string): string {
  return text.replace(/^\s*did you hear\?\s*/i, '').trim();
}

function convoSummary(meta: Obj) {
  const [a = 'a', b = 'b'] = arr(meta.participants).map((p) => str(p));
  const names = isObj(meta.names) ? meta.names : {};
  const offered = objs(meta.offered);
  const transcript = objs(meta.transcript);
  const said = (by: string, text: string) =>
    transcript.length === 0 ||
    transcript.some((m) => m.speakerId === by && str(m.text).includes(stripLead(text)));
  const learnedFrom = (speaker: string) =>
    offered
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => str(o.by) === speaker && str(o.text) && said(speaker, str(o.text)))
      .map(({ o, i }) => ({ text: stripLead(str(o.text)), importance: 5, fromNewsIndex: i }));
  const side = (other: string) => {
    const learned = learnedFrom(other);
    const otherName = str(names[other], other);
    return {
      summary: learned.length
        ? `I talked with ${otherName}. They told me: ${learned.map((l) => l.text).join(' ')}`
        : `I had a friendly chat with ${otherName}.`,
      learned,
      affinityDelta: 1,
    };
  };
  return { forA: side(b), forB: side(a) };
}

// ---------- reflection / summaries ----------

function reflection(meta: Obj) {
  const first = objs(meta.memories)[0];
  const text = first
    ? `I keep thinking about this: ${words(str(first.text), 12)}`
    : 'Life in the village is good.';
  return { insights: [{ text, because: [1] }] };
}

function daySummary(meta: Obj) {
  const items = objs(meta.memories)
    .slice(0, 3)
    .map((m) => words(str(m.text), 10));
  return { summary: items.length ? `Today: ${items.join('; ')}.` : 'A quiet day in the village.' };
}

// ---------- events ----------

function proposeEvent(meta: Obj) {
  const locs = locations(meta);
  const self = villagerId(meta);
  const p = profileOf(meta);
  const baker = /bak/i.test(str(p.occupation)) || /bak/i.test(str(p.bio));
  const now = minuteOfDay(num(meta.now, 9 * 60));
  const earliest = Math.ceil((now + 90) / 30) * 30;
  const start = Math.min(Math.max(15 * 60, earliest), 20 * 60);
  const invitees = objs(meta.villagers)
    .filter((v) => str(v.id) !== self && str(v.name))
    .sort((x, y) => num(y.affinity, 0) - num(x.affinity, 0) || str(x.name).localeCompare(str(y.name)))
    .slice(0, 5)
    .map((v) => str(v.name));
  return {
    title: baker ? 'Bake-off' : 'Picnic',
    description: baker
      ? 'A friendly bake-off with fresh bread and cakes for everyone.'
      : 'An afternoon picnic with snacks and good company.',
    location: socialSpot(locs, 'square'),
    start: formatClock(start),
    durationMinutes: 120,
    invitees,
  };
}

function decideEvent(meta: Obj) {
  const affinity = num(meta.affinity, 0);
  const title = isObj(meta.event) ? str(meta.event.title, 'the event') : 'the event';
  return affinity >= 0
    ? { accept: true, reason: `I'd love to go to ${title}.` }
    : { accept: false, reason: `I'd rather not go to ${title}.` };
}

// ---------- notes and the player ----------

function noteReply(meta: Obj) {
  const note = str(meta.noteText);
  return {
    reply: note
      ? `Thanks for your note about '${words(note, 6)}'! I'll keep it in mind.`
      : 'Thanks for your note!',
  };
}

function playerReply(meta: Obj) {
  const text = str(meta.text);
  const out: { reply: string; leaveNote?: string } = {
    reply: text ? `You said "${words(text, 6)}"? How nice of you to tell me!` : 'Oh, hello there!',
  };
  if (meta.canLeaveNote === true) out.leaveNote = `I was thinking about what you said: "${words(text, 6)}".`;
  return out;
}

function taskDecide(meta: Obj) {
  const text = str(meta.text);
  const locs = locations(meta);
  const lower = text.toLowerCase();
  const match =
    locs.find((l) => lower.includes(l.id.toLowerCase()) || lower.includes(l.name.toLowerCase())) ??
    (locs.find((l) => l.id === homeOf(meta, locs)) || locs[0]);
  const now = minuteOfDay(num(meta.now, 9 * 60));
  const time = Math.min(Math.ceil((now + 30) / 15) * 15, 21 * 60);
  return {
    accept: true,
    activity: words(text, 10) || 'Helping out',
    location: match?.id ?? homeOf(meta, locs),
    time: formatClock(time),
    durationMinutes: 60,
  };
}

const STRANGER = {
  name: 'Quill',
  age: 41,
  occupation: 'travelling map maker',
  bio: 'Quill wanders from town to town drawing maps. Quill loves stories and trades news for a warm meal.',
  traits: ['curious', 'chatty'],
  news: 'A new road to the coast will open next spring.',
};

// ---------- embeddings ----------

/** Deterministic hashed bag-of-words embeddings (unit length). */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'mock' as const;

  constructor(
    readonly model: string = 'mock-embed',
    readonly dimensions = 64,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashEmbed(t, this.dimensions));
  }
}

export function hashEmbed(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const idx = hash(word) % dims;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

function mockVisitor(meta: Obj): Record<string, unknown> {
  const taken = new Set(arr(meta.existingNames).map((n) => str(n)));
  let n = 1;
  while (taken.has(`Visitor ${n}`)) n += 1;
  const sprites = arr(meta.sprites)
    .map((s) => str(s))
    .filter(Boolean);
  return {
    name: `Visitor ${n}`,
    age: 35,
    occupation: 'Traveller',
    bio: 'A friendly traveller who came by train to see the zoo and the forest.',
    traits: ['curious', 'friendly'],
    sprite: sprites[0] ?? 'characters/stranger.png',
    origin: 'the city',
    reason: 'a short holiday',
    likes: ['ice_cream'],
  };
}

// ---------- v2: visits, letters, dates ----------

function timeOfDay(now: unknown): string {
  const m = minuteOfDay(num(now, 10 * 60));
  if (m < 12 * 60) return 'morning';
  if (m < 18 * 60) return 'afternoon';
  return 'evening';
}

function visitGreet(meta: Obj) {
  const player = str(meta.playerName, 'friend');
  const warm = num(meta.affinity, 0) >= 3 ? ' So lovely to see you again.' : '';
  return { reply: `Good ${timeOfDay(meta.now)}, ${player}! Come on in, make yourself at home.${warm}` };
}

function letterReply(meta: Obj) {
  const from = str(meta.fromName, 'friend');
  const letter = str(meta.letterText);
  return {
    reply: letter
      ? `Dear ${from}, thank you for your letter about '${words(letter, 6)}'! I'll keep it in mind.`
      : `Dear ${from}, thank you for your letter!`,
  };
}

const LETTER_TEMPLATES: Record<string, (to: string) => string> = {
  thanks: (to) => `Dear ${to}, thank you so much for the lovely gift. It made my day!`,
  missYou: (to) => `Dear ${to}, I haven't seen you in a while and I miss our chats. Come by soon!`,
  shy: (to) => `Dear ${to}, I wanted to say that I always enjoy our talks. See you around?`,
};

function letterWrite(meta: Obj) {
  const to = str(meta.toName, 'friend');
  const template = LETTER_TEMPLATES[str(meta.reason)] ?? ((t: string) => `Dear ${t}, I hope you are well!`);
  return { text: template(to) };
}

function dateAsk(meta: Obj) {
  const venues = objs(meta.venues).filter((v) => str(v.id));
  const venue = venues[0];
  const partner = str(meta.partnerName, 'you');
  const place = venue ? str(venue.name, str(venue.id)) : 'the square';
  return {
    text:
      meta.shy === true
        ? `Um, ${partner}... would you maybe like to visit ${place} with me at 17:00?`
        : `${partner}, would you like to go to ${place} with me at 17:00?`,
    locationId: venue ? str(venue.id) : 'square',
    start: '17:00',
  };
}

function dateDecide(meta: Obj) {
  const asker = str(meta.askerName, 'you');
  return num(meta.affinity, 0) >= 4
    ? { accept: true, reply: `I'd love to, ${asker}!` }
    : { accept: false, reply: `That's kind of you, ${asker}, but not this time.` };
}
