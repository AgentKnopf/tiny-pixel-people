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
  since: number;
  unsub: () => void;
}

/**
 * The server only accepts "Go inside", buy and ride next to the place, so walk to its entry
 * first and send the action on arrival. A new path that no longer ends at the entry (the
 * player clicked somewhere else) cancels it.
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
    this.go(loc, (p) => nearDoor(loc, p), { type: 'player.enter', locationId: loc.id });
  }

  /** Buy or ride at a venue. */
  use(loc: Location, action: ClientMessage): void {
    this.go(loc, (p) => nearVenue(loc, p), action);
  }

  cancel(): void {
    this.pending?.unsub();
    this.pending = null;
  }

  private go(loc: Location, near: (p: Point) => boolean, action: ClientMessage): void {
    this.cancel();
    const player = this.store.player;
    if (!player || player.inside) return;
    if (near(this.store.playerTile() ?? player.pos)) {
      this.send(action);
      return;
    }
    this.send({ type: 'player.move', to: loc.entry });
    this.store.toast('🚶', `Walking to ${loc.name}…`);
    // Positions arrive in tick frames ('villagers'); new paths arrive in player.updated.
    const unsub = this.store.subscribe(['player', 'villagers'], () => this.check());
    this.pending = { loc, near, action, since: this.now(), unsub };
  }

  private check(): void {
    const p = this.pending;
    const player = this.store.player;
    if (!p || !player) return;
    if (player.inside) return this.cancel();
    if (p.near(this.store.playerTile() ?? player.pos)) {
      this.cancel();
      this.send(p.action);
      return;
    }
    const goal = player.path.at(-1);
    const redirected = !!goal && (goal.x !== p.loc.entry.x || goal.y !== p.loc.entry.y);
    if (redirected || this.now() - p.since > GIVE_UP_MS) this.cancel();
  }
}
