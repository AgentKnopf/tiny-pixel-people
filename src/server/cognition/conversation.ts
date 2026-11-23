/**
 * Conversation runner (spec §7.5–§7.6): alternating `convo.turn` calls, then one `convo.summarize`
 * that stores conversation + heard memories for both villagers and propagates gossip origin ids.
 * The runner only appends to `conversation.messages`; the engine broadcasts them.
 */
import type { Conversation, ConversationMessage, Memory, VillagerId } from '../../shared/types.ts';
import { asArray, asBool, asNumber, asRecord, asString, clamp, pick } from './json.ts';
import { extractKeywords, keywordOverlap } from './keywords.ts';
import { ask } from './llm.ts';
import { Mind, cleanLine } from './mind.ts';
import { bestSentence, findMention, newsText } from './gossip.ts';
import { convoSummarizePrompt, convoTurnPrompt } from './prompts/social.ts';
import { settingsFromConfig } from './settings.ts';
import type {
  ConversationRunner,
  ConversationRunnerDeps,
  CreateConversationRunner,
  LearnedFact,
  VillagerMind,
} from './types.ts';

interface Offered {
  id: string;
  text: string;
  by: VillagerId;
  memory: Memory;
}

interface Learned {
  text: string;
  importance?: number;
  offered?: Offered;
}

interface Side {
  summary: string;
  learned: Learned[];
  affinityDelta: number;
}

export class LlmConversationRunner implements ConversationRunner {
  private readonly settings;

  constructor(private readonly deps: ConversationRunnerDeps) {
    this.settings = settingsFromConfig(deps.config);
  }

  async run(conversation: Conversation, minds: [VillagerMind, VillagerMind]): Promise<Conversation> {
    const [a, b] = minds;
    if (!(a instanceof Mind) || !(b instanceof Mind)) {
      conversation.status = conversation.status === 'active' ? 'ended' : conversation.status;
      conversation.endedAt ??= this.deps.now();
      return conversation;
    }
    const pair: [Mind, Mind] = [a, b];
    const names: Record<VillagerId, string> = { [a.id]: a.profile.name, [b.id]: b.profile.name };
    const start = this.deps.now();
    const news: [Offered[], Offered[]] = [
      a.newsFor(b.id, start).map((m) => ({ id: m.id, text: newsText(m), by: a.id, memory: m })),
      b.newsFor(a.id, start).map((m) => ({ id: m.id, text: newsText(m), by: b.id, memory: m })),
    ];
    const maxTurns = this.settings.maxConversationTurns;
    for (let turn = conversation.messages.length; turn < maxTurns; turn++) {
      if (conversation.status !== 'active') break;
      if (this.deps.now() - conversation.startedAt > this.settings.maxConversationGameMinutes) break;
      const si = turn % 2;
      const speaker = pair[si]!;
      const listener = pair[1 - si]!;
      const res = await this.turn(conversation, speaker, listener, news[si]!, names, turn, maxTurns);
      if (conversation.status !== 'active') break;
      const msg: ConversationMessage = { speakerId: speaker.id, text: res.say, at: this.deps.now() };
      conversation.messages.push(msg);
      if (res.end && turn >= 1) break;
    }
    if (conversation.status === 'active') conversation.status = 'ended';
    conversation.endedAt ??= this.deps.now();
    if (conversation.messages.length > 0) await this.wrapUp(conversation, pair, news, names);
    return conversation;
  }

