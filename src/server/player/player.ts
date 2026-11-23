import type { LearnedFact } from '../cognition/types.ts';
import type { AnimalChange } from '../sim/types.ts';
import { SAY_MAX_LENGTH, type ClientMessage, type ServerMessage } from '../../shared/protocol.ts';
import {
  PLAYER_HOME_ID,
  PLAYER_ID,
  type DoorNote,
  type FoodStock,
  type GameMinutes,
  type GroundItem,
  type HotelState,
  type ItemId,
  type LocationId,
  type Memory,
  type PlanBlock,
  type PlayerState,
  type Point,
  type Rumor,
  type VillagerId,
  type VillagerProfile,
  type VillagerState,
  type VisitorInfo,
  type Weather,
  type WorldEvent,
} from '../../shared/types.ts';
import { loadCatalogs, type WorldCatalogs } from './catalog.ts';
import { Ctx, type PlayerWorldConfig } from './context.ts';
import { DecorController } from './decor.ts';
import { Economy } from './economy.ts';
import { Farm, isOpen, nearLocation } from './farm-economy.ts';
import { Hotel } from './hotel.ts';
import { distance, isWalkable, stepAlong, tileOf, walkableNeighbours } from './geometry.ts';
import type { PlayerHost } from './host.ts';
import { addToBackpack, countOf, ItemField, removeFromBackpack } from './inventory.ts';
import { PetController } from './pet.ts';
import { Rumors } from './rumors.ts';
import { Strangers } from './strangers.ts';
import type { CommandResult, PlayerService } from './types.ts';
import { Visitors } from './visitors.ts';
import { WeatherController } from './weather.ts';
import { WorldEventLog } from './world-event-log.ts';
import { WorldEvents } from './world-events.ts';

export const PLAYER_TILES_PER_MINUTE = 2;
/** The player walks up to a villager first when farther than this (tiles). */
export const TALK_DISTANCE = 1.5;
export const PET_NAME_MAX = 24;

/** The part of a save / snapshot owned by WP8. */
export interface PlayerWorldSave {
  player: PlayerState;
  rumors: Rumor[];
  weather: Weather;
  items: GroundItem[];
  worldEvents: WorldEvent[];
  /** Transient profiles: v1 strangers and train visitors (`visitor: true`). */
  strangers: VillagerProfile[];
  // v2
  stock: FoodStock;
  /** null in a migrated v1 save: the hotel is built from config. */
  hotel: HotelState | null;
  visitors: VisitorInfo[];
}

export interface CreatePlayerWorldOptions {
  host: PlayerHost;
  config: PlayerWorldConfig;
  /** Default: loaded from ./data. */
  catalogs?: WorldCatalogs;
  restore?: Partial<PlayerWorldSave>;
}

type PlayerCommand = Exclude<
  Extract<ClientMessage, { type: `player.${string}` | 'world.trigger' | 'decor.toggle' | 'pet.command' }>,
  // v2 player commands (spec v2 §14): not handled yet.
  { type: 'player.enter' | 'player.exit' }
>;

const HANDLED = new Set<string>([
  'player.move',
  'player.say',
  'player.rumor',
  'player.pairTalk',
  'player.gift',
  'world.trigger',
  'decor.toggle',
  'pet.command',
  'player.buy',
  'player.ride',
]);

/**
 * WP8 facade: player avatar, gold, backpack, pet, decorating, rumors, weather and world events.
 * The engine calls `update(dt)` every sim step, routes commands through `handleCommand`, forwards
 * the cognition hooks (`onLearned`, `onTaskCompleted`, `onNoteRead`, `onDebugInject`) and puts
 * `snapshot()` into hello/state and `serialize()` into the save.
 */
export class PlayerWorld implements PlayerService {
  readonly ctx: Ctx;
  readonly rumors: Rumors;
  readonly events: WorldEvents;
  readonly weatherCtl: WeatherController;
  readonly items: ItemField;
  readonly strangers: Strangers;
  readonly economy: Economy;
  readonly decor: DecorController;
  readonly pet: PetController;
  readonly farm: Farm;
  readonly hotel: Hotel;
  readonly visitors: Visitors;
  private readonly log: WorldEventLog;
  private readonly player: PlayerState;

