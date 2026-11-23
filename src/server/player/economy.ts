import {
  PLAYER_ID,
  type EventId,
  type PlanBlock,
  type PlayerState,
  type VillagerId,
} from '../../shared/types.ts';
import type { Ctx } from './context.ts';
import { distance, inRect } from './geometry.ts';

/** Gold, event-attendance rewards and "Ask to do it" task rewards (spec §7.14). */
export class Economy {
  private readonly presence = new Map<EventId, number>();
  private readonly lastStatus = new Map<EventId, string>();
  private readonly rewardedTasks = new Set<string>();
  private baselined = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly player: PlayerState,
  ) {}

  /** Positive or negative; gold never drops below 0. */
  addGold(amount: number, reason: string): void {
    if (amount === 0) return;
    this.player.gold = Math.max(0, this.player.gold + Math.round(amount));
    if (amount > 0) {
      this.ctx.toast('🪙', `+${amount} gold · ${reason}`);
      this.ctx.log(`${this.player.name} earned ${amount} gold (${reason})`);
    }
    this.ctx.emit({ type: 'player.updated', player: structuredClone(this.player) });
  }

  /** `MindWorld.taskCompleted`: pays the reward once per task id. */
  onTaskCompleted(villagerId: VillagerId, taskId: string, block: PlanBlock): void {
    this.baselined = true;
    if (this.rewardedTasks.has(taskId)) return;
    this.rewardedTasks.add(taskId);
    this.completeTask(villagerId, block.activity);
  }

  update(dt: number): void {
    this.trackEvents(dt);
    this.trackTasks();
  }

  private trackEvents(dt: number): void {
    for (const ev of this.ctx.host.villageEvents()) {
      const prev = this.lastStatus.get(ev.id);
      this.lastStatus.set(ev.id, ev.status);
      if (ev.status === 'happening') {
        const loc = this.ctx.location(ev.locationId);
        // House entries sit just outside the area (in front of the door), so count them too.
        if (loc && (inRect(loc.area, this.player.pos) || distance(loc.entry, this.player.pos) <= 1.5)) {
          this.presence.set(ev.id, (this.presence.get(ev.id) ?? 0) + dt);
        }
      }
      // Only reward transitions we saw happen; events already done when loaded are skipped.
      if (ev.status === 'done' && prev !== undefined && prev !== 'done') {
        const window = Math.max(1, ev.end - ev.start);
        if ((this.presence.get(ev.id) ?? 0) >= window * 0.5) {
          this.addGold(this.ctx.cfg.economy.eventReward, `attended ${ev.title}`);
        }
        this.presence.delete(ev.id);
      }
    }
  }

  /** Fallback for engines that do not call `onTaskCompleted`: watch plan blocks tagged `taskId`. */
  private trackTasks(): void {
    const first = !this.baselined;
    this.baselined = true;
    for (const v of this.ctx.host.villagers()) {
      for (const block of v.plan?.blocks ?? []) {
        if (!block.taskId || !block.done || this.rewardedTasks.has(block.taskId)) continue;
        this.rewardedTasks.add(block.taskId);
        // Task blocks already done on the first scan (a loaded save) were paid before saving.
        if (!first) this.completeTask(v.id, block.activity);
      }
    }
  }

  private completeTask(villagerId: VillagerId, text: string): void {
    const name = this.player.name;
    this.ctx.host.addMemory(villagerId, {
      at: this.ctx.host.now(),
      kind: 'event',
      text: `I did what ${name} asked: ${text}`,
      importance: 5,
    });
    this.ctx.host.adjustAffinity(villagerId, PLAYER_ID, 1);
    this.addGold(this.ctx.cfg.economy.taskReward, `${this.ctx.nameOf(villagerId)} finished your request`);
  }
}
