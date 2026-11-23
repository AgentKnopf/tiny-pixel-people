import { formatClock } from '../../../shared/time.ts';
import type { Memory, VillageEvent, VillagerProfile } from '../../../shared/types.ts';
import { JSON_RULE, lines, locationLines, memoryLines, persona, systemFor } from './common.ts';
import type { Location } from '../../../shared/types.ts';

export function importancePrompt(
  p: VillagerProfile,
  memories: readonly Memory[],
): { system: string; user: string } {
  return {
    system: `You rate how important memories are for ${p.name} (${p.occupation}). 1 = mundane (brushing teeth), 10 = life-changing (a break up, a wedding).\n${JSON_RULE}`,
    user: lines(
      `Rate each memory from 1 to 10:`,
      memoryLines(memories, true, 16),
      `Example for 3 memories: {"ratings":[2,7,4]}`,
    ),
  };
}

export function reflectPrompt(
  p: VillagerProfile,
  memories: readonly Memory[],
): { system: string; user: string } {
  return {
    system: systemFor(p),
    user: lines(
      `Your recent memories:`,
      memoryLines(memories, true, 20),
      `What 2-3 high-level insights can you draw about yourself, your neighbours or the village? Cite memory numbers.`,
      `Example: {"insights":[{"text":"Mia and I are becoming close friends","because":[2,5]}]}`,
    ),
  };
}

export function reflectQuestionsPrompt(
  p: VillagerProfile,
  memories: readonly Memory[],
): { system: string; user: string } {
  return {
    system: systemFor(p),
    user: lines(
      `Your recent memories:`,
      memoryLines(memories, true, 20),
      `Which 2-3 questions about these are most worth thinking about?`,
      `Example: {"questions":["What is Mia planning?"]}`,
    ),
  };
}

export function eventProposePrompt(
  p: VillagerProfile,
  now: number,
  memories: readonly Memory[],
  locations: readonly Location[],
  friends: readonly string[],
): { system: string; user: string } {
  return {
    system: systemFor(p),
    user: lines(
      `It is ${formatClock(now)}. You want to host a small, fun village event later today that fits who you are.`,
      `On your mind:\n${memoryLines(memories, false, 6)}`,
      `Places (use these ids): ${locationLines(locations, p.homeId)}`,
      `People you could invite: ${friends.join(', ') || 'anyone'}`,
      `Pick a start time at least an hour from now, before evening. Invite 4-6 people.`,
      `Example: {"title":"Bake-off","description":"Bring your best pie!","location":"plaza","start":"15:00","durationMinutes":120,"invitees":["Ada","Ben"]}`,
    ),
  };
}

export function eventDecidePrompt(
  p: VillagerProfile,
  e: VillageEvent,
  hostName: string,
  relation: string,
  conflicts: string,
  memories: readonly Memory[],
): { system: string; user: string } {
  return {
    system: systemFor(p),
    user: lines(
      `${hostName} invites you to "${e.title}" (${e.description}) at ${e.locationId}, ${formatClock(e.start)}-${formatClock(e.end)}.`,
      relation,
      conflicts ? `Your plan at that time: ${conflicts}` : 'You have nothing special planned then.',
      `Relevant memories:\n${memoryLines(memories, false, 5)}`,
      `Do you go?`,
      `Example: {"accept":true,"reason":"I love pie and Mia is a good friend."}`,
    ),
  };
}

export function noteReplyPrompt(
  p: VillagerProfile,
  author: string,
  note: string,
  memories: readonly Memory[],
): { system: string; user: string } {
  return {
    system: systemFor(p),
    user: lines(
      `You found a note on your door from ${author}: "${note}"`,
      `Relevant memories:\n${memoryLines(memories, false, 5)}`,
      `Write a short reply (1-3 sentences) to pin on your door. Address what the note says directly and mention its topic.`,
      `Example: {"reply":"Thank you for asking about my roses! Come by on Saturday and I'll show you."}`,
    ),
  };
}

export function daySummaryPrompt(
  p: VillagerProfile,
  day: number,
  memories: readonly Memory[],
): { system: string; user: string } {
  return {
    system: systemFor(p),
    user: lines(
      `Your memories from day ${day + 1}:`,
      memoryLines(memories, false, 25),
      `Summarize your day in 2-3 sentences: what happened, who you met, what you want to remember.`,
      `Example: {"summary":"I baked all morning and Ada told me about the bake-off."}`,
    ),
  };
}

export function playerReplyPrompt(
  p: VillagerProfile,
  playerName: string,
  relation: string,
  text: string,
  memories: readonly Memory[],
  activity: string,
  mode: 'say' | 'ask' | 'gift',
): { system: string; user: string } {
  const what =
    mode === 'gift'
      ? `${playerName} just gave you a gift: ${text}. Thank them in your own way.`
      : `${playerName} says to you: "${text}"`;
  return {
    system: systemFor(p, `${playerName} is a newcomer to the village who lives in the purple cottage.`),
    user: lines(
      `You are ${activity}.`,
      relation,
      `What you remember:\n${memoryLines(memories, false, 6)}`,
      what,
      `Reply in 1-2 sentences, in character.`,
      `Example: {"reply":"Oh, hello! I was just about to open the bakery."}`,
    ),
  };
}

export function taskDecidePrompt(
  p: VillagerProfile,
  playerName: string,
  relation: string,
  text: string,
  plan: string,
  now: number,
  locations: readonly Location[],
): { system: string; user: string } {
  return {
    system: systemFor(p),
    user: lines(
      `It is ${formatClock(now)}. ${playerName} asks you: "${text}"`,
      relation,
      `Your plan for the rest of the day:\n${plan || '(free)'}`,
      `Places (use these ids): ${locationLines(locations, p.homeId)}`,
      `Will you do it today? If yes, say what you will do, where and when (24h time).`,
      `Example: {"accept":true,"activity":"bring flowers to the plaza","location":"plaza","time":"16:00","reply":"Sure, I'll do it this afternoon!"}`,
    ),
  };
}

export { persona };