  private async turn(
    conv: Conversation,
    speaker: Mind,
    listener: Mind,
    offered: Offered[],
    names: Record<VillagerId, string>,
    turn: number,
    maxTurns: number,
  ): Promise<{ say: string; end: boolean }> {
    const view = speaker.lastView;
    const now = this.deps.now();
    const place = conv.locationId ? speaker.locName(view, conv.locationId) : 'the village path';
    const memories = await speaker.memory.retrieve(`${listener.profile.name} ${place}`, now, { k: 5 });
    const transcript = conv.messages.slice();
    const p = convoTurnPrompt({
      profile: speaker.profile,
      partnerName: listener.profile.name,
      relationship: speaker.relationText(view, listener.id, listener.profile.name),
      place,
      activity: view?.self.activity.text || 'going about your day',
      memories,
      news: offered.map((o) => o.text),
      transcript,
      names,
      turn,
      maxTurns,
    });
    const said = new Set(
      transcript.filter((m) => m.speakerId === speaker.id).map((m) => m.text.toLowerCase()),
    );
    const res = await ask(this.deps.queue, {
      task: 'convo.turn',
      ...p,
      meta: {
        villagerId: speaker.id,
        profile: speaker.profile,
        locations: view?.locations.map((l) => l.id) ?? [],
        now,
        partnerId: listener.id,
        partnerName: listener.profile.name,
        news: offered.map((o) => ({ id: o.id, text: o.text })),
        transcript,
        turn,
        conversationId: conv.id,
      },
      parse: (raw) => {
        const r = asRecord(raw);
        const say = cleanLine(asString(pick(r, 'say', 'text', 'message', 'reply', 'line', 'utterance')));
        if (!say || said.has(say.toLowerCase())) return null;
        return { say, end: asBool(pick(r, 'end', 'done', 'finished', 'bye')) ?? false };
      },
      acceptText: (t) => {
        const say = cleanLine(t.split('\n')[0]);
        return say ? { say, end: false } : null;
      },
      fallback: () => fallbackTurn(speaker, listener, offered, conv.messages, turn, maxTurns),
      shape: '{"say":"...","end":false}',
      temperature: this.settings.temperature,
      maxTokens: 120,
    });
    return res.value;
  }

  private async wrapUp(
    conv: Conversation,
    pair: [Mind, Mind],
    news: [Offered[], Offered[]],
    names: Record<VillagerId, string>,
  ): Promise<void> {
    const [a, b] = pair;
    const offered = [...news[0], ...news[1]];
    const transcript = conv.messages.slice();
    const res = await ask(this.deps.queue, {
      task: 'convo.summarize',
      ...convoSummarizePrompt({ a: a.profile, b: b.profile, transcript, offered, names }),
      meta: {
        villagerId: a.id,
        profile: a.profile,
        locations: a.lastView?.locations.map((l) => l.id) ?? [],
        now: this.deps.now(),
        participants: [a.id, b.id],
        offered: offered.map((o) => ({ id: o.id, text: o.text, by: o.by })),
        transcript,
        names,
        conversationId: conv.id,
      },
      parse: (raw) => {
        const r = asRecord(raw);
        const fa = parseSide(pick(r, 'forA', 'a', 'A', a.profile.name), offered);
        const fb = parseSide(pick(r, 'forB', 'b', 'B', b.profile.name), offered);
        return fa || fb ? { forA: fa ?? emptySide(), forB: fb ?? emptySide() } : null;
      },
      fallback: () => ({ forA: emptySide(), forB: emptySide() }),
      shape:
        '{"forA":{"summary":"...","learned":[],"affinityDelta":1},"forB":{"summary":"...","learned":[],"affinityDelta":1}}',
      temperature: 0.2,
      maxTokens: 400,
    });
    const at = this.deps.now();
    this.apply(conv, a, b, res.value.forA, news[1], at);
    this.apply(conv, b, a, res.value.forB, news[0], at);
  }

  /** Store what `self` takes away from the conversation with `other`. */
  private apply(
    conv: Conversation,
    self: Mind,
    other: Mind,
    side: Side,
    otherNews: Offered[],
    at: number,
  ): void {
    const msgs = conv.messages;
    const topics = extractKeywords(
      msgs
        .filter((m) => m.speakerId === other.id)
        .map((m) => m.text)
        .join(' '),
      6,
    );
    const summary =
      side.summary ||
      `I chatted with ${other.profile.name}${topics.length ? ` about ${topics.slice(0, 3).join(', ')}` : ''}.`;
    self.addMemory({
      kind: 'conversation',
      at,
      text: `Talked with ${other.profile.name}: ${summary}`.slice(0, 300),
      meta: { conversationId: conv.id },
    });

    // Learned facts: model output, plus any offered news the other one demonstrably said.
    const learned: Learned[] = side.learned.filter((l) => !l.offered || l.offered.by === other.id);
    for (const o of otherNews) {
      if (learned.some((l) => l.offered?.id === o.id)) continue;
      if (findMention(o.text, msgs, other.id)) learned.push({ text: o.text, offered: o });
    }
    for (const l of learned) {
      const match = l.offered ?? matchOffered(l.text, otherNews);
      const originId = match?.memory.meta.originId ?? match?.memory.id;
      if (originId && self.memory.hasOrigin(originId)) continue;
      const mention = findMention(match?.text ?? l.text, msgs, other.id, 0.3);
      const said = mention ? bestSentence(mention.message.text, match?.text ?? l.text) : l.text;
      const importance = clamp(
        Math.round(l.importance ?? Math.max(4, (match?.memory.importance ?? 5) - 1)),
        1,
        10,
      );
      const mem = self.addMemory({
        kind: 'heard',
        at,
        text: `${other.profile.name} told me: ${l.text}`.slice(0, 300),
        importance,
        meta: {
          heardFrom: other.id,
          conversationId: conv.id,
          ...(originId ? { originId } : {}),
          ...(match?.memory.meta.eventId ? { eventId: match.memory.meta.eventId } : {}),
        },
      });
      const fact: LearnedFact = {
        from: other.id,
        to: self.id,
        originId: mem.meta.originId ?? mem.id,
        text: l.text,
        said,
        conversationId: conv.id,
        at,
      };
      self.world.recordLearned?.(fact);
      if (match) markTold(match.memory, self.id);
    }
    // Also mark news the other side said even if `self` already knew it.
    for (const o of otherNews) if (findMention(o.text, msgs, other.id)) markTold(o.memory, self.id);

    self.world.adjustRelationship(
      other.id,
      clamp(Math.round(side.affinityDelta), -2, 2),
      summary.slice(0, 160),
    );
    self.noteTalk(other.id, at);
  }
}

