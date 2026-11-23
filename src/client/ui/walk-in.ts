import type { ClientMessage } from '../../shared/protocol.ts';
import type { Location, Point } from '../../shared/types.ts';
import { distance } from './places.ts';
import type { UiStore } from './store.ts';

/** Same reach the server checks for `player.enter`: on or next to the door or entry tile. */
const ENTER_REACH = 1.5;
/** Same reach the server checks for `player.buy` and `player.ride`: in the area or near its entry. */
export const VENUE_REACH = 3;
/** Give up on a walk that never arrives (blocked path, paused sim). */
const GIVE_UP_MS = 90_000;

function inArea(loc: Location, p: Point): boolean {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  const a = loc.area;
  return x >= a.x && y >= a.y && x < a.x + a.w && y < a.y + a.h;
}

export function nearDoor(loc: Location, p: Point): boolean {
  return distance(loc.door ?? loc.entry, p) <= ENTER_REACH || distance(loc.entry, p) <= ENTER_REACH;
}

export function nearVenue(loc: Location, p: Point): boolean {
  return inArea(loc, p) || distance(loc.entry, p) <= VENUE_REACH;
}

interface Pending {
  loc: Location;
  near: (p: Point) => boolean;
  action: ClientMessage;
  /** Re-checked on arrival: gold, stock or opening hours may have changed on the way. */
  stillValid: () => boolean;
  since: number;
  /** Set once a player.updated shows the server walking us to the entry. */
  acked: boolean;
  unsub: () => void;
}

const endsAt = (path: Point[], p: Point) => {
  const goal = path.at(-1);
  return !!goal && goal.x === p.x && goal.y === p.y;
};

/**
 * The server only accepts "Go inside", buy and ride next to the place, so walk to its entry
 * first and send the action on arrival. Any later path that does not end at the entry (the
 * player clicked somewhere else), stopping short, going inside, a new hello or a new walk-in
 * cancels it, so a stale arrival never fires the action.
 */
export class WalkIn {
  private pending: Pending | null = null;

  constructor(
    private readonly store: UiStore,
    private readonly send: (msg: ClientMessage) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get target(): Location['id'] | null {
    return this.pending?.loc.id ?? null;
  }

  enter(loc: Location): void {
    this.go(
      loc,
      (p) => nearDoor(loc, p),
      { type: 'player.enter', locationId: loc.id },
      () => true,
    );
  }

  /** Buy or ride at a venue; `stillValid` is checked again before sending on arrival. */
  use(loc: Location, action: ClientMessage, stillValid: () => boolean = () => true): void {
    this.go(loc, (p) => nearVenue(loc, p), action, stillValid);
  }

  cancel(): void {
    this.pending?.unsub();
    this.pending = null;
  }

  private go(
    loc: Location,
    near: (p: Point) => boolean,
    action: ClientMessage,
    stillValid: () => boolean,
  ): void {
    this.cancel();
    const player = this.store.player;
    if (!player || player.inside || !stillValid()) return;
    if (near(this.store.playerTile() ?? player.pos)) {
      this.send(action);
      return;
    }
    this.send({ type: 'player.move', to: loc.entry });
    this.store.toast('🚶', `Walking to ${loc.name}…`);
    const unsubPlayer = this.store.subscribe(['player'], () => this.onPlayer());
    // Positions arrive in tick frames ('villagers').
    const unsubTick = this.store.subscribe(['villagers'], () => this.onTick());
    const unsubHello = this.store.subscribe(['hello'], () => this.cancel());
    const unsub = () => {
      unsubPlayer();
      unsubTick();
      unsubHello();
    };
    this.pending = { loc, near, action, stillValid, since: this.now(), acked: false, unsub };
  }

  private onPlayer(): void {
    const p = this.pending;
    const player = this.store.player;
    if (!p || !player) return;
    if (player.inside) return this.cancel();
    if (endsAt(player.path, p.loc.entry)) {
      p.acked = true;
      return;
    }
    // Updates sent before the server took our move still carry the old path; ignore those.
    if (p.acked && player.path.length > 0) this.cancel();
  }

  private onTick(): void {
    const p = this.pending;
    const player = this.store.player;
    if (!p || !player) return;
    if (player.inside || this.now() - p.since > GIVE_UP_MS) return this.cancel();
    if (!p.near(this.store.playerTile() ?? player.pos)) return;
    this.cancel();
    if (p.stillValid()) this.send(p.action);
    else this.store.toast('⚠️', `Can't do that at ${p.loc.name} any more`);
  }
}
