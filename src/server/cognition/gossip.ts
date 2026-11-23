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

/**
 * Up to `max` memories worth sharing with `partnerId`: recent, important, not already told to or
 * heard from them; one per origin fact.
 */
export function selectNews(
  memories: readonly Memory[],
  partnerId: VillagerId,
  now: GameMinutes,
  max = 3,
): Memory[] {
  const byOrigin = new Map<string, { m: Memory; score: number }>();
  const partnerKnows = new Set<string>();
  for (const m of memories) {
    if (m.meta.heardFrom === partnerId || m.meta.toldTo?.includes(partnerId))
      partnerKnows.add(m.meta.originId ?? m.id);
  }
  for (const m of memories) {
    if (!isNewsworthy(m) || now - m.createdAt > NEWS_WINDOW || m.createdAt > now) continue;
    const origin = m.meta.originId ?? m.id;
    if (partnerKnows.has(origin)) continue;
    const age = (now - m.createdAt) / NEWS_WINDOW;
    // Each retelling lowers a fact's score, so one big story cannot crowd out every other one.
    const told = m.meta.toldTo?.length ?? 0;
    const score = (m.importance * (1 - 0.5 * age)) / (1 + 0.5 * told);
    const prev = byOrigin.get(origin);
    if (!prev || score > prev.score) byOrigin.set(origin, { m, score });
  }
  return [...byOrigin.values()]
    .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt)
    .slice(0, max)
    .map((x) => x.m);
}

/** Strip first-person framing so a memory reads as a shareable fact. */
export function newsText(m: Memory): string {
  return m.text
    .replace(/^I found a note on my door from [^:]+:\s*/i, 'Someone left me a note: ')
    .replace(/^[A-Z][\w' ]{0,30} told me(?: that)?:?\s*/i, '')
    .replace(/^I heard(?: that)?:?\s*/i, '')
    .trim();
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
