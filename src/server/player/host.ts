/**
 * Port between the player/economy/world-events module (WP8) and the simulation engine (WP2) plus
 * cognition (WP3). The engine implements this once and hands it to `createPlayerWorld`.
 *
 * Everything here is synchronous: the sim loop never awaits. Requests that need the LLM
 * (`requestPlayerReply`) are fire-and-forget; their effects come back through the normal engine /
 * cognition flow (conversation messages, plan blocks with `taskId`, `PlayerWorld.onTaskCompleted`).
 */
import type { Observation, PlayerInteraction } from '../cognition/types.ts';
import type { LlmQueue } from '../llm/types.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import type {
  DayPlan,
  GameMinutes,
  HouseVisit,
  Letter,
  LocationId,
  Provenance,
  Point,
  VillageEvent,
  VillagerId,
  VillagerProfile,
  VillagerState,
  WorldMap,
} from '../../shared/types.ts';
import type { CommandResult } from './types.ts';

/** `VillagerMind.replyToPlayer` input plus routing info for the engine. */
export interface PlayerReplyRequest extends PlayerInteraction {
  villagerId: VillagerId;
  /** Use this id for the villager's `conversation.message` reply so it pairs with the player's line. */
  conversationId: string;
  /** Mailbox placed: the reply may include `leaveNote` (spec §7.16 stretch). */
  mailboxPlaced: boolean;
}

export interface PlayerHost {
  readonly map: WorldMap;
  now(): GameMinutes;
  /** Seeded RNG in [0, 1). */
  random(): number;
  /** A* path from `from` to `to` (tile coords, excluding the start tile); null if unreachable. */
  findPath(from: Point, to: Point): Point[] | null;
  /** Live villager states, strangers included (read-only for WP8). */
  villagers(): readonly VillagerState[];
  /** Replace a villager's plan (rain swaps); same semantics as `MindWorld.setPlan`. */
  setPlan(villagerId: VillagerId, plan: DayPlan): void;
  profile(id: VillagerId): VillagerProfile | undefined;
  /** Store a memory for a villager (routes to `VillagerMind.observe`). */
  addMemory(villagerId: VillagerId, obs: Observation): void;
  /** Change a villager's affinity towards `otherId` (clamped by the implementation to -10..10). */
  adjustAffinity(villagerId: VillagerId, otherId: VillagerId, delta: number): void;
  /** Broadcast to all clients (and the replay log). */
  emit(msg: ServerMessage): void;

  /**
   * Villager answers the player via `VillagerMind.replyToPlayer` (WP3: `player.reply`, and `task.decide`
   * for mode 'ask'). The engine stops the villager briefly, broadcasts the reply as a
   * `conversation.message` (listener = player) and, for an accepted task, keeps the plan block tagged
   * `taskId`; when it completes (`MindWorld.taskCompleted`), call `PlayerWorld.onTaskCompleted`.
   */
  requestPlayerReply(req: PlayerReplyRequest): void;
  /** Start a conversation now, ignoring cooldowns but respecting sleep. */
  startConversation(aId: VillagerId, bId: VillagerId): CommandResult;
  /** Run `event.propose` for the best-suited villager now (`mind.requestEventProposal()`). */
  proposeTownEvent(): CommandResult;
  /** All village events (any status). */
  villageEvents(): readonly VillageEvent[];
  /** Register a new event; the engine sends invitations and runs the `event.decide` flow. */
  addVillageEvent(event: VillageEvent): void;
  /** Add a transient villager (mind seeded from `profile.seedMemories`) at `at`; broadcasts `villagers.changed`. */
  spawnVillager(profile: VillagerProfile, at: Point): void;
  /** Remove a transient villager (it may walk off first); broadcasts `villagers.changed`. */
  removeVillager(id: VillagerId): void;
  /** Optional LLM queue for `stranger.create` and `visitor.create`. */
  readonly llm?: LlmQueue;

  // ---------- v2 (optional until the engine wires them) ----------

  /** Current LLM load level (cognition); optional tasks degrade under 'overloaded'. Default 'normal'. */
  loadLevel?(): 'normal' | 'busy' | 'overloaded';
  /** Put the player in a ride's queue (RideService); the ride runs it like a villager rider. */
  joinRide?(rideId: LocationId): CommandResult;
  /** `world.trigger train`: bring the next train now (TrainService.triggerNow). */
  triggerTrain?(): CommandResult;
  /**
   * The player walked in while this owner is home and awake: the engine stops the owner for up to
   * 10 game minutes (status `talking`, emote 👋) and answers with `VillagerMind.greetVisitor`.
   * Memories and affinity are written by WP8; without this hook the template greeting is used.
   */
  requestGreeting?(villagerId: VillagerId, visit: HouseVisit): Promise<{ reply: string; source: Provenance }>;
  /** A villager read a letter at home (WP8 wrote the memory); forward to `VillagerMind.onLetterRead`. */
  letterRead?(villagerId: VillagerId, letter: Letter): void;
  /** The crow caws (`AnimalSim.caw('letter')`); it has its own cooldown. */
  caw?(reason: 'letter' | 'player'): void;
}
