/**
 * Conversation runner (spec §7.5–§7.6): alternating `convo.turn` calls, then one `convo.summarize`
 * that stores conversation + heard memories for both villagers and propagates gossip origin ids.
 * The runner only appends to `conversation.messages`; the engine broadcasts them.
 */
import type {
  Conversation,
  ConversationMessage,
  Memory,
  Provenance,
  VillagerId,
} from '../../shared/types.ts';
import { asArray, asBool, asNumber, asRecord, asString, clamp, pick } from './json.ts';
import { extractKeywords, keywordOverlap } from './keywords.ts';
import { ask, loadTracker, type LoadLevel } from './llm.ts';
import { Mind, PRIORITY, cleanLine } from './mind.ts';
import { bestSentence, findMention, newsText, retoldText } from './gossip.ts';
import { keepLines, keepMeta } from './post.ts';
import { convoSummarizePrompt, convoTurnPrompt } from './prompts/social.ts';
import { settingsFromConfig } from './settings.ts';
import { villageFor } from './village.ts';
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
    const start = this.deps.now();
    const offer = (m: Mind, other: Mind): Offered[] =>
      m.newsFor(other.id, start).map((x) => ({ id: x.id, text: newsText(x), by: m.id, memory: x }));
    let pair: [Mind, Mind] = [a, b];
    let news: [Offered[], Offered[]] = [offer(a, b), offer(b, a)];
    // Whoever has news opens, so it is said even if the chat is cut short.
    if (news[0].length === 0 && news[1].length > 0 && conversation.messages.length === 0) {
      pair = [b, a];
      news = [news[1], news[0]];
    }
    const names: Record<VillagerId, string> = { [a.id]: a.profile.name, [b.id]: b.profile.name };
    const load = this.load();
    const shy = !!a.romance.shyWith(b.id);
    const maxTurns = Math.min(
      this.settings.maxConversationTurns,
      load === 'normal' ? Infinity : load === 'busy' ? 4 : 3,
      shy ? (this.deps.config.romance?.shyMaxTurns ?? 3) : Infinity,
    );
    const endBy = conversation.startedAt + this.settings.maxConversationGameMinutes;
    for (let turn = conversation.messages.length; turn < maxTurns; turn++) {
      if (conversation.status !== 'active') break;
      if (this.deps.now() > endBy) break;
      const si = turn % 2;
      const speaker = pair[si]!;
      const listener = pair[1 - si]!;
      const res = await this.turn(
        conversation,
        speaker,
        listener,
        news[si]!,
        news[1 - si]!,
        names,
        turn,
        maxTurns,
        endBy,
        shy,
      );
      if (conversation.status !== 'active') break;
      const msg: ConversationMessage = {
        speakerId: speaker.id,
        text: res.say,
        at: this.deps.now(),
        source: res.source,
      };
      conversation.messages.push(msg);
      if (res.end && turn >= 1) break;
    }
    if (conversation.status === 'active') this.closeWithEcho(conversation, pair, news);
    if (conversation.status === 'active') conversation.status = 'ended';
    conversation.endedAt ??= this.deps.now();
    // Before the (possibly slow) summary: who now knows what, so nobody is told the same news twice.
    const endAt = this.deps.now();
    const sides: [Mind, Mind, Offered[]][] = [
      [pair[0], pair[1], news[0]],
      [pair[1], pair[0], news[1]],
    ];
    for (const [self, other, offered] of sides) {
      self.noteTalk(other.id, endAt);
      for (const o of offered)
        if (findMention(o.text, conversation.messages, self.id)) markTold(o.memory, other.id);
    }
    if (conversation.messages.length > 0) await this.wrapUp(conversation, pair, news, names);
    // After the summary, so this chat already counts toward the talks a date needs.
    a.romance.afterConversation(b.id, conversation);
    b.romance.afterConversation(a.id, conversation);
    return conversation;
  }

  /**
   * A chat cut short (turn cap, time) right after news was told still gets the listener's reaction:
   * news that is never repeated does not stick, and on a slow model the next chat may be hours away.
   */
  private closeWithEcho(conv: Conversation, pair: [Mind, Mind], news: [Offered[], Offered[]]): void {
    const last = conv.messages.at(-1);
    if (!last) return;
    const si = pair[0].id === last.speakerId ? 0 : 1;
    const listener = pair[1 - si]!;
    const told = news[si]!.find((o) => findMention(o.text, [last], last.speakerId));
    if (!told || findMention(told.text, conv.messages, listener.id)) return;
    conv.messages.push({
      speakerId: listener.id,
      text: `${echoLine(told.text)} I had no idea!`,
      at: this.deps.now(),
      source: 'fallback',
    });
  }

  private load(): LoadLevel {
    if (villageFor(this.deps.queue).dawnRush()) return 'overloaded';
    return loadTracker(this.deps.queue).level(this.deps.now());
  }

  private async turn(
    conv: Conversation,
    speaker: Mind,
    listener: Mind,
    offered: Offered[],
    heard: Offered[],
    names: Record<VillagerId, string>,
    turn: number,
    maxTurns: number,
    endBy: number,
    shy = false,
  ): Promise<{ say: string; end: boolean; source: Provenance }> {
    const view = speaker.lastView;
    const now = this.deps.now();
    const load = this.load();
    const fallback = () => fallbackTurn(speaker, listener, offered, heard, conv.messages, turn, maxTurns);
    // The speaker's first line with news always gets a real model attempt (the canned line is
    // only the safety net); other lines are canned when the model is overloaded.
    const firstNews = offered.length > 0 && !conv.messages.some((m) => m.speakerId === speaker.id);
    if (load === 'overloaded' && !firstNews) return { ...fallback(), source: 'fallback' };
    const last = conv.messages.at(-1);
    const justHeard =
      last?.speakerId === listener.id
        ? heard.find((h) => findMention(h.text, [last], listener.id))
        : undefined;
    const place = conv.locationId ? speaker.locName(view, conv.locationId) : 'the village path';
    const memories = await speaker.recall(`${listener.profile.name} ${place}`, now, { k: 5 });
    const keep = speaker.checkKeep(view, `${listener.profile.name} ${last?.text ?? ''}`);
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
      ...(justHeard ? { justHeard: justHeard.text } : {}),
      keep: keepLines(keep, (id) => speaker.nameOf(id, view)),
      shy,
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
        ...(keep.length ? { keep: keepMeta(keep) } : {}),
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
      fallback,
      shape: '{"say":"...","end":false}',
      now: () => this.deps.now(),
      // A line that comes too late is replaced by a canned one so the chat keeps moving.
      deadline: Math.max(now + 20, Math.min(endBy, now + (load === 'normal' || firstNews ? 45 : 20))),
      noRepair: load !== 'normal',
      ...(firstNews ? { priority: PRIORITY.convoFirstNews } : {}),
      temperature: this.settings.temperature,
      maxTokens: 70,
    });
    const out = { ...res.value, source: res.source };
    // Short chats under load may not get another chance: news the model left out is appended.
    const carried = offered.find((o) =>
      findMention(o.text, [{ speakerId: speaker.id, text: out.say, at: now }], speaker.id, 0.3),
    );
    if (firstNews && load !== 'normal' && !carried) {
      const item = offered.find((o) => o.memory.kind !== 'reflection') ?? offered[0]!;
      return { say: `${out.say} Did you hear? ${item.text}`.slice(0, 300), end: false, source: 'fallback' };
    }
    // News that is not acknowledged does not stick: a reply that ignores it gets a short echo.
    // The patched line is partly canned, so it counts as a fallback.
    if (
      justHeard &&
      res.source === 'llm' &&
      !findMention(justHeard.text, [{ ...last!, speakerId: speaker.id, text: out.say }], speaker.id, 0.3)
    )
      return { ...out, say: `${echoLine(justHeard.text)} ${out.say}`.slice(0, 300), source: 'fallback' };
    return out;
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
      // Under load the heuristic summary (offered news that was demonstrably said) is enough.
      offline: this.load() !== 'normal',
      now: () => this.deps.now(),
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
        text: `${other.profile.name} told me: ${retoldText(l.text)}`.slice(0, 300),
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
  heard: Offered[],
  messages: readonly ConversationMessage[],
  turn: number,
  maxTurns: number,
): { say: string; end: boolean } {
  const p = listener.profile.name.split(' ')[0] ?? listener.profile.name;
  const act = speaker.lastView?.self.activity.text || 'going about my day';
  const mine = messages.filter((m) => m.speakerId === speaker.id).length;
  const pickOne = (xs: string[]) => xs[(speaker.id.length + turn) % xs.length]!;
  // React to news the partner just told, repeating it (that is how it sticks and spreads).
  const last = messages.at(-1);
  if (last && last.speakerId === listener.id) {
    const news = heard.find((h) => findMention(h.text, [last], listener.id));
    const echoed = news && findMention(news.text, messages, speaker.id);
    if (news && !echoed) return { say: `${echoLine(news.text)} I had no idea!`, end: false };
  }
  if (turn >= maxTurns - 1 || turn >= 3)
    return { say: `Well, I should get going. See you later, ${p}!`, end: true };
  // Reflections read oddly as canned news; canned lines only pass on concrete facts.
  const item = offered.filter((o) => o.memory.kind !== 'reflection')[mine];
  if (item)
    return { say: `${mine === 0 && turn === 0 ? `Hi ${p}! ` : ''}Did you hear? ${item.text}`, end: false };
  if (turn === 0) return { say: pickOne(GREETINGS).replace('{p}', p), end: false };
  return { say: pickOne(SMALL_TALK).replace('{a}', act), end: false };
}

function echoLine(fact: string): string {
  const f = fact.replace(/[.!]+$/, '').trim();
  return `Really? ${f.charAt(0).toUpperCase()}${f.slice(1)}?`;
}

export const createConversationRunner: CreateConversationRunner = (deps) => new LlmConversationRunner(deps);
