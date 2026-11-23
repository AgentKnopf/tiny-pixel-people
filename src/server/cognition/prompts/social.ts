import type { ConversationMessage, Memory, VillagerProfile } from '../../../shared/types.ts';
import { lines, memoryLines, systemFor } from './common.ts';

export interface TurnPromptInput {
  profile: VillagerProfile;
  partnerName: string;
  relationship: string;
  place: string;
  activity: string;
  memories: readonly Memory[];
  news: readonly string[];
  transcript: readonly ConversationMessage[];
  names: Readonly<Record<string, string>>;
  turn: number;
  maxTurns: number;
  /** The partner just told you this news. */
  justHeard?: string;
}

export function transcriptLines(
  t: readonly ConversationMessage[],
  names: Readonly<Record<string, string>>,
): string {
  return t.map((m) => `${names[m.speakerId] ?? m.speakerId}: ${m.text}`).join('\n');
}

export function convoTurnPrompt(i: TurnPromptInput): { system: string; user: string } {
  const last = i.turn >= i.maxTurns - 1;
  const user = lines(
    `You meet ${i.partnerName} at ${i.place}. You were: ${i.activity}. ${i.relationship}`,
    `What you remember about this:\n${memoryLines(i.memories, false, 6)}`,
    i.news.length > 0 &&
      (i.turn <= 1
        ? `Tell ${i.partnerName} this news in your own words: ${i.news[0]}`
        : `News you might share (mention one naturally if it fits):\n${i.news.map((n) => `- ${n}`).join('\n')}`),
    i.justHeard && `${i.partnerName} just told you: ${i.justHeard} React to it and repeat the key detail.`,
    i.transcript.length > 0
      ? `Conversation so far:\n${transcriptLines(i.transcript, i.names)}`
      : `You speak first. Greet ${i.partnerName}.`,
    `Say your next line (1-2 sentences, no name prefix).${last ? ' This is your last line, say goodbye.' : ''} Set "end" to true when the chat is over.`,
    `Example: {"say":"Morning, ${i.partnerName}! Did you hear the news?","end":false}`,
  );
  return { system: systemFor(i.profile), user };
}

export interface SummarizePromptInput {
  a: VillagerProfile;
  b: VillagerProfile;
  transcript: readonly ConversationMessage[];
  offered: readonly { text: string; by: string }[];
  names: Readonly<Record<string, string>>;
}

export function convoSummarizePrompt(i: SummarizePromptInput): { system: string; user: string } {
  const offered = i.offered.length
    ? `News that was available (index: by whom: text):\n${i.offered.map((o, n) => `${n}: ${i.names[o.by] ?? o.by}: ${o.text}`).join('\n')}`
    : '';
  const user = lines(
    `Conversation between ${i.a.name} (A) and ${i.b.name} (B):\n${transcriptLines(i.transcript, i.names)}`,
    offered,
    `For each person: a one-sentence summary from their view, the new facts they learned from the other person (with "fromNewsIndex" when the fact is one of the indexed news items), and how their feeling toward the other changed (-2..2).`,
    `Example: {"forA":{"summary":"I told B about the bake-off.","learned":[],"affinityDelta":1},"forB":{"summary":"A told me about the bake-off.","learned":[{"text":"There is a bake-off at 15:00","importance":5,"fromNewsIndex":0}],"affinityDelta":1}}`,
  );
  return {
    system: `You summarize conversations between villagers in a tiny village. Only list facts that were actually said.\nAnswer with ONE JSON object only. No markdown, no explanations.`,
    user,
  };
}
