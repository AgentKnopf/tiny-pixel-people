/** Helpers around the cognition ↔ engine ports defined in ./types.ts. */
import type { DayPlan, DoorNote, Letter, PlanBlock, VillageEvent, VillagerId } from '../../shared/types.ts';
import type { LearnedFact, MindWorld } from './types.ts';

export type MemoryWorld = MindWorld & {
  plan: DayPlan | null;
  thought: string;
  relationships: Record<VillagerId, { affinity: number; summary?: string }>;
  learned: LearnedFact[];
  tasks: { taskId: string; block: PlanBlock }[];
  eventList: VillageEvent[];
  noteList: DoorNote[];
  letterList: Letter[];
};

/** In-memory MindWorld for tests and headless tools. Pass shared arrays to model one world. */
export function createMemoryWorld(
  shared: {
    events?: VillageEvent[];
    notes?: DoorNote[];
    letters?: Letter[];
    self?: VillagerId;
    now?: () => number;
  } = {},
): MemoryWorld {
  const eventList = shared.events ?? [];
  const noteList = shared.notes ?? [];
  const letterList = shared.letters ?? [];
  const w: MemoryWorld = {
    plan: null,
    thought: '',
    relationships: {},
    learned: [],
    tasks: [],
    eventList,
    noteList,
    letterList,
    setPlan(plan) {
      w.plan = plan;
    },
    setThought(text) {
      w.thought = text;
    },
    adjustRelationship(otherId, delta, summary) {
      const r = w.relationships[otherId] ?? { affinity: 0 };
      r.affinity = Math.max(-10, Math.min(10, r.affinity + delta));
      if (summary) r.summary = summary;
      w.relationships[otherId] = r;
    },
    upsertNote(note) {
      const i = noteList.findIndex((n) => n.id === note.id);
      if (i >= 0) noteList[i] = note;
      else noteList.push(note);
    },
    upsertEvent(event) {
      const i = eventList.findIndex((e) => e.id === event.id);
      if (i >= 0) eventList[i] = event;
      else eventList.push(event);
    },
    events: () => eventList,
    notes: () => noteList,
    recordLearned(fact) {
      w.learned.push(fact);
    },
    taskCompleted(taskId, block) {
      w.tasks.push({ taskId, block });
    },
    sendLetter(to, text, opts) {
      const letter: Letter = {
        id: `letter-${letterList.length + 1}`,
        from: shared.self ?? 'unknown',
        to,
        text,
        postedAt: shared.now?.() ?? 0,
        status: 'posted',
        ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
        ...(opts?.source ? { source: opts.source } : {}),
      };
      letterList.push(letter);
      return letter;
    },
  };
  return w;
}
