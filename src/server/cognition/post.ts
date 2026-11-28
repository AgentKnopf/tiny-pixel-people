/**
 * Post office cognition (spec v2 §6, §8): greeting the player at home, letters and Laude's Keep.
 * Prompts and fallbacks are pure; the Mind wires them to the queue and the world.
 */
import { formatClock, minuteOfDay } from '../../shared/time.ts';
import type { GameMinutes, KeepEntry, Letter, Memory, VillagerProfile } from '../../shared/types.ts';
import { lines, memoryLines, systemFor } from './prompts/common.ts';

/** The postmaster who logs everything and can look things up in the Keep (spec v2 §8.3). */
export const KEEPER = 'laude';
export const KEEP_LOOKUP_MAX = 3;
export const KEEP_THOUGHT = '📒 checking the Keep…';
/** Laude's instant log memories count this much toward the reflection threshold. */
export const KEEP_REFLECTION_WEIGHT = 0.25;
/** Log memories are archived (forgotten) after this many game minutes. */
export const KEEP_FORGET_AFTER = 24 * 60;
/** At most one embedding flush of log memories per this many game minutes. */
export const KEEP_EMBED_GAP = 10;
/** Cosmetic "writing in the Keep" activity length (game minutes). */
export const KEEP_WRITE_MINUTES = 5;
/** Villager-written letters are considered once a day from this minute of day. */
export const LETTER_WRITE_AT = 21 * 60;
/** Game minutes the model may take for a villager-written letter (letter.write TTL). */
export const LETTER_WRITE_TTL = 360;
/** A letter to a friend after this many days without talking. */
export const MISS_YOU_DAYS = 2;
export const MISS_YOU_AFFINITY = 5;
/** Shy notes between a shy pair at most this often (days). */
export const SHY_NOTE_EVERY = 3;
export const GREETING_MAX = 200;
export const LETTER_MAX = 400;

export type LetterReason = 'thanks' | 'missYou' | 'shy';

export function timeOfDay(t: GameMinutes): string {
  const mod = minuteOfDay(t);
  return mod < 12 * 60 ? 'morning' : mod < 18 * 60 ? 'afternoon' : 'evening';
}

/** The template from spec v2 §6, with the owner's name and the time of day. */
export function fallbackGreeting(p: VillagerProfile, now: GameMinutes): string {
  return `Oh, hello! Come on in, make yourself at home. Good ${timeOfDay(now)} from ${p.name}!`;
}

function snippet(text: string, words = 6): string {
  const w = text.replace(/\s+/g, ' ').trim().split(' ');
  return w.slice(0, words).join(' ') + (w.length > words ? '…' : '');
}

/** Quotes the first 6 words, like the note reply fallback. */
export function fallbackLetterReply(p: VillagerProfile, letterText: string): string {
  return `Thank you for your letter about "${snippet(letterText)}". It was lovely to hear from you. — ${p.name}`;
}

export function greetPrompt(
  p: VillagerProfile,
  playerName: string,
  relation: string,
  now: GameMinutes,
  memories: readonly Memory[],
): { system: string; user: string } {
  return {
    system: systemFor(p),
    user: lines(
      `It is ${formatClock(now)}. ${playerName} just walked into your home while you are there.`,
      relation,
      `What you remember about ${playerName}:\n${memoryLines(memories, false, 4)}`,
      `Greet them in 1-2 sentences, in character.`,
      `Example: {"reply":"Oh, hello ${playerName}! Come on in, I just put the kettle on."}`,
    ),
  };
}

export function letterReplyPrompt(
  p: VillagerProfile,
  fromName: string,
  letterText: string,
  memories: readonly Memory[],
): { system: string; user: string } {
  return {
    system: systemFor(p),
    user: lines(
      `You received a letter from ${fromName}: "${letterText}"`,
      `Relevant memories:\n${memoryLines(memories, false, 5)}`,
      `Write a short reply letter (1-3 sentences). Answer what the letter says and mention its topic.`,
      `Example: {"reply":"Dear ${fromName}, thank you for asking about my garden! The roses are blooming."}`,
    ),
  };
}

const REASON_LINE: Record<LetterReason, (to: string) => string> = {
  thanks: (to) => `${to} gave you a gift today. Write a short thank-you letter.`,
  missYou: (to) => `You have not seen ${to} for a few days and you miss them. Write a short, warm letter.`,
  shy: (to) =>
    `You have a secret crush on ${to} but are far too shy to say it. Write a short, shy note that hints at it without saying it.`,
};

export function letterWritePrompt(
  p: VillagerProfile,
  toName: string,
  reason: LetterReason,
  memories: readonly Memory[],
): { system: string; user: string } {
  return {
    system: systemFor(p),
    user: lines(
      REASON_LINE[reason](toName),
      `What you remember about ${toName}:\n${memoryLines(memories, false, 4)}`,
      `At most 3 sentences, signed with your name.`,
      `Example: {"text":"Dear ${toName}, I was thinking of you today. Warmly, ${p.name}"}`,
    ),
  };
}

/** Context lines for Laude's prompts ("You check the Keep: …"). */
export function keepLines(entries: readonly KeepEntry[], names: (id: string) => string): string {
  if (entries.length === 0) return '';
  const items = entries.map(
    (e) =>
      `- ${e.kind} from ${e.authorLabel ?? names(e.authorId)}${e.recipientId ? ` to ${names(e.recipientId)}` : ''}: ${e.text.slice(0, 160)}`,
  );
  return `You check the Keep (the post office archive):\n${items.join('\n')}`;
}

export function keepMeta(entries: readonly KeepEntry[]): { id: string; kind: string; text: string }[] {
  return entries.map((e) => ({ id: e.id, kind: e.kind, text: e.text }));
}

export function letterMemoryText(letter: Letter, fromName: string): string {
  return `I got a letter from ${fromName}: "${letter.text.slice(0, 300)}"`;
}

/**
 * Town-wide budget for villager-written letters (spec v2 §8.1): `max` per day, at most one of them
 * to the player. A claim is released if the letter is not sent after all.
 */
export class LetterBudget {
  private days = new Map<number, { total: number; player: number }>();

  claim(day: number, toPlayer: boolean, max: number): boolean {
    const d = this.days.get(day) ?? { total: 0, player: 0 };
    if (d.total >= max || (toPlayer && d.player >= 1)) return false;
    d.total++;
    if (toPlayer) d.player++;
    this.days.set(day, d);
    return true;
  }

  release(day: number, toPlayer: boolean): void {
    const d = this.days.get(day);
    if (!d) return;
    d.total = Math.max(0, d.total - 1);
    if (toPlayer) d.player = Math.max(0, d.player - 1);
  }

  used(day: number): { total: number; player: number } {
    return { ...(this.days.get(day) ?? { total: 0, player: 0 }) };
  }
}