  constructor(opts: CreatePlayerWorldOptions) {
    const { host, config, restore = {} } = opts;
    this.ctx = new Ctx(host, config, opts.catalogs ?? loadCatalogs());
    this.player = restore.player ? structuredClone(restore.player) : this.initialPlayer();
    this.log = new WorldEventLog(this.ctx, restore.worldEvents);
    this.rumors = new Rumors(this.ctx, restore.rumors);
    this.weatherCtl = new WeatherController(this.ctx, this.log, restore.weather);
    this.items = new ItemField(this.ctx, restore.items);
    const transients = restore.strangers ?? [];
    this.strangers = new Strangers(
      this.ctx,
      this.log,
      transients.filter((p) => !p.visitor),
    );
    this.events = new WorldEvents(this.ctx, this.log, this.weatherCtl, this.strangers);
    this.economy = new Economy(this.ctx, this.player);
    this.farm = new Farm(this.ctx, this.player, (d, why) => this.economy.addGold(d, why), restore.stock);
    this.hotel = new Hotel(Math.max(this.ctx.hotel.rooms, this.ctx.visitors.max), restore.hotel);
    this.visitors = new Visitors(
      this.ctx,
      this.hotel,
      {
        updated: (visitor) => {
          this.ctx.emit({ type: 'visitor.updated', visitor: structuredClone(visitor) });
          this.ctx.emit({ type: 'hotel.updated', hotel: structuredClone(this.hotel.state()) });
        },
      },
      { infos: restore.visitors, profiles: transients.filter((p) => p.visitor) },
    );
    this.decor = new DecorController(this.ctx, this.player, (d, why) => this.economy.addGold(d, why));
    this.pet = new PetController(this.ctx);
  }

  get state(): Readonly<PlayerState> {
    return this.player;
  }

  get weather(): Readonly<Weather> {
    return this.weatherCtl.weather;
  }

  // ---------- engine loop ----------

  /** Advance by `dt` game minutes. Synchronous and cheap. */
  update(dt: number): void {
    const walked = this.movePlayer(dt);
    let changed = walked.length > 0;
    changed = this.collectItems(walked) || changed;
    changed = this.pet.update(dt, this.player) || changed;
    if (changed) this.broadcastPlayer();
    this.items.update();
    this.weatherCtl.update();
    this.log.update();
    this.economy.update(dt);
    this.decor.update();
    const now = this.ctx.host.now();
    if (this.farm.update(now)) this.broadcastStock();
    this.visitors.update(now);
  }

  /** Handles player.*, world.trigger, decor.toggle and pet.command; null for anything else. */
  handleCommand(cmd: ClientMessage): ServerMessage[] | null {
    if (!HANDLED.has(cmd.type)) return null;
    let res: CommandResult;
    try {
      res = this.run(cmd as PlayerCommand);
    } catch (err) {
      res = { ok: false, reason: (err as Error).message };
    }
    if (res.ok) return [];
    return [{ type: 'error', message: res.reason, ...(cmd.requestId ? { requestId: cmd.requestId } : {}) }];
  }

  private run(cmd: PlayerCommand): CommandResult {
    switch (cmd.type) {
      case 'player.move':
        return this.moveTo(cmd.to);
      case 'player.say':
        return this.say(cmd.villagerId, cmd.text, cmd.mode);
      case 'player.rumor':
        return this.tellRumor(cmd.villagerId, cmd.text);
      case 'player.pairTalk':
        return this.pairTalk(cmd.aId, cmd.bId);
      case 'player.gift':
        return this.gift(cmd.villagerId, cmd.itemId);
      case 'world.trigger':
        return this.events.trigger(cmd.kind, cmd.villagerId ? { villagerId: cmd.villagerId } : {});
      case 'decor.toggle':
        return this.toggleDecoration(cmd.itemId);
      case 'pet.command':
        return this.petCommand(cmd.action, cmd.name);
      case 'player.buy':
        return this.buy(cmd.locationId, cmd.itemId);
      case 'player.ride':
        return this.ride(cmd.locationId);
    }
  }

