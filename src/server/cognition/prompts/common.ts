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

export function locationLines(locations: readonly Location[], homeId: string, max = 24): string {
  const list = locations.filter((l) => l.kind !== 'house' || l.id === homeId).slice(0, max);
  return list.map((l) => `${l.id} (${l.id === homeId ? 'your home' : l.name})`).join(', ');
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
