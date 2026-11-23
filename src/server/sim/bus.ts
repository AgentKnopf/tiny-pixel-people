import type {
  Conversation,
  DayPlan,
  DoorNote,
  GameMinutes,
  LocationId,
  PlanBlock,
  Point,
  VillageEvent,
  VillagerId,
} from '../../shared/types.ts';
import type { LearnedFact } from '../cognition/types.ts';
import type { AnimalStepResult } from './animals.ts';
import type { RideEvent } from './rides.ts';
import type { TrainEvent } from './train.ts';
import { createLogger } from '../log.ts';

const log = createLogger('bus');

/** Internal engine events other server modules (cognition, player, persistence) can hook into. */
export interface SimEvents {
  'day.start': { day: number; time: GameMinutes };
  step: { time: GameMinutes; dt: number };
  'villager.arrived': { villagerId: VillagerId; locationId: LocationId };
  'conversation.started': { conversation: Conversation };
  'conversation.ended': { conversation: Conversation };
  'event.started': { event: VillageEvent };
  /** `playerAttended`: the player avatar was inside the event area for >= 50 % of the window. */
  'event.done': { event: VillageEvent; playerAttended: boolean };
  /** The player avatar entered a new tile. */
  'player.tile': { pos: Point };
  /** A plan block's end time passed (`block.done` is already set). */
  'block.done': { villagerId: VillagerId; block: PlanBlock };
  'note.posted': { note: DoorNote };
  /** A mind reported a learned fact (MindWorld.recordLearned); WP8's RumorTracker records hops. */
  learned: { fact: LearnedFact };
  /** A mind reported a finished player task (MindWorld.taskCompleted); WP8 pays the reward. */
  'task.completed': { villagerId: VillagerId; taskId: string; block: PlanBlock };
  /** A villager's plan was replaced (mind or player task). */
  'plan.changed': { villagerId: VillagerId; plan: DayPlan | null };
  /** v2: what the animal sim did this step (births, removals, products, emotes, toasts). */
  'animals.step': { time: GameMinutes; change: AnimalStepResult };
  train: TrainEvent;
  ride: RideEvent;
}

export type SimEventName = keyof SimEvents;
type Listener<K extends SimEventName> = (payload: SimEvents[K]) => void;

export class SimBus {
  private readonly listeners = new Map<SimEventName, Set<Listener<never>>>();

  on<K extends SimEventName>(name: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(fn as Listener<never>);
    return () => set.delete(fn as Listener<never>);
  }

  emit<K extends SimEventName>(name: K, payload: SimEvents[K]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as Listener<K>)(payload);
      } catch (err) {
        log.error(`listener for "${name}" failed`, err);
      }
    }
  }
}
