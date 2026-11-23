import type { WorldEvent, WorldEventKind } from '../../shared/types.ts';
import type { Ctx } from './context.ts';

/** Records of player-triggered world events; broadcasts `world.event` on open and close. */
export class WorldEventLog {
  events: WorldEvent[] = [];
  private readonly closeHandlers = new Map<WorldEventKind, (ev: WorldEvent) => void>();

  constructor(
    private readonly ctx: Ctx,
    restored?: WorldEvent[],
  ) {
    if (restored) this.events = structuredClone(restored);
  }

  onClose(kind: WorldEventKind, handler: (ev: WorldEvent) => void): void {
    this.closeHandlers.set(kind, handler);
  }

  open(kind: WorldEventKind, endsAt: number | null, data: Record<string, unknown>): WorldEvent {
    const ev: WorldEvent = {
      id: this.ctx.id(`world_${kind}`),
      kind,
      startedAt: this.ctx.host.now(),
      endsAt,
      data,
    };
    this.events.push(ev);
    this.emit(ev);
    return ev;
  }

  isOpen(ev: WorldEvent): boolean {
    return ev.data.ended !== true;
  }

  active(): WorldEvent[] {
    return this.events.filter((e) => this.isOpen(e));
  }

  close(ev: WorldEvent): void {
    if (!this.isOpen(ev)) return;
    const now = this.ctx.host.now();
    if (ev.endsAt === null || ev.endsAt > now) ev.endsAt = now;
    ev.data = { ...ev.data, ended: true };
    this.closeHandlers.get(ev.kind)?.(ev);
    this.emit(ev);
  }

  update(): void {
    const now = this.ctx.host.now();
    for (const ev of this.active()) if (ev.endsAt !== null && ev.endsAt <= now) this.close(ev);
    // Keep the save small: forget events that ended more than two days ago.
    this.events = this.events.filter((e) => this.isOpen(e) || (e.endsAt ?? now) > now - 2 * 1440);
  }

  private emit(ev: WorldEvent): void {
    this.ctx.emit({ type: 'world.event', event: structuredClone(ev) });
  }
}
