/**
 * Day planning (spec §7.4, §7.10, §7.13): deterministic fallback plans, validation of model plans,
 * block insertion for events/tasks, need overrides and rain swaps.
 */
import { MINUTES_PER_DAY, dayOf, formatClock, minuteOfDay, parseClock } from '../../shared/time.ts';
import type {
  DayPlan,
  GameMinutes,
  Location,
  LocationId,
  Needs,
  PlanBlock,
  VillageEvent,
  VillagerId,
  VillagerProfile,
  Weather,
} from '../../shared/types.ts';
import { asArray, asRecord, asString, parseClockLoose, pick } from './json.ts';
import { extractKeywords, keywordOverlap } from './keywords.ts';

// ---------- waking hours ----------

export interface WakeWindow {
  wake: number;
  /** Minute of day the villager goes to bed (may be < wake when bedtime is after midnight). */
  sleep: number;
}

export function wakeWindow(profile: Pick<VillagerProfile, 'wakeTime' | 'sleepTime'>): WakeWindow {
  const safe = (s: string, d: string) => {
    try {
      return parseClock(s);
    } catch {
      return parseClock(d);
    }
  };
  return { wake: safe(profile.wakeTime, '06:00'), sleep: safe(profile.sleepTime, '22:00') % MINUTES_PER_DAY };
}

export function isAwake(w: WakeWindow, mod: number): boolean {
  return w.wake < w.sleep ? mod >= w.wake && mod < w.sleep : mod >= w.wake || mod < w.sleep;
}

/** Last minute of the plan window (plans stay within one calendar day). */
export function planEnd(w: WakeWindow): number {
  return w.sleep > w.wake ? w.sleep : MINUTES_PER_DAY;
}

/** The day whose waking period this moment belongs to (or the next one, while asleep at night). */
export function planDayFor(w: WakeWindow, t: GameMinutes): number {
  const mod = minuteOfDay(t);
  const day = dayOf(t);
  if (isAwake(w, mod)) return w.wake < w.sleep || mod >= w.wake ? day : day - 1;
  return mod >= w.wake ? day + 1 : day;
}

// ---------- locations ----------

const HOME_WORDS = /^(home|my home|my house|house|my place|bed|bedroom|kitchen|my cottage)$/i;

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Map a model-written location to a known id; null when nothing is close. */
export function resolveLocation(
  name: unknown,
  locations: readonly Location[],
  homeId: LocationId,
): LocationId | null {
  const raw = asString(name);
  if (!raw) return null;
  const n = norm(raw);
  if (!n) return null;
  if (HOME_WORDS.test(n) || n === norm(homeId)) return homeId;
  for (const l of locations) if (l.id.toLowerCase() === raw.toLowerCase() || norm(l.id) === n) return l.id;
  for (const l of locations) if (norm(l.name) === n) return l.id;
  for (const l of locations) {
    const a = norm(l.name);
    const b = norm(l.id);
    if (
      (a.length > 2 && (n.includes(a) || a.includes(n))) ||
      (b.length > 2 && (n.includes(b) || b.includes(n)))
    )
      if (l.kind !== 'house' || l.id === homeId) return l.id;
  }
  const kw = extractKeywords(n);
  let best: { id: LocationId; score: number } | null = null;
  for (const l of locations) {
    if (l.kind === 'house' && l.id !== homeId && !kw.some((k) => norm(l.name).includes(k))) continue;
    const lk = extractKeywords(`${l.id.replace(/_/g, ' ')} ${l.name} ${l.description ?? ''}`);
    const score = keywordOverlap(kw, lk);
    if (score > 0 && (!best || score > best.score)) best = { id: l.id, score };
  }
  if (best) return best.id;
  if (/\b(house|home|cottage)\b/.test(n)) return homeId;
  return null;
}