  // ---------- cognition / engine hooks ----------

  /** `MindWorld.recordLearned`: a fact passed between villagers; adds a rumor hop if it is tracked. */
  onLearned(fact: LearnedFact): Rumor | null {
    return this.rumors.recordLearned(fact);
  }

  /** `MindWorld.taskCompleted`: pay `economy.taskReward` once per task. */
  onTaskCompleted(villagerId: VillagerId, taskId: string, block: PlanBlock): void {
    this.economy.onTaskCompleted(villagerId, taskId, block);
  }

  /** The owner read a door note; `originId` is the note memory's originId. Starts a rumor. */
  onNoteRead(note: DoorNote, originId: string): Rumor {
    return this.rumors.start(note.text, note.authorId, originId, this.ctx.host.now(), [note.ownerId]);
  }

  /** `debug.inject` gave a villager a fact; track it as a rumor. */
  onDebugInject(villagerId: VillagerId, text: string, originId: string): Rumor {
    return this.rumors.start(text, PLAYER_ID, originId, this.ctx.host.now(), [villagerId]);
  }

  /** Optional: auto-track important `heard` memories as villager-started rumors. */
  onMemoryAdded(memory: Memory): Rumor | null {
    return this.rumors.considerMemory(memory);
  }

  // ---------- v2 engine hooks (spec v2 §3.4, §5) ----------

  /** AnimalSim step result: products and butcher yields become stock. */
  onAnimalChange(change: AnimalChange): void {
    const res = this.farm.onAnimalChange(change, this.ctx.host.now());
    for (const t of res.toasts) this.ctx.toast('🍔', t);
    if (res.changed) this.broadcastStock();
  }

  /**
   * A villager eats or buys at a food venue. Returns whether the item came from stock; a burger
   * that is sold out becomes a veggie burger, so villagers never wait (needs are the engine's job).
   */
  consumeFood(venueId: LocationId, itemId: ItemId): boolean {
    const fromStock = this.farm.take(venueId, itemId);
    if (fromStock && !venueId.startsWith('ice_cream_truck')) this.broadcastStock();
    return fromStock;
  }

  /** The train reached `boarding`: profiles for the engine to spawn on the platform. */
  onTrainArrived(now: GameMinutes): VillagerProfile[] {
    const arriving = this.visitors.onTrainArrived(now);
    if (arriving.length > 0) {
      const names = arriving.map((p) => p.name);
      this.ctx.toast(
        '🚂',
        `${names.join(' and ')} arrived by train${arriving.length === 1 ? '' : ' to stay at the hotel'}`,
      );
    }
    return arriving;
  }

  /** The train is leaving: ids of visitors that board now (the engine removes them). */
  onTrainDeparting(now: GameMinutes, onPlatform: readonly VillagerId[]): VillagerId[] {
    const names = new Map(onPlatform.map((id) => [id, this.ctx.nameOf(id)]));
    const boarding = this.visitors.onTrainDeparting(now, onPlatform);
    if (boarding.length > 0) {
      const who = boarding.map((id) => names.get(id) ?? this.ctx.nameOf(id));
      this.ctx.toast('👋', `${who.join(' and ')} left on the train`);
    }
    return boarding;
  }

  /** Mailbox placed: villagers may leave notes for the player (spec §7.16 stretch). */
  mailboxPlaced(): boolean {
    return this.player.placedDecorations.includes('mailbox');
  }

  // ---------- snapshot / save ----------

  snapshot(): Omit<PlayerWorldSave, 'strangers'> {
    const s = this.serialize();
    return {
      player: s.player,
      rumors: s.rumors,
      weather: s.weather,
      items: s.items,
      worldEvents: s.worldEvents,
      stock: s.stock,
      hotel: s.hotel,
      visitors: s.visitors,
    };
  }

