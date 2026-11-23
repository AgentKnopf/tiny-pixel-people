import type { Location, Needs, PlanBlock, VillagerStatus } from '../../shared/types.ts';
import type { AppConfig } from '../config.ts';

export type NeedKey = keyof Needs;
export const NEED_KEYS: readonly NeedKey[] = ['hunger', 'energy', 'social', 'fun'];

/** Below this a need triggers the deterministic override block (spec §7.10). */
export const NEED_LOW = 20;
/** The override ends once the need is back above this. */
export const NEED_RECOVERED = 60;
export const CONVERSATION_SOCIAL_BONUS = 8;

export function initialNeeds(): Needs {
  return { hunger: 80, energy: 90, social: 70, fun: 70 };
}

interface Restore {
  need: NeedKey;
  /** Points per game hour. */
  perHour: number;
  keywords?: RegExp;
  /** Location kinds/ids where the rule applies (any when omitted). */
  where?: (loc: Location | null) => boolean;
}

const isFoodPlace = (l: Location | null) =>
  !!l && (l.id === 'bakery' || l.kind === 'house' || /caf/i.test(l.name));
const isLeisurePlace = (l: Location | null) => !!l && (l.kind === 'public' || l.kind === 'nature');

/**
 * Restoration table: activity keywords and location kinds that refill needs while a villager is
 * acting or attending. Matching is deterministic so needs never depend on the LLM.
 */
export const RESTORE_RULES: readonly Restore[] = [
  {
    need: 'hunger',
    perHour: 45,
    keywords:
      /\b(eat|eating|breakfast|lunch|dinner|supper|snack|bite|meal|brunch|picnic|tea|coffee|cake|pastr)/i,
  },
  { need: 'hunger', perHour: 15, where: isFoodPlace, keywords: /\b(bak|cook|taste|bread|bun)/i },
  { need: 'energy', perHour: 10, keywords: /\b(rest|nap|relax|read|sit|lounge|doze)/i },
  {
    need: 'social',
    perHour: 12,
    keywords:
      /\b(chat|talk|visit|meet|gossip|party|celebrat|bake-off|festival|gather|serve|customer|class|teach)/i,
  },
  {
    need: 'fun',
    perHour: 15,
    keywords:
      /\b(play|game|stroll|walk|garden|paint|music|guitar|sing|fish|picnic|dance|party|bake-off|festival|explor|read|story)/i,
  },
  { need: 'fun', perHour: 6, where: isLeisurePlace },
];

const clamp = (v: number) => Math.max(0, Math.min(100, v));

export interface NeedsContext {
  status: VillagerStatus;
  activity: string;
  location: Location | null;
}

/** Apply decay and restoration for `dtMinutes` of game time (mutates and returns `needs`). */
export function updateNeeds(
  needs: Needs,
  ctx: NeedsContext,
  dtMinutes: number,
  decayPerHour: AppConfig['needs']['decayPerHour'],
): Needs {
  const h = dtMinutes / 60;
  if (ctx.status === 'sleeping') {
    needs.energy = clamp(needs.energy + 12 * h);
    needs.hunger = clamp(needs.hunger - decayPerHour.hunger * 0.25 * h);
    return needs;
  }
  for (const k of NEED_KEYS) needs[k] = clamp(needs[k] - decayPerHour[k] * h);
  if (ctx.status === 'talking') needs.social = clamp(needs.social + 6 * h);
  if (ctx.status === 'acting' || ctx.status === 'attending' || ctx.status === 'idle') {
    for (const r of RESTORE_RULES) {
      if (r.keywords && !r.keywords.test(ctx.activity)) continue;
      if (r.where && !r.where(ctx.location)) continue;
      needs[r.need] = clamp(needs[r.need] + r.perHour * h);
    }
    if (ctx.status === 'attending') {
      needs.fun = clamp(needs.fun + 20 * h);
      needs.social = clamp(needs.social + 10 * h);
    }
  }
  return needs;
}

export function addNeed(needs: Needs, key: NeedKey, amount: number): void {
  needs[key] = clamp(needs[key] + amount);
}

/** Does this activity (at this location) restore `need`? */
export function addresses(need: NeedKey, activity: string, location: Location | null): boolean {
  if (need === 'energy' && /\b(sleep|nap|rest)/i.test(activity)) return true;
  return RESTORE_RULES.some(
    (r) =>
      r.need === need &&
      r.keywords !== undefined &&
      r.keywords.test(activity) &&
      (!r.where || r.where(location)),
  );
}

export interface NeedFix {
  need: NeedKey;
  locationId: string;
  activity: string;
  emoji: string;
}

/**
 * The deterministic override from spec §7.10: the most urgent need below NEED_LOW that the current
 * block does not address, with a short activity to fix it. `null` when nothing is urgent.
 */
export function urgentNeedFix(
  needs: Needs,
  block: Pick<PlanBlock, 'activity' | 'locationId'> | null,
  locations: readonly Location[],
  homeId: string,
): NeedFix | null {
  const byId = (id: string) => locations.find((l) => l.id === id) ?? null;
  const blockLoc = block ? byId(block.locationId) : null;
  const low = NEED_KEYS.filter((k) => needs[k] < NEED_LOW).sort((a, b) => needs[a] - needs[b]);
  for (const need of low) {
    if (block && addresses(need, block.activity, blockLoc)) continue;
    return needFix(need, locations, homeId);
  }
  return null;
}

export function needFix(need: NeedKey, locations: readonly Location[], homeId: string): NeedFix {
  const has = (id: string) => locations.some((l) => l.id === id);
  switch (need) {
    case 'hunger':
      return has('bakery')
        ? { need, locationId: 'bakery', activity: 'grab a bite at the café', emoji: '🥐' }
        : { need, locationId: homeId, activity: 'eat a snack at home', emoji: '🍞' };
    case 'energy':
      return { need, locationId: homeId, activity: 'take a nap at home', emoji: '😴' };
    case 'social':
      return {
        need,
        locationId: has('square') ? 'square' : homeId,
        activity: 'look for someone to chat with',
        emoji: '💬',
      };
    case 'fun':
      return {
        need,
        locationId: has('park') ? 'park' : has('square') ? 'square' : homeId,
        activity: 'stroll and play in the park',
        emoji: '🌳',
      };
  }
}