function markTold(m: Memory, to: VillagerId): void {
  const told = new Set(m.meta.toldTo ?? []);
  told.add(to);
  m.meta.toldTo = [...told];
}

function emptySide(): Side {
  return { summary: '', learned: [], affinityDelta: 1 };
}

function parseSide(raw: unknown, offered: Offered[]): Side | null {
  const r = asRecord(raw);
  if (!r) return null;
  const learned: Learned[] = [];
  for (const item of asArray(pick(r, 'learned', 'facts', 'news', 'learnedFacts'))) {
    const ir = asRecord(item);
    const text = asString(ir ? pick(ir, 'text', 'fact', 'what') : item);
    if (!text) continue;
    const idx = asNumber(pick(ir, 'fromNewsIndex', 'newsIndex', 'index', 'from'));
    const imp = asNumber(pick(ir, 'importance', 'rating'));
    const o = idx !== undefined && Number.isInteger(idx) ? offered[idx] : undefined;
    learned.push({
      text: text.slice(0, 240),
      ...(imp !== undefined ? { importance: imp } : {}),
      ...(o ? { offered: o } : {}),
    });
  }
  const delta = asNumber(pick(r, 'affinityDelta', 'affinity', 'feeling', 'delta')) ?? 1;
  return {
    summary: (asString(pick(r, 'summary', 'text')) ?? '').slice(0, 240),
    learned,
    affinityDelta: delta,
  };
}

function matchOffered(text: string, offered: Offered[]): Offered | undefined {
  const kw = extractKeywords(text).filter((k) => k.length >= 3);
  let best: { o: Offered; ov: number } | undefined;
  for (const o of offered) {
    const ov = keywordOverlap(kw, extractKeywords(o.text));
    if (ov >= 0.5 && (!best || ov > best.ov)) best = { o, ov };
  }
  return best?.o;
}

const GREETINGS = [
  'Hi {p}! Lovely day, isn’t it?',
  'Oh, {p}! Good to see you.',
  'Hello {p}, how are you doing?',
];
const SMALL_TALK = [
  'I’ve been busy with {a}, but it’s nice to take a break.',
  'Things are good! Just {a} today.',
  'Not bad at all. I was just {a}.',
];

function fallbackTurn(
  speaker: Mind,
  listener: Mind,
  offered: Offered[],
  messages: readonly ConversationMessage[],
  turn: number,
  maxTurns: number,
): { say: string; end: boolean } {
  const p = listener.profile.name.split(' ')[0] ?? listener.profile.name;
  const act = speaker.lastView?.self.activity.text || 'going about my day';
  const mine = messages.filter((m) => m.speakerId === speaker.id).length;
  const pickOne = (xs: string[]) => xs[(speaker.id.length + turn) % xs.length]!;
  if (turn >= maxTurns - 1 || turn >= 3)
    return { say: `Well, I should get going. See you later, ${p}!`, end: true };
  const item = offered[mine];
  if (item)
    return { say: `${mine === 0 && turn === 0 ? `Hi ${p}! ` : ''}Did you hear? ${item.text}`, end: false };
  if (turn === 0) return { say: pickOne(GREETINGS).replace('{p}', p), end: false };
  return { say: pickOne(SMALL_TALK).replace('{a}', act), end: false };
}

export const createConversationRunner: CreateConversationRunner = (deps) => new LlmConversationRunner(deps);