  serialize(): PlayerWorldSave {
    return structuredClone({
      player: this.player,
      rumors: [...this.rumors.all()],
      weather: this.weatherCtl.weather,
      items: this.items.items,
      worldEvents: this.log.events,
      strangers: [...this.strangers.profiles, ...this.visitors.profiles.values()],
      stock: this.farm.stock(),
      hotel: this.hotel.state(),
      visitors: [...this.visitors.visitors()],
    });
  }

  // ---------- PlayerService ----------

  addGold(amount: number, reason: string): void {
    this.economy.addGold(amount, reason);
  }

  /** Pick up a ground item by its GroundItem id (normally automatic when the avatar walks onto it). */
  pickup(groundItemId: string): void {
    const item = this.items.take(groundItemId);
    if (!item) return;
    this.receive(item);
    this.items.broadcast();
    this.broadcastPlayer();
  }

  gift(villagerId: VillagerId, itemId: string): CommandResult {
    const v = this.awakeVillager(villagerId);
    if (!v.ok) return v;
    const def = this.items.def(itemId);
    if (!def) return { ok: false, reason: `Unknown item "${itemId}"` };
    if (countOf(this.player.inventory, itemId) < 1)
      return { ok: false, reason: `You have no ${def.name} to give` };
    removeFromBackpack(this.player, itemId);
    const profile = this.ctx.host.profile(villagerId);
    const liked = isLiked(profile?.likes ?? [], def.id, def.name);
    const name = this.player.name;
    this.ctx.host.addMemory(villagerId, {
      at: this.ctx.host.now(),
      kind: 'event',
      text: `${name} gave me a ${def.name.toLowerCase()} ${def.emoji}${liked ? ', one of my favourite things' : ''}`,
      importance: 5,
    });
    this.ctx.host.adjustAffinity(villagerId, PLAYER_ID, liked ? 2 : 1);
    this.approach(v.villager);
    this.ctx.host.requestPlayerReply({
      villagerId,
      text: `${name} gave you a ${def.name.toLowerCase()} ${def.emoji}`,
      mode: 'gift',
      itemId,
      liked,
      conversationId: playerConversationId(villagerId),
      mailboxPlaced: this.mailboxPlaced(),
    });
    this.ctx.toast('🎁', `You gave ${this.ctx.nameOf(villagerId)} a ${def.name.toLowerCase()}`);
    this.broadcastPlayer();
    return { ok: true };
  }

  toggleDecoration(itemId: string): CommandResult {
    return this.decor.toggle(itemId);
  }

  // ---------- commands ----------

  private moveTo(to: Point): CommandResult {
    const map = this.ctx.host.map;
    if (!to || !Number.isFinite(to.x) || !Number.isFinite(to.y))
      return { ok: false, reason: 'Invalid target' };
    const target = tileOf(to);
    if (!isWalkable(map, target)) return { ok: false, reason: "You can't walk there" };
    const from = tileOf(this.player.pos);
    if (from.x === target.x && from.y === target.y) {
      this.player.path = [];
      return { ok: true };
    }
    const path = this.ctx.host.findPath(from, target);
    if (!path) return { ok: false, reason: "You can't get there from here" };
    this.player.path = path;
    this.broadcastPlayer();
    return { ok: true };
  }

  private say(villagerId: VillagerId, raw: string, mode: 'say' | 'ask'): CommandResult {
    const v = this.awakeVillager(villagerId);
    if (!v.ok) return v;
    const text = cleanText(raw);
    if (!text.ok) return text;
    if (mode !== 'say' && mode !== 'ask') return { ok: false, reason: `Unknown mode "${String(mode)}"` };
    this.approach(v.villager);
    const conversationId = playerConversationId(villagerId);
    this.ctx.emit({
      type: 'conversation.message',
      conversationId,
      speakerId: PLAYER_ID,
      listenerId: villagerId,
      text: text.value,
      time: this.ctx.host.now(),
    });
    this.ctx.host.requestPlayerReply({
      villagerId,
      text: text.value,
      mode,
      conversationId,
      mailboxPlaced: this.mailboxPlaced(),
    });
    return { ok: true };
  }

