import { formatClock } from '../../../shared/time.ts';
import type {
  DayPlan,
  Location,
  Memory,
  Needs,
  VillageEvent,
  VillagerProfile,
  Weather,
} from '../../../shared/types.ts';
import { describeBlocks, type WakeWindow } from '../planning.ts';
import { lines, locationLines, memoryLines, needsLine, systemFor, weatherLine } from './common.ts';

export interface PlanPromptInput {
  profile: VillagerProfile;
  day: number;
  window: WakeWindow;
  yesterday: string;
  memories: readonly Memory[];
  events: readonly VillageEvent[];
  locations: readonly Location[];
  needs?: Needs;
  weather?: Weather;
  allowProposal: boolean;
  /** Extra context lines (visitor stay, partner, shy crush). */
  context?: readonly string[];
}

const EVENT_HINT =
  'If you feel like hosting a small village event today (e.g. a bake-off or picnic), add "proposeEvent":{"title":"Bake-off","description":"...","location":"<place id>","start":"15:00","durationMinutes":120,"invitees":["Name"]}.';

export function planDayPrompt(i: PlanPromptInput): { system: string; user: string } {
  const ev = i.events.map(
    (e) => `- ${e.title} at ${e.locationId} ${formatClock(e.start)}-${formatClock(e.end)}`,
  );
  const user = lines(
    `Plan your day ${i.day + 1}. You wake at ${formatClock(i.window.wake)} and go to bed at ${formatClock(i.window.sleep)}.`,
    ...(i.context ?? []),
    i.yesterday && `Yesterday: ${i.yesterday.slice(0, 200)}`,
    `On your mind:\n${memoryLines(i.memories, false, 5)}`,
    ev.length > 0 && `Events you will attend (keep them in the plan):\n${ev.join('\n')}`,
    needsLine(i.needs),
    weatherLine(i.weather),
    `Places (use these ids): ${locationLines(i.locations, i.profile.homeId)}`,
    `Write 5-7 blocks covering the whole day in order, with 24h times "HH:MM". Each block is ["start","end","place id","short activity"].`,
    i.allowProposal && EVENT_HINT,
    `Example: {"summary":"Bake bread and see friends","blocks":[["07:00","11:00","bakery","bake bread"],["11:00","12:00","cafe","lunch with friends"]]}`,
  );
  return { system: systemFor(i.profile), user };
}

export interface RevisePromptInput {
  profile: VillagerProfile;
  now: number;
  plan: DayPlan;
  reason: string;
  memories: readonly Memory[];
  locations: readonly Location[];
  needs?: Needs;
  weather?: Weather;
  endOfDay: number;
}

export function planRevisePrompt(i: RevisePromptInput): { system: string; user: string } {
  const rest = i.plan.blocks.filter((b) => b.end > i.now);
  const user = lines(
    `It is ${formatClock(i.now)}. Something happened: ${i.reason}`,
    `Your remaining plan:\n${describeBlocks(rest) || '(empty)'}`,
    `Relevant memories:\n${memoryLines(i.memories, false, 6)}`,
    needsLine(i.needs),
    weatherLine(i.weather),
    `Places (use these ids): ${locationLines(i.locations, i.profile.homeId)}`,
    `Rewrite the plan from ${formatClock(i.now)} to ${formatClock(i.endOfDay)} (2-5 blocks). Keep events you agreed to.`,
    `Each block is ["start","end","place id","short activity"].`,
    `Example: {"summary":"...","blocks":[["${formatClock(i.now)}","${formatClock(Math.min(i.endOfDay, i.now + 60))}","square","tell friends the news"]]}`,
  );
  return { system: systemFor(i.profile), user };
}
