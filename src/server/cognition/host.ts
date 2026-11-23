/** Helpers around the cognition ↔ engine ports defined in ./types.ts. */
import type { DayPlan, DoorNote, PlanBlock, VillageEvent, VillagerId } from '../../shared/types.ts';
import type { LearnedFact, MindWorld } from './types.ts';

export type MemoryWorld = MindWorld & {
  plan: DayPlan | null;
  thought: string;
  relationships: Record<VillagerId, { affinity: number; summary?: string }>;
  learned: LearnedFact[];
  tasks: { taskId: string; block: PlanBlock }[];
  eventList: VillageEvent[];
  noteList: DoorNote[];
};

/** In-memory MindWorld for tests and headless tools. Pass shared arrays to model one world. */
export function createMemoryWorld(shared: { events?: VillageEvent[]; notes?: DoorNote[] } = {}): MemoryWorld {
  const eventList = shared.events ?? [];
  const noteList = shared.notes ?? [];
  const w: MemoryWorld = {
    plan: null,
    thought: '',
    relationships: {},
    learned: [],
    tasks: [],
    eventList,
    noteList,
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
  };
  return w;
}