  private tellRumor(villagerId: VillagerId, raw: string): CommandResult {
    const v = this.awakeVillager(villagerId);
    if (!v.ok) return v;
    const text = cleanText(raw);
    if (!text.ok) return text;
    const now = this.ctx.host.now();
    const originId = this.ctx.id('fact');
    this.approach(v.villager);
    this.ctx.emit({
      type: 'conversation.message',
      conversationId: playerConversationId(villagerId),
      speakerId: PLAYER_ID,
      listenerId: villagerId,
      text: text.value,
      time: now,
    });
    this.ctx.host.addMemory(villagerId, {
      at: now,
      kind: 'heard',
      text: `${this.player.name} told me: ${text.value}`,
      importance: 7,
      meta: { heardFrom: PLAYER_ID, originId },
    });
    this.rumors.start(text.value, PLAYER_ID, originId, now, [villagerId]);
    this.ctx.toast('🗣', `You whispered a rumor to ${this.ctx.nameOf(villagerId)}`);
    return { ok: true };
  }

  private buy(locationId: LocationId, itemId: ItemId): CommandResult {
    const res = this.farm.buy(locationId, itemId, this.ctx.host.now());
    if (res.ok) {
      if (!locationId.startsWith('ice_cream_truck')) this.broadcastStock();
      this.broadcastPlayer();
    }
    return res;
  }

  private ride(locationId: LocationId): CommandResult {
    const loc = this.ctx.location(locationId);
    if (!loc?.ride) return { ok: false, reason: `"${locationId}" is not a ride` };
    if (!isOpen(loc, this.ctx.host.now(), this.ctx.zoo))
      return { ok: false, reason: `The ${loc.name} is closed right now` };
    if (!nearLocation(loc, this.player.pos)) return { ok: false, reason: `Walk to the ${loc.name} first` };
    const cost = loc.ride.playerCost;
    if (this.player.gold < cost) return { ok: false, reason: `A ride costs ${cost} gold` };
    const join = this.ctx.host.joinRide;
    if (!join) return { ok: false, reason: 'The rides are not running yet' };
    const res = join.call(this.ctx.host, locationId);
    if (!res.ok) return res;
    this.economy.addGold(-cost, `ride on the ${loc.name}`);
    this.ctx.toast('🎢', `You joined the queue for the ${loc.name} (${cost} gold)`);
    return { ok: true };
  }

  private pairTalk(aId: VillagerId, bId: VillagerId): CommandResult {
    if (aId === bId) return { ok: false, reason: 'Pick two different villagers' };
    for (const id of [aId, bId])
      if (!this.ctx.villager(id)) return { ok: false, reason: `Unknown villager "${id}"` };
    return this.ctx.host.startConversation(aId, bId);
  }

  private petCommand(action: 'follow' | 'stay' | 'pet' | 'rename', name?: string): CommandResult {
    const pet = this.player.pet;
    switch (action) {
      case 'follow':
      case 'stay':
        pet.mode = action;
        this.ctx.toast('🐾', action === 'follow' ? `${pet.name} follows you` : `${pet.name} stays put`);
        break;
      case 'pet':
        this.ctx.toast('❤', `You pet ${pet.name}`);
        this.ctx.log(`${this.player.name} pet ${pet.name}`);
        return { ok: true };
      case 'rename': {
        const n = (name ?? '').trim();
        if (n.length < 1 || n.length > PET_NAME_MAX) {
          return { ok: false, reason: `Pet names need 1–${PET_NAME_MAX} characters` };
        }
        pet.name = n;
        this.ctx.toast('🐾', `Your pet is now called ${n}`);
        break;
      }
      default:
        return { ok: false, reason: `Unknown pet action "${String(action)}"` };
    }
    this.broadcastPlayer();
    return { ok: true };
  }

  // ---------- helpers ----------