const OCCUPATION_PLACES: [RegExp, RegExp][] = [
  [/bak|pastr|bread/i, /bak/i],
  [/caf|barista|coffee|cook|chef|waiter|waitress/i, /caf|coffee|diner|restaurant/i],
  [/farm|garden|grow/i, /farm|field|garden|orchard/i],
  [/shop|store|merchant|grocer|seller|tailor|smith|florist|book/i, /shop|store|market|street|flor|book/i],
  [/teach|school/i, /school/i],
  [/postm|postal|post office|mail ?carrier/i, /^post/i],
  [/librar/i, /librar/i],
  [/fish/i, /pond|lake|dock|river/i],
  [/doctor|nurse|clinic/i, /clinic|doctor/i],
  [/artist|paint|musician|poet|writer/i, /park|plaza|square/i],
  [/mayor|council/i, /hall|plaza|square/i],
];

function locMatches(l: Location, re: RegExp): boolean {
  return re.test(l.id) || re.test(l.name) || re.test(l.description ?? '');
}

export function findByPattern(
  locations: readonly Location[],
  re: RegExp,
  kinds?: Location['kind'][],
): Location | undefined {
  return locations.find((l) => (!kinds || kinds.includes(l.kind)) && locMatches(l, re));
}

export function socialPlace(locations: readonly Location[]): Location | undefined {
  return (
    findByPattern(locations, /plaza|square|fountain|centre|center/i) ??
    locations.find((l) => l.kind === 'public')
  );
}

export function foodPlace(locations: readonly Location[]): Location | undefined {
  return findByPattern(locations, /caf|bak|diner|restaurant|tavern|inn/i, ['shop', 'public']);
}

export function funPlace(locations: readonly Location[]): Location | undefined {
  return findByPattern(locations, /park|pond|garden|meadow/i) ?? locations.find((l) => l.kind === 'nature');
}

/** Where this villager works, from ownership and occupation keywords. */
const placeKw = new WeakMap<Location, string[]>();

function placeKeywords(l: Location): string[] {
  let kw = placeKw.get(l);
  if (!kw)
    placeKw.set(l, (kw = extractKeywords(`${l.id.replace(/_/g, ' ')} ${l.name} ${l.description ?? ''}`)));
  return kw;
}

const workCache = new WeakMap<readonly Location[], WeakMap<VillagerProfile, LocationId>>();

/** Pure in (profile, locations); cached because the keyword fallback stems every location's text. */
export function workLocation(profile: VillagerProfile, locations: readonly Location[]): LocationId {
  let byProfile = workCache.get(locations);
  if (!byProfile) workCache.set(locations, (byProfile = new WeakMap()));
  let id = byProfile.get(profile);
  if (id === undefined) byProfile.set(profile, (id = findWorkLocation(profile, locations)));
  return id;
}

function findWorkLocation(profile: VillagerProfile, locations: readonly Location[]): LocationId {
  const owned = locations.find((l) => l.kind !== 'house' && l.ownerIds?.includes(profile.id));
  if (owned) return owned.id;
  for (const [occ, place] of OCCUPATION_PLACES) {
    if (!occ.test(profile.occupation)) continue;
    const l = locations.find((x) => x.kind !== 'house' && locMatches(x, place));
    if (l) return l.id;
  }
  const kw = extractKeywords(`${profile.occupation} ${profile.bio}`);
  let best: { id: LocationId; s: number } | null = null;
  for (const l of locations) {
    // Only an explicit postal occupation works at the post office (a postcard illustrator does not).
    if (l.kind === 'house' || l.kind === 'post') continue;
    const s = keywordOverlap(placeKeywords(l), kw);
    if (s > 0 && (!best || s > best.s)) best = { id: l.id, s };
  }
  return best?.id ?? socialPlace(locations)?.id ?? profile.homeId;
}

// ---------- emoji ----------

