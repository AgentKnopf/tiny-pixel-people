/** Gossip (spec §7.6): what a villager might share, and whether it was actually said. */
import type { ConversationMessage, GameMinutes, Memory, VillagerId } from '../../shared/types.ts';
import { extractKeywords, keywordOverlap } from './keywords.ts';

const NEWS_KINDS = new Set<Memory['kind']>(['note', 'heard', 'event', 'reflection']);
const NEWS_WINDOW = 24 * 60;

export function isNewsworthy(m: Memory): boolean {
  if (m.meta.archived) return false;
  // A notice read at the board is news like a door note, whatever its importance.
  if (m.meta.noticeId) return true;
  return NEWS_KINDS.has(m.kind) || (m.kind === 'observation' && m.importance >= 6);
}

/** Tellings each fact gets before newer news may push it aside. */
export const NEWS_FAIR_SHARE = 2;

/**
 * Up to `max` memories worth sharing with `partnerId`: recent, important, not already told to or
 * heard from them; one per origin fact. Facts told to fewer than NEWS_FAIR_SHARE villagers come
 * first, oldest first, so a steady stream of fresh chatter cannot starve an earlier fact (a notice
 * read in the morning still reaches others by evening). Facts known only from Laude's Keep log
 * queue behind the rest, by importance and freshness: he logs every note, letter, notice and rumor
 * at once, and oldest-first would have him recite old trivia ahead of a fresh rumor. Own musings
 * never jump that queue.
 */
export function selectNews(
  memories: readonly Memory[],
  partnerId: VillagerId,
  now: GameMinutes,
  max = 3,
): Memory[] {
  /** Best copy per origin; `first` is when this villager first knew the fact (any copy). */
  const byOrigin = new Map<
    string,
    { m: Memory; score: number; told: number; first: GameMinutes; logOnly: boolean }
  >();
  const partnerKnows = new Set<string>();
  const toldTo = new Map<string, Set<VillagerId>>();
  for (const m of memories) {
    const origin = m.meta.originId ?? m.id;
    if (m.meta.heardFrom === partnerId || m.meta.toldTo?.includes(partnerId)) partnerKnows.add(origin);
    for (const id of m.meta.toldTo ?? []) {
      const set = toldTo.get(origin) ?? new Set<VillagerId>();
      set.add(id);
      toldTo.set(origin, set);
    }
  }
  for (const m of memories) {
    if (!isNewsworthy(m) || now - m.createdAt > NEWS_WINDOW || m.createdAt > now) continue;
    const origin = m.meta.originId ?? m.id;
    if (partnerKnows.has(origin)) continue;
    const age = (now - m.createdAt) / NEWS_WINDOW;
    // Own musings rank below things that happened or were heard.
    const weight = m.kind === 'reflection' ? 0.5 : 1;
    const score = weight * m.importance * (1 - 0.5 * age);
    const prev = byOrigin.get(origin);
    const first = Math.min(prev?.first ?? Infinity, m.createdAt);
    const logOnly = (prev?.logOnly ?? true) && !!m.meta.keepId;
    if (!prev || score > prev.score)
      byOrigin.set(origin, { m, score, told: toldTo.get(origin)?.size ?? 0, first, logOnly });
    else Object.assign(prev, { first, logOnly });
  }
  const queued = (x: { m: Memory; told: number }) => x.m.kind !== 'reflection' && x.told < NEWS_FAIR_SHARE;
  return [...byOrigin.values()]
    .sort((a, b) => {
      const qa = queued(a);
      const qb = queued(b);
      if (qa !== qb) return qa ? -1 : 1;
      if (qa && a.logOnly !== b.logOnly) return a.logOnly ? 1 : -1;
      // Reading a notice again later does not send it to the back of the queue.
      if (qa && !a.logOnly) return a.first - b.first || b.score - a.score;
      return b.score - a.score || b.m.createdAt - a.m.createdAt;
    })
    .slice(0, max)
    .map((x) => x.m);
}
// A retold notice must not read like the listener's own visit to the board (spec v2 §8.2).
const BOARD_READ = /^The notice board says:\s*/i;
const BOARD_RETOLD = 'There is a notice on the board: ';

/** Strip first-person framing so a memory reads as a shareable fact. */
export function newsText(m: Memory): string {
  return m.text
    .replace(/^I found a note on my door from [^:]+:\s*/i, 'Someone left me a note: ')
    .replace(/^[A-Z][\w' ]{0,30} told me(?: that)?:?\s*/i, '')
    .replace(/^I heard(?: that)?:?\s*/i, '')
    .trim()
    .replace(BOARD_READ, BOARD_RETOLD);
}

/** Text of a fact as someone who heard it keeps it. */
export function retoldText(text: string): string {
  return text.replace(BOARD_READ, BOARD_RETOLD);
}

/** Distinctive keywords of a fact (drops very short/common tokens). */
export function factKeywords(text: string): string[] {
  return extractKeywords(text).filter((k) => k.length >= 3);
}

/** Best message (by keyword overlap) in which `speakerId` mentioned the fact; null if not mentioned. */
export function findMention(
  fact: string,
  messages: readonly ConversationMessage[],
  speakerId: VillagerId,
  threshold = 0.5,
): { message: ConversationMessage; overlap: number } | null {
  const kw = factKeywords(fact);
  if (kw.length === 0) return null;
  let best: { message: ConversationMessage; overlap: number } | null = null;
  for (const msg of messages) {
    if (msg.speakerId !== speakerId) continue;
    const ov = keywordOverlap(kw, extractKeywords(msg.text, 64));
    if (ov >= threshold && (!best || ov > best.overlap)) best = { message: msg, overlap: ov };
  }
  return best;
}

/** The sentence of `text` with the most overlap with `fact`. */
export function bestSentence(text: string, fact: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length <= 1) return text;
  const kw = factKeywords(fact);
  let best = sentences[0]!;
  let bestOv = -1;
  for (const s of sentences) {
    const ov = keywordOverlap(kw, extractKeywords(s));
    if (ov > bestOv) {
      best = s;
      bestOv = ov;
    }
  }
  return best;
}
