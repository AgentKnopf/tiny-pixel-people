import type { PetState, PlayerState, Point } from '../../shared/types.ts';
import type { Ctx } from './context.ts';
import {
  distance,
  inRect,
  isWalkable,
  randomTileIn,
  stepAlong,
  tileOf,
  walkableNeighbours,
} from './geometry.ts';

export const PET_TILES_PER_MINUTE = 3;
/** Pet stays within this many tiles of the player in follow mode. */
export const PET_FOLLOW_DISTANCE = 2;
const TELEPORT_DISTANCE = 25;
const WANDER_EVERY_MINUTES = 12;

/** Deterministic pet movement (spec §7.15): follow, wander near an idle player, sit while the player is home. */
export class PetController {
  private path: Point[] = [];
  private targetFor: Point | null = null;
  private nextWanderAt = 0;

  constructor(private readonly ctx: Ctx) {}

  /** Returns true when the pet's tile or facing changed. */
  update(dt: number, player: PlayerState): boolean {
    const pet = player.pet;
    if (pet.mode === 'stay') {
      this.path = [];
      return false;
    }
    const before = { ...tileOf(pet.pos), facing: pet.facing };
    const now = this.ctx.host.now();
    const playerTile = tileOf(player.pos);
    const d = distance(pet.pos, player.pos);
    const home = this.ctx.home();
    const playerHome = home ? inRect(home.area, player.pos) : false;

    if (d > TELEPORT_DISTANCE) {
      this.placeNear(pet, player.pos);
    } else if (d > PET_FOLLOW_DISTANCE) {
      if (!this.targetFor || this.targetFor.x !== playerTile.x || this.targetFor.y !== playerTile.y) {
        this.repath(pet, playerTile);
      }
    } else if (
      !playerHome &&
      player.path.length === 0 &&
      this.path.length === 0 &&
      now >= this.nextWanderAt
    ) {
      this.nextWanderAt = now + WANDER_EVERY_MINUTES * (0.5 + this.ctx.host.random());
      const area = { x: playerTile.x - 2, y: playerTile.y - 2, w: 5, h: 5 };
      const spot = randomTileIn(
        this.ctx.host.map,
        area,
        () => this.ctx.host.random(),
        (p) =>
          distance(p, player.pos) > PET_FOLLOW_DISTANCE || (p.x === playerTile.x && p.y === playerTile.y),
      );
      if (spot) this.path = this.ctx.host.findPath(tileOf(pet.pos), spot) ?? [];
    }

    if (this.path.length > 0) {
      const step = stepAlong(pet.pos, this.path, PET_TILES_PER_MINUTE * dt);
      pet.pos = step.pos;
      this.path = step.path;
      if (step.facing) pet.facing = step.facing;
      if (this.path.length === 0) this.targetFor = null;
    }
    const after = tileOf(pet.pos);
    return after.x !== before.x || after.y !== before.y || pet.facing !== before.facing;
  }

  private repath(pet: PetState, playerTile: Point): void {
    this.targetFor = playerTile;
    const [goal] = walkableNeighbours(this.ctx.host.map, playerTile, pet.pos);
    const path = goal ? this.ctx.host.findPath(tileOf(pet.pos), goal) : null;
    if (path) this.path = path;
    else this.placeNear(pet, playerTile);
  }

  /** Jump next to the player (unreachable target, or after loading a save). */
  placeNear(pet: PetState, p: Point): void {
    const map = this.ctx.host.map;
    const [spot] = walkableNeighbours(map, p, p);
    pet.pos = spot ?? (isWalkable(map, tileOf(p)) ? tileOf(p) : { ...pet.pos });
    this.path = [];
    this.targetFor = null;
  }
}