const EMOJI_RULES: [RegExp, string][] = [
  [/sleep|bed|nap/i, '😴'],
  [/bak|bread|cake|pie|pastr|oven/i, '🍞'],
  [/coffee|tea|breakfast|caf/i, '☕'],
  [/lunch|dinner|eat|meal|snack|bite|food|cook/i, '🍲'],
  [/farm|plant|water|harvest|garden|crop/i, '🌱'],
  [/read|book|stud|librar/i, '📖'],
  [/paint|draw|art|sketch/i, '🎨'],
  [/music|sing|guitar|piano|song/i, '🎵'],
  [/fish/i, '🎣'],
  [/walk|stroll|wander/i, '🚶'],
  [/shop|sell|store|market|count/i, '🛍️'],
  [/chat|talk|gossip|visit|friend|meet/i, '💬'],
  [/party|celebrat|festival|bake-?off|picnic|event|host/i, '🎉'],
  [/write|letter|note|journal/i, '✍️'],
  [/clean|tidy|wash/i, '🧹'],
  [/teach|class|school/i, '🏫'],
  [/relax|rest|park|pond|sit/i, '🌳'],
];

export function emojiFor(activity: string): string {
  for (const [re, e] of EMOJI_RULES) if (re.test(activity)) return e;
  return '🙂';
}

function cleanEmoji(v: unknown, activity: string): string {
  const s = asString(v);
  if (s && s.length <= 8 && /\p{Extended_Pictographic}/u.test(s)) return s;
  return emojiFor(activity);
}

// ---------- block operations ----------

