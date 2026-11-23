/** Shared prompt fragments. Prompts are short and end with an explicit JSON example for 7B models. */
import { dayOf, formatClock } from '../../../shared/time.ts';
import type {
  GameMinutes,
  Location,
  Memory,
  Needs,
  VillagerProfile,
  Weather,
} from '../../../shared/types.ts';

export const JSON_RULE = 'Answer with ONE JSON object only. No markdown, no explanations.';

export function persona(p: VillagerProfile): string {
  const traits = p.traits.length ? ` Traits: ${p.traits.join(', ')}.` : '';
  return `You are ${p.name}, ${p.age}, the village ${p.occupation} in a tiny village. ${p.bio}${traits}`;
}

export function systemFor(p: VillagerProfile, extra = ''): string {
  return `${persona(p)}\nStay in character. Keep it short, warm and concrete.${extra ? `\n${extra}` : ''}\n${JSON_RULE}`;
}

export function clock(t: GameMinutes): string {
  return `day ${dayOf(t) + 1}, ${formatClock(t)}`;
}

export function memoryLines(memories: readonly Memory[], numbered = false, max = 12): string {
  if (memories.length === 0) return '(nothing in particular)';
  return memories
    .slice(0, max)
    .map((m, i) => `${numbered ? `${i + 1}.` : '-'} ${m.text.slice(0, 200)}`)
    .join('\n');
}

/** Places nobody plans for: the butcher is off-screen, the hotel is only the visitors' home. */
const UNPLANNED = new Set(['butcher', 'hotel']);

/**
 * The places a villager may use in a plan. Zoo enclosures are listed as one compact group and
 * opening hours are shown, so the bigger v2 map stays within a small prompt.
 */
export function locationLines(locations: readonly Location[], homeId: string, max = 32): string {
  const usable = locations.filter((l) => l.id === homeId || (l.kind !== 'house' && !UNPLANNED.has(l.id)));
  const enclosures = usable.filter((l) => l.kind === 'zoo' && l.species);
  const list = usable.filter((l) => !enclosures.includes(l)).slice(0, max);
  const parts = list.map((l) => {
    const name = l.id === homeId ? 'your home' : l.name;
    return `${l.id} (${name}${l.hours ? `, open ${l.hours.open}-${l.hours.close}` : ''})`;
  });
  if (enclosures.length) parts.push(`zoo animals to watch: ${enclosures.map((l) => l.id).join(' ')}`);
  return parts.join(', ');
}

export function needsLine(needs: Needs | undefined): string {
  if (!needs) return '';
  const low = (Object.keys(needs) as (keyof Needs)[]).filter((k) => needs[k] < 35);
  const parts = (Object.keys(needs) as (keyof Needs)[]).map((k) => `${k} ${Math.round(needs[k])}`);
  return `Your needs (0-100, low means urgent): ${parts.join(', ')}.${low.length ? ` Take care of: ${low.join(', ')}.` : ''}`;
}

export function weatherLine(weather: Weather | undefined): string {
  return weather?.state === 'rain' ? 'It is raining, so prefer indoor places.' : '';
}

export function lines(...xs: (string | false | undefined | null)[]): string {
  return xs.filter((x): x is string => !!x).join('\n');
}