  /** Returns the tiles reached this step (waypoints passed, then the current tile). */
  private movePlayer(dt: number): Point[] {
    if (this.player.path.length === 0) return [];
    const before = tileOf(this.player.pos);
    const step = stepAlong(this.player.pos, this.player.path, PLAYER_TILES_PER_MINUTE * dt);
    const passed = this.player.path.slice(0, this.player.path.length - step.path.length);
    this.player.pos = step.pos;
    this.player.path = step.path;
    if (step.facing) this.player.facing = step.facing;
    const after = tileOf(this.player.pos);
    const moved = after.x !== before.x || after.y !== before.y || step.path.length === 0;
    return moved ? [...passed, after] : [];
  }

  /** At high speed one step can cross several tiles, so check every tile walked over. */
  private collectItems(tiles: readonly Point[]): boolean {
    const taken = tiles.flatMap((t) => this.items.takeAt(t));
    if (taken.length === 0) return false;
    for (const item of taken) this.receive(item);
    this.items.broadcast();
    return true;
  }

  private receive(item: GroundItem): void {
    addToBackpack(this.player, item.itemId);
    const def = this.items.def(item.itemId);
    this.ctx.toast(def?.emoji ?? '🎒', `Picked up ${def ? def.name.toLowerCase() : item.itemId}`);
  }

  /** Walk next to a villager if the player is not already close. */
  private approach(v: VillagerState): void {
    if (distance(this.player.pos, v.pos) <= TALK_DISTANCE) return;
    const [goal] = walkableNeighbours(this.ctx.host.map, v.pos, this.player.pos);
    if (!goal) return;
    const path = this.ctx.host.findPath(tileOf(this.player.pos), goal);
    if (path) {
      this.player.path = path;
      this.broadcastPlayer();
    }
  }

  private awakeVillager(
    id: VillagerId,
  ): { ok: true; villager: VillagerState } | { ok: false; reason: string } {
    const villager = this.ctx.villager(id);
    if (!villager) return { ok: false, reason: `Unknown villager "${id}"` };
    if (villager.status === 'sleeping') return { ok: false, reason: `${this.ctx.nameOf(id)} is asleep` };
    return { ok: true, villager };
  }

  private broadcastStock(): void {
    this.ctx.emit({ type: 'stock.updated', stock: structuredClone(this.farm.stock()) });
  }

  private broadcastPlayer(): void {
    this.ctx.emit({ type: 'player.updated', player: structuredClone(this.player) });
  }

  private initialPlayer(): PlayerState {
    const home = this.ctx.location(PLAYER_HOME_ID);
    const map = this.ctx.host.map;
    const start = home?.entry ?? { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) };
    const [petSpot] = walkableNeighbours(map, start, start);
    const { name, petName, petSpecies } = this.ctx.cfg.player;
    return {
      id: PLAYER_ID,
      name,
      pos: { ...start },
      facing: 'down',
      path: [],
      homeId: PLAYER_HOME_ID,
      gold: this.ctx.cfg.economy.startGold,
      inventory: [],
      ownedDecorations: [],
      placedDecorations: [],
      pet: {
        name: petName,
        species: petSpecies,
        pos: petSpot ?? { ...start },
        facing: 'down',
        mode: 'follow',
      },
    };
  }
}

export function createPlayerWorld(opts: CreatePlayerWorldOptions): PlayerWorld {
  return new PlayerWorld(opts);
}

/** Stable conversation id for player ↔ villager chat bubbles. */
export function playerConversationId(villagerId: VillagerId): string {
  return `player:${villagerId}`;
}

/** A gift is liked when a `likes` entry names the item id or appears in its name. */
export function isLiked(likes: readonly string[], itemId: string, itemName: string): boolean {
  const name = itemName.toLowerCase();
  return likes.some((l) => {
    const k = l.toLowerCase().trim();
    return k.length > 0 && (k === itemId.toLowerCase() || name.includes(k));
  });
}

function cleanText(raw: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, reason: 'Say something first' };
  if (value.length > SAY_MAX_LENGTH)
    return { ok: false, reason: `Keep it under ${SAY_MAX_LENGTH} characters` };
  return { ok: true, value };
}