export function sortBlocks(blocks: PlanBlock[]): PlanBlock[] {
  return blocks.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Validate blocks into a clean timeline from wake to bedtime: clamp, sort, clip overlaps, fill gaps
 * with "relax at home". Blocks with eventId/taskId win overlaps.
 */
export function normalizeBlocks(input: readonly PlanBlock[], w: WakeWindow, homeId: LocationId): PlanBlock[] {
  const lo = w.wake;
  const hi = planEnd(w);
  const pinned = input.filter((b) => b.eventId || b.taskId);
  let blocks = sortBlocks(
    input
      .map((b) => ({ ...b, start: Math.max(lo, Math.round(b.start)), end: Math.min(hi, Math.round(b.end)) }))
      .filter((b) => b.end - b.start >= 5 && !b.eventId && !b.taskId),
  );
  const out: PlanBlock[] = [];
  for (const b of blocks) {
    const prev = out.at(-1);
    if (prev && b.start < prev.end) {
      if (b.end <= prev.end) continue;
      b.start = prev.end;
    }
    if (b.end - b.start >= 5) out.push(b);
  }
  blocks = out;
  for (const p of pinned)
    blocks = insertBlock(blocks, { ...p, start: Math.max(lo, p.start), end: Math.min(hi, p.end) });
  const filled: PlanBlock[] = [];
  let cursor = lo;
  for (const b of sortBlocks(blocks)) {
    if (b.start > cursor + 4) filled.push(idleBlock(cursor, b.start, homeId));
    filled.push(b);
    cursor = Math.max(cursor, b.end);
  }
  if (hi > cursor + 4) filled.push(idleBlock(cursor, hi, homeId));
  return filled;
}

function idleBlock(start: number, end: number, homeId: LocationId): PlanBlock {
  return { start, end, locationId: homeId, activity: 'relax at home', emoji: '🏠' };
}

/** Insert a block, overriding (splitting or clipping) whatever it overlaps. */
export function insertBlock(blocks: readonly PlanBlock[], block: PlanBlock): PlanBlock[] {
  const out: PlanBlock[] = [];
  for (const b of blocks) {
    if (b.end <= block.start || b.start >= block.end) {
      out.push(b);
      continue;
    }
    if (b.start < block.start) out.push({ ...b, end: block.start });
    if (b.end > block.end) out.push({ ...b, start: block.end });
  }
  out.push(block);
  return sortBlocks(out.filter((b) => b.end - b.start >= 1));
}

/**
 * A day plan takes the villager to at least two places, so the plan is visible on the map. A
 * one-place plan (model or fallback) gets a short break somewhere it does not already use: lunch
 * at the bakery or on the square, or an evening walk in the park. The break goes after minute
 * `from` when it fits there, and never over an event or task block.
 */
export function ensureVariety(
  blocks: readonly PlanBlock[],
  w: WakeWindow,
  locations: readonly Location[],
  from = 0,
): PlanBlock[] {
  const used = new Set(blocks.map((b) => b.locationId));
  if (used.size >= 2 || blocks.length === 0) return [...blocks];
  const unused = (l: Location | undefined) => (l && l.kind !== 'house' && !used.has(l.id) ? l : undefined);
  const lo = w.wake + 30;
  const hi = planEnd(w) - 15;
  const mid = Math.round((lo + hi) / 2 / 15) * 15;
  const options: { loc: Location | undefined; activity: string; emoji: string; slots: number[] }[] = [
    { loc: unused(foodPlace(locations)), activity: 'have lunch', emoji: '🍲', slots: [720, 780] },
    {
      loc: unused(socialPlace(locations)),
      activity: 'eat lunch on the square',
      emoji: '🍲',
      slots: [720, 780],
    },
    {
      loc: unused(funPlace(locations)),
      activity: 'take an evening walk',
      emoji: '🚶',
      slots: [1080, 1020, 1140],
    },
    {
      loc: locations.find((l) => unused(l)),
      activity: 'take a short walk',
      emoji: '🚶',
      slots: [720, 1080, mid],
    },
  ];
  const pinned = blocks.filter((b) => b.eventId || b.taskId);
  const fits = (s: number) => s >= lo && s + 60 <= hi && !pinned.some((p) => p.start < s + 60 && p.end > s);
  for (const later of [true, false])
    for (const o of options) {
      if (!o.loc) continue;
      const start = [...o.slots, mid].find((s) => fits(s) && (!later || s >= from));
      if (start === undefined) continue;
      return insertBlock(blocks, {
        start,
        end: start + 60,
        locationId: o.loc.id,
        activity: o.activity,
        emoji: o.emoji,
      });
    }
  return [...blocks];
}

export function blockAt(plan: DayPlan | null, mod: number): PlanBlock | undefined {
  return plan?.blocks.find((b) => mod >= b.start && mod < b.end);
}

// ---------- parsing model plans ----------

export interface ParsedPlan {
  summary: string;
  blocks: PlanBlock[];
  proposeEvent?: RawEventProposal;
}

export interface RawEventProposal {
  title: string;
  description: string;
  location: string;
  start?: number;
  durationMinutes?: number;
  invitees: string[];
}

export function parseEventProposal(raw: unknown): RawEventProposal | null {
  const r = asRecord(raw);
  const title = asString(pick(r, 'title', 'name', 'event'));
  if (!r || !title) return null;
  const startRaw = parseClockLoose(pick(r, 'start', 'time', 'startTime', 'at'));
  const dur = Number(asString(pick(r, 'durationMinutes', 'duration', 'minutes')) ?? NaN);
  return {
    title: title.slice(0, 60),
    description: (asString(pick(r, 'description', 'details', 'desc')) ?? title).slice(0, 200),
    location: asString(pick(r, 'location', 'place', 'where', 'locationId')) ?? '',
    ...(startRaw !== undefined ? { start: startRaw } : {}),
    ...(Number.isFinite(dur) && dur > 0 ? { durationMinutes: dur } : {}),
    invitees: asArray(pick(r, 'invitees', 'invite', 'guests', 'invited'))
      .map((x) => asString(x) ?? asString(pick(asRecord(x), 'name', 'id')))
      .filter((x): x is string => !!x),
  };
}

/** Lenient parse of `{ summary, blocks: [...] }`; null when there are no usable blocks. */
export function parsePlan(
  raw: unknown,
  locations: readonly Location[],
  homeId: LocationId,
): ParsedPlan | null {
  const r = asRecord(raw);
  const list = Array.isArray(raw)
    ? raw
    : asArray(pick(r, 'blocks', 'plan', 'schedule', 'activities', 'items'));
  const blocks: PlanBlock[] = [];
  for (const raw of list) {
    // Compact form: ["07:00","11:00","bakery","bake bread"(, "🍞")].
    const item = Array.isArray(raw)
      ? { start: raw[0], end: raw[1], location: raw[2], activity: raw[3], emoji: raw[4] }
      : raw;
    const b = asRecord(item);
    if (!b) continue;
    const start = parseClockLoose(pick(b, 'start', 'from', 'startTime', 'time', 'begin'));
    let end = parseClockLoose(pick(b, 'end', 'to', 'endTime', 'until', 'finish'));
    const activity = asString(pick(b, 'activity', 'action', 'task', 'what', 'description', 'title'));
    if (start === undefined || !activity) continue;
    if (end === undefined) {
      const dur = Number(asString(pick(b, 'durationMinutes', 'duration')) ?? 60);
      end = start + (Number.isFinite(dur) && dur > 0 ? dur : 60);
    }
    const loc = resolveLocation(pick(b, 'location', 'place', 'where', 'locationId', 'at'), locations, homeId);
    blocks.push({
      start,
      end,
      locationId: loc ?? homeId,
      activity: activity.replace(/\s+/g, ' ').slice(0, 80),
      emoji: cleanEmoji(pick(b, 'emoji', 'icon'), activity),
    });
  }
  if (blocks.length === 0) return null;
  const summary = asString(pick(r, 'summary', 'goal', 'overview')) ?? '';
  const proposal = parseEventProposal(pick(r, 'proposeEvent', 'propose_event', 'event'));
  return { summary: summary.slice(0, 200), blocks, ...(proposal ? { proposeEvent: proposal } : {}) };
}

// ---------- fallback plan ----------

export function eventBlock(event: VillageEvent, selfId: VillagerId): PlanBlock {
  const start = minuteOfDay(event.start);
  const end = dayOf(event.end) > dayOf(event.start) ? MINUTES_PER_DAY : minuteOfDay(event.end);
  const hosting = event.hostId === selfId;
  return {
    start,
    end: Math.max(start + 15, end),
    locationId: event.locationId,
    activity: `${hosting ? 'host' : 'attend'} ${event.title}`.slice(0, 80),
    emoji: '🎉',
    eventId: event.id,
  };
}

/** Deterministic plan from the profile: home → work → lunch → work → plaza → home. */
export function fallbackBlocks(profile: VillagerProfile, locations: readonly Location[]): PlanBlock[] {
  const w = wakeWindow(profile);
  const end = planEnd(w);
  const work = workLocation(profile, locations);
  const food = foodPlace(locations)?.id ?? profile.homeId;
  const social = socialPlace(locations)?.id ?? profile.homeId;
  const occ = profile.occupation.toLowerCase();
  const workAct = work === profile.homeId ? `work on ${occ} tasks at home` : `work as ${occ}`;
  const raw: PlanBlock[] = [
    {
      start: w.wake,
      end: w.wake + 60,
      locationId: profile.homeId,
      activity: 'wake up, wash and have breakfast',
      emoji: '☕',
    },
    { start: w.wake + 60, end: 720, locationId: work, activity: workAct, emoji: emojiFor(workAct) },
    { start: 720, end: 780, locationId: food, activity: 'have lunch', emoji: '🍲' },
    { start: 780, end: 1020, locationId: work, activity: workAct, emoji: emojiFor(workAct) },
    { start: 1020, end: 1140, locationId: social, activity: 'chat with neighbours', emoji: '💬' },
    {
      start: 1140,
      end,
      locationId: profile.homeId,
      activity: 'dinner and a quiet evening at home',
      emoji: '🍲',
    },
  ];
  return ensureVariety(normalizeBlocks(raw, w, profile.homeId), w, locations);
}

export function makePlan(
  day: number,
  summary: string,
  blocks: PlanBlock[],
  source: DayPlan['source'],
  createdAt: GameMinutes,
  revision = 0,
): DayPlan {
  return { day, summary, blocks, revision, source, createdAt };
}

export function withEvents(
  blocks: PlanBlock[],
  events: readonly VillageEvent[],
  selfId: VillagerId,
  day: number,
): PlanBlock[] {
  let out = blocks;
  for (const e of events) {
    if (dayOf(e.start) !== day || e.status === 'cancelled' || e.status === 'done') continue;
    if (e.hostId !== selfId && !e.accepted.includes(selfId)) continue;
    if (out.some((b) => b.eventId === e.id)) continue;
    out = insertBlock(out, eventBlock(e, selfId));
  }
  return out;
}

// ---------- overrides at execution time ----------

const ADDRESSES: Record<keyof Needs, RegExp> = {
  hunger: /\beat|lunch|breakfast|dinner|snack|bite|meal|food|picnic/i,
  energy: /sleep|nap|rest|relax|lie down/i,
  social: /talk|chat|visit|friend|party|meet|gossip|event|host|attend|neighbou?r/i,
  fun: /play|fun|relax|park|party|game|hobby|paint|music|read|stroll|fish|festival|picnic|dance/i,
};

/** A short corrective block when a need is below 20 and the current block does not address it. */
export function needOverride(
  needs: Needs,
  current: PlanBlock | undefined,
  locations: readonly Location[],
  homeId: LocationId,
  mod: number,
  recentlyFixed: (need: keyof Needs) => boolean,
  /** Where to eat from the villager's current position (default: the first café or bakery). */
  food?: () => { locationId: LocationId; activity: string; emoji: string },
  /** How far the villager is from a place; with `food`, a planned meal farther away than it does not count. */
  distance?: (locationId: LocationId) => number,
): { need: keyof Needs; block: PlanBlock } | null {
  if (current?.eventId || current?.taskId) return null;
  const order: (keyof Needs)[] = ['energy', 'hunger', 'social', 'fun'];
  for (const need of order) {
    if (needs[need] >= 20 || recentlyFixed(need)) continue;
    const stop = need === 'hunger' && food ? food() : null;
    if (
      current &&
      ADDRESSES[need].test(current.activity) &&
      // A starving hotel guest must not cross the map for a planned lunch at the bakery.
      !(stop && distance && distance(current.locationId) > distance(stop.locationId))
    )
      continue;
    const plan: Record<keyof Needs, { loc: LocationId; activity: string; emoji: string }> = {
      hunger: stop
        ? (({ locationId, ...rest }) => ({ loc: locationId, ...rest }))(stop)
        : { loc: foodPlace(locations)?.id ?? homeId, activity: 'grab a bite to eat', emoji: '🥐' },
      energy: { loc: homeId, activity: 'take a nap', emoji: '😴' },
      social: {
        loc: socialPlace(locations)?.id ?? homeId,
        activity: 'look for someone to chat with',
        emoji: '💬',
      },
      fun: { loc: funPlace(locations)?.id ?? homeId, activity: 'stroll and play in the park', emoji: '🌳' },
    };
    const p = plan[need];
    return {
      need,
      block: {
        start: mod,
        end: Math.min(MINUTES_PER_DAY, mod + 45),
        locationId: p.loc,
        activity: p.activity,
        emoji: p.emoji,
      },
    };
  }
  return null;
}

function dist(a: Location, b: Location): number {
  return Math.abs(a.entry.x - b.entry.x) + Math.abs(a.entry.y - b.entry.y);
}

/** Outdoor (public/nature) blocks move indoors while it rains; returns the block unchanged otherwise. */
export function rainSafe(
  block: PlanBlock,
  weather: Weather | undefined,
  locations: readonly Location[],
  homeId: LocationId,
): PlanBlock {
  if (weather?.state !== 'rain' || block.eventId) return block;
  const here = locations.find((l) => l.id === block.locationId);
  if (!here || here.kind === 'house' || here.kind === 'shop') return block;
  const indoor = locations.filter((l) => l.kind === 'shop').sort((a, b) => dist(here, a) - dist(here, b))[0];
  const target = indoor?.id ?? homeId;
  const name = indoor?.name ?? 'home';
  return { ...block, locationId: target, activity: `wait out the rain at ${name}`.slice(0, 80), emoji: '☔' };
}

export function describeBlocks(blocks: readonly PlanBlock[]): string {
  return blocks
    .map((b) => `${formatClock(b.start)}-${formatClock(b.end)} ${b.activity} @ ${b.locationId}`)
    .join('\n');
}
