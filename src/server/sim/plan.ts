import { MINUTES_PER_DAY, dayOf, minuteOfDay, parseClock } from '../../shared/time.ts';
import type {
  DayPlan,
  GameMinutes,
  Location,
  PlanBlock,
  VillageEvent,
  VillagerId,
  VillagerProfile,
} from '../../shared/types.ts';
import type { Intent } from '../cognition/types.ts';

/** Occupation keyword → work location id. First match wins. */
const WORK_RULES: readonly [RegExp, string, string, string][] = [
  [/bak|pastry|cook|chef|barista|caf/i, 'bakery', 'work at the bakery', '🍞'],
  [/farm|garden|beekeep|grow/i, 'farm', 'tend the fields', '🌱'],
  [/shop|store|grocer|merchant|tailor|seamstress/i, 'shop', 'mind the store', '🛍️'],
  [/fish|paint|artist|poet|writer|retired|storyteller/i, 'park', 'spend time by the pond', '🎨'],
  [
    /music|singer|mayor|courier|post|teacher|doctor|nurse|carpenter|smith|florist|student/i,
    'square',
    'work around the square',
    '🏛️',
  ],
];

export interface WorkPlace {
  locationId: string;
  activity: string;
  emoji: string;
}

export function workPlaceFor(profile: VillagerProfile, locations: readonly Location[]): WorkPlace {
  const has = (id: string) => locations.some((l) => l.id === id);
  for (const [re, id, activity, emoji] of WORK_RULES) {
    if (re.test(profile.occupation) && has(id)) {
      return { locationId: id, activity: `${activity} (${profile.occupation})`, emoji };
    }
  }
  const fallback = has('square') ? 'square' : profile.homeId;
  return { locationId: fallback, activity: `go about the day (${profile.occupation})`, emoji: '🚶' };
}

export interface AwakeWindow {
  wake: number;
  sleep: number;
}

export function awakeWindow(profile: VillagerProfile): AwakeWindow {
  return { wake: parseClock(profile.wakeTime), sleep: parseClock(profile.sleepTime) };
}

/** True when the villager should be awake at this game time (handles sleep times after midnight). */
export function isAwakeAt(profile: VillagerProfile, t: GameMinutes): boolean {
  const { wake, sleep } = awakeWindow(profile);
  const m = minuteOfDay(t);
  return wake <= sleep ? m >= wake && m < sleep : m >= wake || m < sleep;
}

/**
 * Deterministic day plan from the profile alone (spec §6): home → work → lunch → work → leisure →
 * home. Used before an LLM plan arrives and whenever planning fails.
 */
export function buildFallbackPlan(
  profile: VillagerProfile,
  day: number,
  locations: readonly Location[],
  now: GameMinutes = day * MINUTES_PER_DAY,
): DayPlan {
  const { wake, sleep: rawSleep } = awakeWindow(profile);
  const sleep = rawSleep <= wake ? MINUTES_PER_DAY - 1 : rawSleep;
  const has = (id: string) => locations.some((l) => l.id === id);
  const work = workPlaceFor(profile, locations);
  const lunchLoc = has('bakery') ? 'bakery' : profile.homeId;
  const leisureLoc = /quiet|shy|bookish|calm|gentle/i.test(profile.traits.join(' '))
    ? has('park')
      ? 'park'
      : profile.homeId
    : has('square')
      ? 'square'
      : profile.homeId;
  const raw: Omit<PlanBlock, 'start' | 'end'>[] = [];
  const marks: number[] = [];
  const push = (at: number, b: Omit<PlanBlock, 'start' | 'end'>) => {
    if (at >= sleep) return;
    marks.push(Math.max(at, wake));
    raw.push(b);
  };
  push(wake, { locationId: profile.homeId, activity: 'wake up and have breakfast', emoji: '☕' });
  push(Math.max(wake + 60, 8 * 60), {
    locationId: work.locationId,
    activity: work.activity,
    emoji: work.emoji,
  });
  push(12 * 60, { locationId: lunchLoc, activity: 'have lunch', emoji: '🥪' });
  push(13 * 60, { locationId: work.locationId, activity: work.activity, emoji: work.emoji });
  push(17 * 60, {
    locationId: leisureLoc,
    activity:
      leisureLoc === 'park' ? 'take an evening stroll in the park' : 'chat with neighbours on the square',
    emoji: leisureLoc === 'park' ? '🌳' : '💬',
  });
  push(19 * 60, { locationId: profile.homeId, activity: 'have dinner and relax at home', emoji: '🍲' });
  const blocks: PlanBlock[] = [];
  for (let i = 0; i < raw.length; i++) {
    const start = marks[i]!;
    const end = i + 1 < marks.length ? marks[i + 1]! : sleep;
    if (end > start) blocks.push({ ...raw[i]!, start, end });
  }
  return {
    day,
    summary: `${profile.name} has an ordinary ${profile.occupation.toLowerCase()}'s day.`,
    blocks,
    revision: 0,
    source: 'fallback',
    createdAt: now,
  };
}

export function currentBlock(plan: DayPlan | null, t: GameMinutes): PlanBlock | null {
  if (!plan || plan.day !== dayOf(t)) return null;
  const m = minuteOfDay(t);
  return plan.blocks.find((b) => m >= b.start && m < b.end) ?? null;
}

/** Minutes before an accepted event's start when attendees set off. */
export const EVENT_LEAD_MINUTES = 15;

/** An accepted (or hosted) event this villager should be at right now. */
export function activeEventFor(
  villagerId: VillagerId,
  events: readonly VillageEvent[],
  t: GameMinutes,
): VillageEvent | null {
  for (const e of events) {
    if (e.status !== 'scheduled' && e.status !== 'happening') continue;
    if (e.hostId !== villagerId && !e.accepted.includes(villagerId)) continue;
    if (t >= e.start - EVENT_LEAD_MINUTES && t < e.end) return e;
  }
  return null;
}

/**
 * Turn a plan into an intent (spec §6): sleep outside the awake window, accepted events first,
 * then the current block, else idle at home. Minds (stub or WP3) can reuse this.
 */
export function intentFromPlan(
  profile: VillagerProfile,
  plan: DayPlan | null,
  events: readonly VillageEvent[],
  t: GameMinutes,
): Intent {
  const event = activeEventFor(profile.id, events, t);
  if (event) {
    const hosting = event.hostId === profile.id;
    return {
      type: 'goto',
      locationId: event.locationId,
      activity: hosting ? `host the ${event.title}` : `attend the ${event.title}`,
      emoji: '🎉',
    };
  }
  if (!isAwakeAt(profile, t)) return { type: 'sleep' };
  const block = currentBlock(plan, t);
  if (block) {
    return {
      type: 'goto',
      locationId: block.locationId,
      activity: block.activity,
      ...(block.emoji ? { emoji: block.emoji } : {}),
    };
  }
  return { type: 'goto', locationId: profile.homeId, activity: 'potter around at home', emoji: '🏠' };
}
