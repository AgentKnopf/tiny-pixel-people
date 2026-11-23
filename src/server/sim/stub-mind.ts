import { dayOf, minuteOfDay } from '../../shared/time.ts';
import type {
  Conversation,
  DayPlan,
  LocationId,
  Memory,
  MemoryKind,
  VillagerId,
  VillagerProfile,
} from '../../shared/types.ts';
import type {
  ConversationRunner,
  Intent,
  MindDeps,
  MindSnapshot,
  Observation,
  PlayerInteraction,
  PlayerReply,
  VillagerMind,
  WorldView,
} from '../cognition/types.ts';
import { NEED_RECOVERED, urgentNeedFix, type NeedFix } from './needs.ts';
import { buildFallbackPlan, currentBlock, intentFromPlan } from './plan.ts';

const KIND_IMPORTANCE: Record<MemoryKind, number> = {
  observation: 2,
  conversation: 4,
  heard: 5,
  reflection: 7,
  plan: 3,
  note: 8,
  event: 6,
  summary: 5,
};

const STOPWORDS = new Set(
  'the a an and or of to in on at is are was were i my me you it for with by from'.split(' '),
);

function keywordsOf(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => !STOPWORDS.has(w)))];
}

/**
 * Deterministic mind without any LLM: fallback plans, the needs override, door-note replies and
 * affinity-based chat willingness. The engine uses it until WP3's `createMind` is wired in, and
 * tests use it to exercise the engine in isolation.
 */
export class StubMind implements VillagerMind {
  readonly id: VillagerId;
  private readonly memoryList: Memory[];
  private seq = 0;
  private plan: DayPlan | null = null;
  private needOverride: NeedFix | null = null;

  constructor(
    private readonly profile: VillagerProfile,
    private readonly deps: MindDeps,
  ) {
    this.id = profile.id;
    this.memoryList = deps.snapshot ? [...deps.snapshot.memories] : [];
    this.seq = this.memoryList.length;
    if (!deps.snapshot) {
      for (const text of profile.seedMemories ?? []) {
        this.observe({ at: deps.now(), kind: 'observation', text, importance: 4 });
      }
    }
  }

  update(view: WorldView): Intent {
    const day = dayOf(view.now);
    this.plan = view.self.plan;
    if (!this.plan || this.plan.day !== day) {
      this.plan = buildFallbackPlan(this.profile, day, view.locations, view.now);
      this.deps.world.setPlan(this.plan);
    }
    const block = currentBlock(this.plan, view.now);
    if (this.needOverride && view.self.needs[this.needOverride.need] >= NEED_RECOVERED)
      this.needOverride = null;
    if (!this.needOverride && view.self.status !== 'sleeping') {
      this.needOverride = urgentNeedFix(view.self.needs, block, view.locations, this.profile.homeId);
    }
    const base = intentFromPlan(this.profile, this.plan, view.events, view.now);
    if (this.needOverride && base.type === 'goto' && !/^(host|attend) the /.test(base.activity)) {
      const o = this.needOverride;
      return { type: 'goto', locationId: o.locationId, activity: o.activity, emoji: o.emoji };
    }
    return base;
  }

  observe(obs: Observation): void {
    const id = `${this.id}-m${++this.seq}`;
    this.memoryList.push({
      id,
      villagerId: this.id,
      createdAt: obs.at,
      lastAccessedAt: obs.at,
      kind: obs.kind,
      text: obs.text,
      importance: obs.importance ?? KIND_IMPORTANCE[obs.kind],
      keywords: keywordsOf(obs.text),
      meta: { ...obs.meta, originId: obs.meta?.originId ?? id },
    });
  }

  onArrive(view: WorldView, locationId: LocationId): void {
    if (locationId !== this.profile.homeId) return;
    const unread = view.notesAtHome
      .filter((n) => n.status === 'unread' && n.ownerId === this.id)
      .sort((a, b) => a.postedAt - b.postedAt);
    for (const note of unread) {
      const now = view.now;
      this.observe({
        at: now,
        kind: 'note',
        text: `I found a note on my door: "${note.text}"`,
        importance: 8,
        meta: { noteId: note.id },
      });
      const words = note.text.split(/\s+/).slice(0, 6).join(' ');
      this.deps.world.upsertNote({
        ...note,
        status: 'replied',
        readAt: now,
        reply: `Thanks for your note about "${words}". I'll think it over!`,
        repliedAt: now,
        replySource: 'fallback',
      });
    }
  }

  wantsToTalkTo(view: WorldView, otherId: VillagerId): boolean {
    const affinity = view.self.relationships[otherId]?.affinity ?? 0;
    const p = Math.max(0.1, Math.min(0.9, 0.35 + affinity * 0.05));
    return this.deps.random() < p;
  }

  async replyToPlayer(view: WorldView, input: PlayerInteraction): Promise<PlayerReply> {
    const playerName = view.villagerNames['player'] ?? 'friend';
    this.observe({
      at: view.now,
      kind: 'conversation',
      text:
        input.mode === 'gift'
          ? `${playerName} gave me a ${input.itemId ?? 'gift'}.`
          : `${playerName} said to me: "${input.text}"`,
      importance: input.mode === 'gift' ? 5 : 4,
      meta: { heardFrom: 'player' },
    });
    if (input.mode === 'gift') {
      return { reply: input.liked ? 'Oh, I love these! Thank you so much!' : 'How kind of you, thank you!' };
    }
    if (input.mode === 'ask') {
      return { reply: `I'd love to help, but my day is already full. Maybe tomorrow!` };
    }
    return { reply: `${StubMind.greeting(view.now)}, ${playerName}! Nice to see you.` };
  }

  requestEventProposal(): void {
    // The stub mind never proposes events.
  }

  serialize(): MindSnapshot {
    return {
      villagerId: this.id,
      memories: [...this.memoryList],
      bookkeeping: { importanceSinceReflection: 0, lastReflectionAt: null, lastPlanAt: null },
    };
  }

  /** Hour-of-day helper used by the stub conversation lines. */
  static greeting(t: number): string {
    const h = Math.floor(minuteOfDay(t) / 60);
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }
}

export function createStubMind(profile: VillagerProfile, deps: MindDeps): VillagerMind {
  return new StubMind(profile, deps);
}

/** Two-line small talk without an LLM. Stores a conversation memory for both participants. */
export function createStubConversationRunner(
  names: (id: VillagerId) => string,
  now: () => number,
): ConversationRunner {
  return {
    async run(conversation: Conversation, minds): Promise<Conversation> {
      const [a, b] = conversation.participants;
      const t = now();
      conversation.messages.push({
        speakerId: a,
        text: `${StubMind.greeting(t)}, ${names(b)}! Lovely day, isn't it?`,
        at: t,
        source: 'fallback',
      });
      conversation.messages.push({
        speakerId: b,
        text: `It is, ${names(a)}. Good to see you.`,
        at: t,
        source: 'fallback',
      });
      for (const [i, mind] of minds.entries()) {
        const other = conversation.participants[1 - i]!;
        mind.observe({
          at: t,
          kind: 'conversation',
          text: `I had a short chat with ${names(other)}.`,
          meta: { conversationId: conversation.id },
        });
      }
      conversation.status = 'ended';
      return conversation;
    },
  };
}
