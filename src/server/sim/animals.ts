/**
 * Deterministic animals (spec v2 §3): zoo enclosures, the farm lifecycle with hard caps and the
 * off-screen butcher, forest animals that flee from people, ducks on the lake and the post office
 * crow. Seeded RNG only, no LLM and no A*: every animal wanders inside its `pen` rect.
 *
 * Randomness is split into independent streams (one per animal, one per farm species and day,
 * one per crow day) derived from `sim.seed`, so one animal's behaviour never shifts another's and
 * a restored save continues deterministically without storing RNG state.
 */
import {
  FARM_CAP_PER_SPECIES,
  FARM_SPECIES,
  type AnimalFrame,
  type AnimalSpecies,
  type AnimalState,
  type AnimalStatus,
  type Facing,
  type FarmSpecies,
  type FarmState,
  type ForestSpecies,
  type GameMinutes,
  type Location,
  type LocationId,
  type Point,
  type Rect,
  type WorldMap,
} from '../../shared/types.ts';
import { dayOf, MINUTES_PER_DAY, minuteOfDay, parseClock } from '../../shared/time.ts';
import type { AppConfig } from '../config.ts';
import { Rng } from './rng.ts';
import type { AnimalChange, AnimalSim } from './types.ts';

// ---------- static tables ----------

interface FarmSpec {
  adultAt: number;
  elderAt: number;
  lifespan: [number, number];
  initial: { female: number; male: number };
  product: { itemId: string; everyDays: number; femaleOnly: boolean };
  home: LocationId;
  birthToast: string;
  baby: string;
  emoji: string;
}

/** `lastBirthAt` is saved with the animal (plain JSON) so the per-mother gap survives a restore. */
type FarmAnimal = AnimalState & { lastBirthAt?: GameMinutes };

export const FARM_TABLE: Record<FarmSpecies, FarmSpec> = {
  cow: {
    adultAt: 3,
    elderAt: 12,
    lifespan: [14, 18],
    initial: { female: 2, male: 2 },
    product: { itemId: 'milk', everyDays: 1, femaleOnly: true },
    home: 'cow_pasture',
    birthToast: '🐄 A calf was born on the cow pasture!',
    baby: 'calf',
    emoji: '🐄',
  },
  sheep: {
    adultAt: 3,
    elderAt: 10,
    lifespan: [12, 16],
    initial: { female: 2, male: 2 },
    product: { itemId: 'wool', everyDays: 3, femaleOnly: false },
    home: 'sheep_pasture',
    birthToast: '🐑 A lamb was born on the sheep pasture!',
    baby: 'lamb',
    emoji: '🐑',
  },
  chicken: {
    adultAt: 2,
    elderAt: 6,
    lifespan: [8, 12],
    initial: { female: 4, male: 2 },
    product: { itemId: 'egg', everyDays: 1, femaleOnly: true },
    home: 'chicken_coop',
    birthToast: '🐣 A chick hatched at the coop!',
    baby: 'chick',
    emoji: '🐔',
  },
};

/** Daily lifecycle, production and butcher times (minute of day). */
const LIFECYCLE_AT = 6 * 60;
const PRODUCTION_AT = 7 * 60;
const ELDER_DEATH_CHANCE = 0.05;
const BIRTH_GAP_DAYS = 2;
const BUTCHER_MAX_MINUTES = 120;
const BUTCHER_BURGER_LOW = 4;
const BUTCHER_BURGER_ADULTS = 6;
const CAW_COOLDOWN = 30;
const FLEE_RADIUS = 3;
const FLEE_STEPS = 4;
const CROW_FLIGHT_RADIUS = 3;

/** Awake window [from, to) in minutes of day; wraps past midnight when from > to. */
const AWAKE: Record<string, [number, number]> = {
  cow: [300, 1260],
  sheep: [300, 1260],
  chicken: [360, 1200],
  zoo: [360, 1260],
  deer: [300, 1260],
  rabbit: [360, 1200],
  squirrel: [420, 1140],
  hedgehog: [1140, 360],
  fox: [1080, 420],
  bird: [360, 1200],
  duck: [360, 1200],
  crow: [360, 1200],
};

export const FOREST_COUNTS: Record<ForestSpecies, number> = {
  deer: 3,
  rabbit: 5,
  squirrel: 4,
  hedgehog: 2,
  fox: 2,
  bird: 6,
  duck: 5,
};

/** Species that may stand on blocked tiles of their pen (water, trees). */
const ANY_TILE = new Set<AnimalSpecies>(['penguin', 'hippo', 'crocodile', 'flamingo', 'bird', 'squirrel']);

const NAMES: Partial<Record<AnimalSpecies, string[]>> = {
  cow: [
    'Bessie',
    'Daisy',
    'Clover',
    'Buttercup',
    'Mabel',
    'Bruno',
    'Duke',
    'Rosie',
    'Hazel',
    'Otis',
    'Pearl',
    'Barney',
  ],
  sheep: [
    'Woolly',
    'Fluffy',
    'Dolly',
    'Shaun',
    'Cotton',
    'Bramble',
    'Lulu',
    'Basil',
    'Misty',
    'Pip',
    'Nutmeg',
    'Ziggy',
  ],
  chicken: [
    'Henrietta',
    'Penny',
    'Goldie',
    'Nugget',
    'Pepper',
    'Ginger',
    'Clucky',
    'Rocky',
    'Sunny',
    'Dotty',
    'Mo',
    'Biscuit',
  ],
  lion: ['Leo', 'Nala'],
  elephant: ['Ellie', 'Jumbo'],
  giraffe: ['Gigi', 'Stretch'],
  zebra: ['Ziggy', 'Stripes'],
  penguin: ['Pingu', 'Waddles', 'Flipper'],
  monkey: ['Momo', 'Coco'],
  panda: ['Bao', 'Mei'],
  flamingo: ['Rosa', 'Flo', 'Pinky'],
  kangaroo: ['Joey', 'Skip'],
  polar_bear: ['Frost', 'Nanook'],
  hippo: ['Gloria', 'Hugo'],
  crocodile: ['Snappy', 'Chomp'],
};

// ---------- helpers ----------

/** FNV-1a over the seed and a key; used to derive independent RNG streams. */
function streamSeed(seed: number, key: string): number {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  return h;
}

function isAwake(minute: number, [from, to]: [number, number]): boolean {
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
}

function inRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
}

const key = (p: Point) => p.y * 100_000 + p.x;
const dist2 = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const cheb = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function facingFor(from: Point, to: Point, prev: Facing): Facing {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return prev;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

/** Straight axis-aligned steps from a (exclusive) to b (inclusive). */
function straightPath(a: Point, b: Point): Point[] {
  const out: Point[] = [];
  let { x, y } = a;
  while (x !== b.x || y !== b.y) {
    if (Math.abs(b.x - x) >= Math.abs(b.y - y)) x += Math.sign(b.x - x);
    else y += Math.sign(b.y - y);
    out.push({ x, y });
  }
  return out;
}

function farmStage(spec: FarmSpec, ageDays: number) {
  return ageDays < spec.adultAt ? 'baby' : ageDays < spec.elderAt ? 'adult' : 'elder';
}

/** Tiles an animal may stand on, in row-major order (deterministic iteration). */
interface Habitat {
  rect: Rect;
  tiles: Point[];
  set: Set<number>;
}

interface Runtime {
  s: AnimalState;
  rng: Rng;
  /** Next wander decision (game minutes). */
  nextAt: number;
  path: Point[];
  /** Minutes per path step. */
  stepMinutes: number;
  nextStepAt: number;
  fleeing: boolean;
  leavingSince?: number;
}

export interface AnimalStepResult extends AnimalChange {
  /** Player-facing toasts (births, old-age deaths, butcher). Never graphic. */
  toasts: string[];
  /** Observations for the farmer (old-age deaths). */
  farmerNotes: string[];
}

export interface AnimalSimOptions {
  config: AppConfig;
  map: WorldMap;
  /** Current game time (used for seeding and restoring). */
  now: GameMinutes;
  restore?: { animals?: AnimalState[]; farm?: FarmState };
  /** Current `burger` stock at `burger_joint` (FarmEconomy); omitted = never low. */
  burgerStock?: () => number;
  /** Name used in the butcher toast (the resident whose occupation is "Farmer"). */
  farmerName?: string;
  /** While the farmer escorts the leaving animal, his tile; null when he is not escorting. */
  escortPosition?: () => Point | null;
  /** Optional path finder for the walk to the butcher (e.g. the engine's cached A*). */
  findPath?: (from: Point, to: Point) => Point[] | null;
  /** Default "Quill" (data/ambient.json). */
  crowName?: string;
}

// ---------- the sim ----------

export class DeterministicAnimalSim implements AnimalSim {
  private readonly cfg: AppConfig;
  private readonly map: WorldMap;
  private readonly seed: number;
  private readonly cap: number;
  private readonly butcherTime: number;
  private readonly opts: AnimalSimOptions;
  private readonly locations = new Map<LocationId, Location>();
  private readonly habitats = new Map<string, Habitat>();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly dirty = new Set<string>();
  private farm: FarmState;
  private lastNow: number;
  private lastProductionDay: number | null = null;
  private lastCawAt = -Infinity;
  private pendingEmotes: { animalId: string; emote: string }[] = [];
  private crowDay = -1;
  private crowFlights: number[] = [];
  private forestBounds: Rect | null = null;

  constructor(opts: AnimalSimOptions) {
    this.opts = opts;
    this.cfg = opts.config;
    this.map = opts.map;
    this.seed = opts.config.sim.seed;
    this.cap = Math.min(FARM_CAP_PER_SPECIES, opts.config.farm.capPerSpecies);
    this.butcherTime = parseClock(opts.config.farm.butcherTime);
    this.lastNow = opts.now;
    for (const l of opts.map.locations) this.locations.set(l.id, l);
    this.farm = opts.restore?.farm
      ? { ...opts.restore.farm }
      : { seeded: false, nextSeq: 1, lastLifecycleDay: null, lastButcherDay: null };

    if (this.farm.seeded && opts.restore?.animals) {
      for (const a of opts.restore.animals) {
        if (a.group === 'ambient') continue;
        if (!this.locations.has(a.homeId)) continue;
        this.addRuntime(structuredClone(a), `restore:${Math.floor(opts.now)}`);
        if (a.status === 'leaving' && this.farm.lastButcherDay !== null) {
          this.runtimes.get(a.id)!.leavingSince =
            this.farm.lastButcherDay * MINUTES_PER_DAY + this.butcherTime;
        }
      }
    } else {
      this.seedZoo();
      if (this.cfg.farm.enabled) this.seedFarm();
      this.farm.seeded = true;
    }
    if (this.cfg.forest.enabled) this.seedForest();
    this.seedCrow();
  }

  // ----- AnimalSim -----

  step(now: GameMinutes, occupants: readonly Point[]): AnimalStepResult {
    const change: AnimalStepResult = {
      added: [],
      removed: [],
      updated: [],
      produced: [],
      emotes: this.pendingEmotes.splice(0),
      toasts: [],
      farmerNotes: [],
    };
    this.lastNow = now;
    const day = dayOf(now);
    const minute = minuteOfDay(now);

    if (this.cfg.farm.enabled) {
      if (
        minute >= LIFECYCLE_AT &&
        (this.farm.lastLifecycleDay === null || day > this.farm.lastLifecycleDay)
      ) {
        this.farm.lastLifecycleDay = day;
        for (const sp of FARM_SPECIES) this.lifecycle(sp, now, change);
      }
      if (minute >= PRODUCTION_AT && (this.lastProductionDay === null || day > this.lastProductionDay)) {
        this.lastProductionDay = day;
        this.produce(now, change);
      }
      if (
        minute >= this.butcherTime &&
        (this.farm.lastButcherDay === null || day > this.farm.lastButcherDay)
      ) {
        this.farm.lastButcherDay = day;
        this.startButcher(now, change);
      }
    }

    const near = this.nearbyOccupants(occupants);
    for (const rt of this.runtimes.values()) {
      if (rt.s.status === 'leaving') this.stepLeaving(rt, now, change);
      else if (rt.s.species === 'crow') this.stepCrow(rt, now, minute, day);
      else this.stepWander(rt, now, minute, near);
    }
    return change;
  }

  all(): readonly AnimalState[] {
    return [...this.runtimes.values()].map((r) => r.s);
  }

  frames(): AnimalFrame[] {
    const out: AnimalFrame[] = [];
    for (const id of this.dirty) {
      const s = this.runtimes.get(id)?.s;
      if (s) out.push({ id: s.id, x: s.pos.x, y: s.pos.y, facing: s.facing, status: s.status });
    }
    this.dirty.clear();
    return out;
  }

  count(species: FarmSpecies): number {
    let n = 0;
    for (const rt of this.runtimes.values()) if (rt.s.group === 'farm' && rt.s.species === species) n++;
    return n;
  }

  caw(_reason: 'letter' | 'player'): void {
    const crow = this.crow();
    if (!crow || this.lastNow - this.lastCawAt < CAW_COOLDOWN) return;
    this.lastCawAt = this.lastNow;
    this.pendingEmotes.push({ animalId: crow.s.id, emote: 'Caw!' });
  }

  serialize(): { animals: AnimalState[]; farm: FarmState } {
    const animals = [...this.runtimes.values()]
      .filter((r) => r.s.group !== 'ambient')
      .map((r) => structuredClone(r.s));
    return { animals, farm: { ...this.farm } };
  }

  // ----- extras for the engine -----

  /** The animal currently walking to the butcher, if any (engine adds the farmer's escort block). */
  leavingAnimal(): AnimalState | null {
    for (const rt of this.runtimes.values()) if (rt.s.status === 'leaving') return rt.s;
    return null;
  }

  /** The crow's id, or null when the map has no perch. */
  crowId(): string | null {
    return this.crow()?.s.id ?? null;
  }

  // ----- seeding -----

  private nextId(prefix: string): string {
    return `${prefix}_${this.farm.nextSeq++}`;
  }

  private addRuntime(s: AnimalState, salt: string): Runtime {
    const rng = new Rng(streamSeed(this.seed, `${s.id}:${salt}`));
    const rt: Runtime = {
      s,
      rng,
      nextAt: this.lastNow + rng.int(0, 12),
      path: [],
      stepMinutes: 1,
      nextStepAt: this.lastNow,
      fleeing: false,
    };
    this.runtimes.set(s.id, rt);
    this.dirty.add(s.id);
    return rt;
  }

  private pickName(species: AnimalSpecies, rng: Rng): string | undefined {
    const pool = NAMES[species];
    if (!pool) return undefined;
    const used = new Set(
      [...this.runtimes.values()].filter((r) => r.s.species === species).map((r) => r.s.name),
    );
    const free = pool.filter((n) => !used.has(n));
    if (free.length) return rng.pick(free);
    const base = rng.pick(pool)!;
    for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  private seedZoo(): void {
    const rng = new Rng(streamSeed(this.seed, 'zoo'));
    for (const loc of this.map.locations) {
      if (loc.kind !== 'zoo' || !loc.species || !loc.pen) continue;
      const n = loc.species === 'penguin' || loc.species === 'flamingo' ? 3 : rng.int(1, 2);
      const hab = this.habitatFor(loc.species, loc);
      for (let i = 0; i < n; i++) {
        const pos = rng.pick(hab.tiles) ?? { x: loc.pen.x, y: loc.pen.y };
        this.addRuntime(
          {
            id: this.nextId(loc.species),
            species: loc.species,
            group: 'zoo',
            name: this.pickName(loc.species, rng),
            homeId: loc.id,
            pos: { ...pos },
            facing: 'down',
            status: 'idle',
          },
          'seed',
        );
      }
    }
  }

  private seedFarm(): void {
    for (const sp of FARM_SPECIES) {
      const spec = FARM_TABLE[sp];
      const loc = this.farmHome(sp);
      if (!loc) continue;
      const rng = new Rng(streamSeed(this.seed, `farm-seed:${sp}`));
      const sexes = [
        ...Array<'female'>(spec.initial.female).fill('female'),
        ...Array<'male'>(spec.initial.male).fill('male'),
      ];
      for (const sex of sexes) {
        // Mixed ages: all adults at start, spread over the adult years so deaths are staggered.
        const ageDays = rng.int(spec.adultAt, spec.elderAt - 1);
        this.spawn(
          sp,
          sex,
          this.lastNow - ageDays * MINUTES_PER_DAY,
          rng.pick(this.habitatFor(sp, loc).tiles),
          rng,
        );
      }
    }
  }

  private seedForest(): void {
    const forest = this.locations.get('forest');
    const lake = this.locations.get('forest_lake');
    const rng = new Rng(streamSeed(this.seed, 'forest'));
    for (const sp of Object.keys(FOREST_COUNTS) as ForestSpecies[]) {
      const loc = sp === 'duck' ? lake : forest;
      if (!loc?.pen) continue;
      const hab = sp === 'duck' ? this.duckHabitat(loc, minuteOfDay(this.lastNow)) : this.habitatFor(sp, loc);
      for (let i = 0; i < FOREST_COUNTS[sp]; i++) {
        const pos = rng.pick(hab.tiles);
        if (!pos) continue;
        this.addRuntime(
          {
            id: `${sp}_${i + 1}`,
            species: sp,
            group: 'ambient',
            homeId: loc.id,
            pos: { ...pos },
            facing: 'down',
            status: 'idle',
          },
          `ambient:${Math.floor(this.lastNow)}`,
        );
      }
    }
    if (forest?.pen) {
      const r = forest.pen;
      const lr = lake?.pen ?? r;
      const x = Math.min(r.x, lr.x) - FLEE_RADIUS;
      const y = Math.min(r.y, lr.y) - FLEE_RADIUS;
      this.forestBounds = {
        x,
        y,
        w: Math.max(r.x + r.w, lr.x + lr.w) + FLEE_RADIUS - x,
        h: Math.max(r.y + r.h, lr.y + lr.h) + FLEE_RADIUS - y,
      };
    }
  }

  private seedCrow(): void {
    const post = this.locations.get('post_office');
    const perch = post?.perch;
    if (!post || !perch?.length) return;
    this.addRuntime(
      {
        id: 'crow',
        species: 'crow',
        group: 'ambient',
        name: this.opts.crowName ?? 'Quill',
        homeId: post.id,
        pos: { ...perch[0]! },
        facing: 'down',
        status: 'idle',
      },
      `ambient:${Math.floor(this.lastNow)}`,
    );
  }

  /** The only way to create a farm animal; refuses at the cap (counting `leaving`). */
  private spawn(
    species: FarmSpecies,
    sex: 'female' | 'male',
    bornAt: number,
    pos: Point | undefined,
    rng: Rng,
  ): AnimalState | null {
    if (this.count(species) >= this.cap) return null;
    const loc = this.farmHome(species);
    if (!loc?.pen) return null;
    const spec = FARM_TABLE[species];
    const id = this.nextId(species);
    const lifeRng = new Rng(streamSeed(this.seed, `life:${id}`));
    const ageDays = Math.floor((this.lastNow - bornAt) / MINUTES_PER_DAY);
    const s: AnimalState = {
      id,
      species,
      group: 'farm',
      name: this.pickName(species, rng),
      sex,
      bornAt,
      stage: farmStage(spec, ageDays),
      lifespanDays: lifeRng.int(spec.lifespan[0], spec.lifespan[1]),
      homeId: loc.id,
      pos: pos ? { ...pos } : { x: loc.pen.x, y: loc.pen.y },
      facing: 'down',
      status: 'idle',
    };
    this.addRuntime(s, 'born');
    return s;
  }

  // ----- farm lifecycle -----

  private farmHome(species: FarmSpecies): Location | undefined {
    const byId = this.locations.get(FARM_TABLE[species].home);
    if (byId?.pen) return byId;
    return this.map.locations.find((l) => l.kind === 'farm' && l.species === species && l.pen);
  }

  private farmAnimals(species: FarmSpecies): Runtime[] {
    return [...this.runtimes.values()].filter((r) => r.s.group === 'farm' && r.s.species === species);
  }

  private remove(rt: Runtime, reason: 'butcher' | 'oldAge', change: AnimalChange): void {
    this.runtimes.delete(rt.s.id);
    this.dirty.delete(rt.s.id);
    change.removed.push({ id: rt.s.id, species: rt.s.species, reason });
  }

  private lifecycle(species: FarmSpecies, now: number, change: AnimalStepResult): void {
    const spec = FARM_TABLE[species];
    const day = dayOf(now);
    const rng = new Rng(streamSeed(this.seed, `lifecycle:${species}:${day}`));
    for (const rt of this.farmAnimals(species)) {
      const age = Math.floor((now - (rt.s.bornAt ?? now)) / MINUTES_PER_DAY);
      const stage = farmStage(spec, age);
      if (stage !== rt.s.stage) {
        rt.s.stage = stage;
        change.updated.push(structuredClone(rt.s));
      }
    }
    for (const rt of this.farmAnimals(species)) {
      if (rt.s.status === 'leaving') continue;
      const age = Math.floor((now - (rt.s.bornAt ?? now)) / MINUTES_PER_DAY);
      const elderRoll = rt.s.stage === 'elder' && rng.chance(ELDER_DEATH_CHANCE);
      if (age >= (rt.s.lifespanDays ?? Infinity) || elderRoll) {
        const name = rt.s.name ?? `the ${species}`;
        change.toasts.push(`🕊️ Old ${name} the ${species} passed away peacefully on the farm.`);
        change.farmerNotes.push(`Old ${name} the ${species} passed away peacefully on the farm.`);
        this.remove(rt, 'oldAge', change);
      }
    }
    this.restock(species, now, change, rng);
    const animals = this.farmAnimals(species).filter((r) => r.s.status !== 'leaving');
    const hasMale = animals.some((r) => r.s.sex === 'male' && r.s.stage !== 'baby');
    if (!hasMale) return;
    // Breeding is per mother (each female at most once per BIRTH_GAP_DAYS); a species-wide gap
    // cannot sustain the herds with the spec lifespans.
    let born = 0;
    for (const mother of animals) {
      const m = mother.s as FarmAnimal;
      if (m.sex !== 'female' || m.stage === 'baby') continue;
      if (this.count(species) >= this.cap) break;
      if (m.lastBirthAt !== undefined && now - m.lastBirthAt < BIRTH_GAP_DAYS * MINUTES_PER_DAY) continue;
      if (!rng.chance(this.cfg.farm.breedChance)) continue;
      m.lastBirthAt = now;
      const babies = species === 'chicken' ? rng.int(1, 2) : 1;
      for (let i = 0; i < babies; i++) {
        const baby = this.spawn(
          species,
          rng.chance(0.5) ? 'female' : 'male',
          now,
          this.besideMother(mother, rng),
          rng,
        );
        if (!baby) break;
        born++;
        change.added.push(structuredClone(baby));
      }
    }
    if (born) change.toasts.push(spec.birthToast);
  }

  /** The farmer buys an adult at the market when a species has no animal of one sex left. */
  private restock(species: FarmSpecies, now: number, change: AnimalStepResult, rng: Rng): void {
    const spec = FARM_TABLE[species];
    const loc = this.farmHome(species);
    if (!loc) return;
    for (const sex of ['female', 'male'] as const) {
      const have = this.farmAnimals(species).some((r) => r.s.sex === sex && r.s.status !== 'leaving');
      if (have) continue;
      const bought = this.spawn(
        species,
        sex,
        now - spec.adultAt * MINUTES_PER_DAY,
        rng.pick(this.habitatFor(species, loc).tiles),
        rng,
      );
      if (!bought) continue;
      change.added.push(structuredClone(bought));
      const farmer = this.opts.farmerName ?? 'The farmer';
      change.toasts.push(`${spec.emoji} ${farmer} brought a new ${species} home from the market.`);
    }
  }

  private besideMother(mother: Runtime, rng: Rng): Point {
    const hab = this.habitatOf(mother);
    const options = [
      { x: mother.s.pos.x + 1, y: mother.s.pos.y },
      { x: mother.s.pos.x - 1, y: mother.s.pos.y },
      { x: mother.s.pos.x, y: mother.s.pos.y + 1 },
      { x: mother.s.pos.x, y: mother.s.pos.y - 1 },
    ].filter((p) => hab.set.has(key(p)));
    return rng.pick(options) ?? { ...mother.s.pos };
  }

  private produce(now: number, change: AnimalChange): void {
    const day = dayOf(now);
    for (const rt of this.runtimes.values()) {
      const s = rt.s;
      if (s.group !== 'farm' || s.status === 'leaving' || s.stage === 'baby') continue;
      const spec = FARM_TABLE[s.species as FarmSpecies];
      if (spec.product.femaleOnly && s.sex !== 'female') continue;
      const every = spec.product.everyDays * (s.stage === 'elder' ? 2 : 1);
      if (s.lastProducedAt !== undefined && dayOf(s.lastProducedAt) + every > day) continue;
      s.lastProducedAt = now;
      change.produced.push({ animalId: s.id, itemId: spec.product.itemId, count: 1 });
    }
  }

  private startButcher(now: number, change: AnimalChange): void {
    if (this.leavingAnimal()) return;
    const counts = FARM_SPECIES.map((sp) => ({ sp, n: this.count(sp) }));
    let species: FarmSpecies | undefined;
    const crowded = counts.filter((c) => c.n >= this.cfg.farm.butcherAtCount);
    if (crowded.length) species = crowded.reduce((a, b) => (b.n > a.n ? b : a)).sp;
    else if (this.opts.burgerStock && this.opts.burgerStock() < BUTCHER_BURGER_LOW) {
      species = (['cow', 'sheep'] as const).find(
        (sp) => this.farmAnimals(sp).filter((r) => r.s.stage !== 'baby').length >= BUTCHER_BURGER_ADULTS,
      );
    }
    if (!species) return;
    const adults = this.farmAnimals(species).filter((r) => r.s.stage !== 'baby' && r.s.status !== 'leaving');
    const byAge = (a: Runtime, b: Runtime) =>
      (a.s.bornAt ?? 0) - (b.s.bornAt ?? 0) || (a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0);
    // Never take the last animal of a sex, so every herd keeps a breeding pair.
    const herd = this.farmAnimals(species).filter((r) => r.s.status !== 'leaving');
    const keepsPair = (r: Runtime) => herd.some((o) => o !== r && o.s.sex === r.s.sex);
    const candidates = adults.filter(keepsPair).sort(byAge);
    const pick = candidates.find((r) => r.s.sex === 'male' && r.s.stage === 'adult') ?? candidates[0];
    if (!pick) return;
    pick.s.status = 'leaving';
    pick.leavingSince = now;
    pick.path = [];
    pick.fleeing = false;
    this.dirty.add(pick.s.id);
    change.updated.push(structuredClone(pick.s));
  }

  private stepLeaving(rt: Runtime, now: number, change: AnimalStepResult): void {
    const butcher = this.locations.get('butcher');
    const target = butcher?.entry;
    if (!target || now - (rt.leavingSince ?? now) >= BUTCHER_MAX_MINUTES || cheb(rt.s.pos, target) <= 1) {
      this.finishButcher(rt, change);
      return;
    }
    if (now < rt.nextStepAt) return;
    const escort = this.opts.escortPosition?.() ?? null;
    if (escort) {
      rt.path = cheb(rt.s.pos, escort) > 1 ? straightPath(rt.s.pos, escort).slice(0, -1) : [];
    } else if (!rt.path.length) {
      rt.path = this.opts.findPath?.(rt.s.pos, target) ?? straightPath(rt.s.pos, target);
    }
    // Animals walk a little faster than one tile per game minute so the farmer is not kept waiting.
    for (let i = 0; i < 2 && rt.path.length; i++) this.moveTo(rt, rt.path.shift()!);
    rt.nextStepAt = now + 1;
    if (cheb(rt.s.pos, target) <= 1) this.finishButcher(rt, change);
  }

  private finishButcher(rt: Runtime, change: AnimalStepResult): void {
    const farmer = this.opts.farmerName ?? 'The farmer';
    change.toasts.push(
      `🍔 ${farmer} took a ${rt.s.species} to the butcher. Fresh burgers at the Burger Joint!`,
    );
    this.remove(rt, 'butcher', change);
  }

  // ----- movement -----

  private habitatFor(species: AnimalSpecies, loc: Location): Habitat {
    const anyTile = ANY_TILE.has(species);
    const hk = `${loc.id}:${anyTile ? 'any' : 'land'}`;
    let h = this.habitats.get(hk);
    if (!h) {
      h = this.buildHabitat(loc.pen ?? loc.area, (blocked) => anyTile || !blocked);
      this.habitats.set(hk, h);
    }
    return h;
  }

  /** Ducks: the water (blocked tiles) by day, the walkable shore at night. */
  private duckHabitat(loc: Location, minute: number): Habitat {
    const day = isAwake(minute, AWAKE.duck!);
    const hk = `${loc.id}:${day ? 'water' : 'shore'}`;
    let h = this.habitats.get(hk);
    if (!h) {
      h = this.buildHabitat(loc.pen ?? loc.area, (blocked) => (day ? blocked : !blocked));
      // A lake without water or shore tiles falls back to the whole pen.
      if (!h.tiles.length) h = this.buildHabitat(loc.pen ?? loc.area, () => true);
      this.habitats.set(hk, h);
    }
    return h;
  }

  private buildHabitat(rect: Rect, ok: (blocked: boolean) => boolean): Habitat {
    const tiles: Point[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++)
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) continue;
        if (ok(this.map.collision[y * this.map.width + x] === 1)) tiles.push({ x, y });
      }
    if (!tiles.length && rect.w > 0 && rect.h > 0) tiles.push({ x: rect.x, y: rect.y });
    return { rect, tiles, set: new Set(tiles.map(key)) };
  }

  private habitatOf(rt: Runtime): Habitat {
    const loc = this.locations.get(rt.s.homeId)!;
    return rt.s.species === 'duck'
      ? this.duckHabitat(loc, minuteOfDay(this.lastNow))
      : this.habitatFor(rt.s.species, loc);
  }

  private awakeWindow(s: AnimalState): [number, number] {
    return AWAKE[s.species] ?? AWAKE[s.group === 'zoo' ? 'zoo' : 'cow']!;
  }

  private setStatus(rt: Runtime, status: AnimalStatus): void {
    if (rt.s.status === status) return;
    rt.s.status = status;
    this.dirty.add(rt.s.id);
  }

  private moveTo(rt: Runtime, p: Point): void {
    rt.s.facing = facingFor(rt.s.pos, p, rt.s.facing);
    rt.s.pos = { x: p.x, y: p.y };
    this.dirty.add(rt.s.id);
  }

  /** Walk queued path steps that are due; returns true while a path is still in progress. */
  private followPath(rt: Runtime, now: number, moving: AnimalStatus): boolean {
    let guard = 0;
    while (rt.path.length && now >= rt.nextStepAt && guard++ < 16) {
      this.setStatus(rt, moving);
      this.moveTo(rt, rt.path.shift()!);
      rt.nextStepAt += rt.stepMinutes;
    }
    if (rt.path.length) return true;
    if (now < rt.nextStepAt) return true;
    rt.fleeing = false;
    return false;
  }

  private startPath(rt: Runtime, path: Point[], now: number, stepMinutes = 1): void {
    rt.path = path;
    rt.stepMinutes = stepMinutes;
    rt.nextStepAt = now;
  }

  private nearbyOccupants(occupants: readonly Point[]): Point[] {
    const b = this.forestBounds;
    if (!b || !occupants.length) return [];
    return occupants.filter((p) => inRect(p, b));
  }

  private stepWander(rt: Runtime, now: number, minute: number, near: readonly Point[]): void {
    const s = rt.s;
    const awake = isAwake(minute, this.awakeWindow(s));
    const flying = s.species === 'bird';
    if (rt.path.length || now < rt.nextStepAt) {
      if (this.followPath(rt, now, flying ? 'flying' : 'walking')) return;
    }
    const hab = this.habitatOf(rt);
    if (!hab.set.has(key(s.pos))) {
      // Off habitat (ducks at dusk and dawn, a restored save on a changed map): head to the nearest tile.
      const target = this.nearest(hab, s.pos);
      if (target) {
        this.startPath(rt, straightPath(s.pos, target), now);
        this.followPath(rt, now, flying ? 'flying' : 'walking');
        return;
      }
    }
    if (!awake) {
      this.setStatus(rt, 'sleeping');
      return;
    }
    if (s.group === 'ambient' && near.length && !rt.fleeing && this.flee(rt, hab, near, now)) return;
    if (s.status === 'sleeping' || s.status === 'walking' || s.status === 'flying')
      this.setStatus(rt, 'idle');
    if (now < rt.nextAt) return;

    const rng = rt.rng;
    if (rng.chance(0.25)) {
      // Rest: grazing animals eat, the others stand still.
      const grazing =
        s.group === 'farm' || s.group === 'zoo' || s.species === 'deer' || s.species === 'rabbit';
      this.setStatus(rt, grazing && rng.chance(0.6) ? 'eating' : 'idle');
      rt.nextAt = now + rng.int(20, 60);
      return;
    }
    const reach = flying ? 5 : s.species === 'squirrel' ? 3 : 1;
    const target = this.randomTile(hab, s.pos, reach, rng);
    if (target) {
      this.startPath(rt, straightPath(s.pos, target), now, flying ? 0.5 : 1);
      this.followPath(rt, now, flying ? 'flying' : 'walking');
    }
    rt.nextAt = now + rng.int(4, 12);
  }

  private randomTile(hab: Habitat, from: Point, reach: number, rng: Rng): Point | null {
    const options: Point[] = [];
    for (let dy = -reach; dy <= reach; dy++)
      for (let dx = -reach; dx <= reach; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (reach === 1 && dx !== 0 && dy !== 0) continue;
        const p = { x: from.x + dx, y: from.y + dy };
        if (hab.set.has(key(p))) options.push(p);
      }
    return rng.pick(options) ?? null;
  }

  private nearest(hab: Habitat, from: Point): Point | null {
    let best: Point | null = null;
    let bd = Infinity;
    for (const t of hab.tiles) {
      const d = dist2(t, from);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  /** Move to the habitat tile within FLEE_STEPS that is farthest from the nearest person. */
  private flee(rt: Runtime, hab: Habitat, near: readonly Point[], now: number): boolean {
    const pos = rt.s.pos;
    if (!near.some((p) => cheb(p, pos) <= FLEE_RADIUS)) return false;
    const score = (t: Point) => Math.min(...near.map((p) => dist2(p, t)));
    const prev = new Map<number, number>([[key(pos), -1]]);
    const frontier: Point[] = [pos];
    const seen: Point[] = [pos];
    for (let depth = 0; depth < FLEE_STEPS; depth++) {
      const next: Point[] = [];
      for (const p of frontier)
        for (const n of [
          { x: p.x, y: p.y - 1 },
          { x: p.x - 1, y: p.y },
          { x: p.x + 1, y: p.y },
          { x: p.x, y: p.y + 1 },
        ]) {
          const k = key(n);
          if (prev.has(k) || !hab.set.has(k)) continue;
          prev.set(k, key(p));
          next.push(n);
          seen.push(n);
        }
      frontier.splice(0, frontier.length, ...next);
    }
    let best = pos;
    let bestScore = score(pos);
    for (const t of seen) {
      const sc = score(t);
      if (sc > bestScore || (sc === bestScore && key(t) < key(best))) {
        best = t;
        bestScore = sc;
      }
    }
    if (best === pos) return false;
    const path: Point[] = [];
    for (let k = key(best); k !== key(pos); k = prev.get(k)!)
      path.unshift({ x: k % 100_000, y: Math.floor(k / 100_000) });
    rt.fleeing = true;
    this.startPath(rt, path, now, rt.s.species === 'bird' ? 0.5 : 1);
    this.followPath(rt, now, rt.s.species === 'bird' ? 'flying' : 'walking');
    rt.nextAt = now + rt.rng.int(4, 12);
    return true;
  }

  // ----- the crow -----

  private crow(): Runtime | undefined {
    return this.runtimes.get('crow');
  }

  private stepCrow(rt: Runtime, now: number, minute: number, day: number): void {
    const post = this.locations.get(rt.s.homeId);
    const perch = post?.perch ?? [];
    if (!perch.length) return;
    if (day !== this.crowDay) {
      this.crowDay = day;
      const rng = new Rng(streamSeed(this.seed, `crow:${day}`));
      const n = rng.int(3, 6);
      this.crowFlights = Array.from(
        { length: n },
        () => day * MINUTES_PER_DAY + rng.int(7 * 60, 19 * 60 - 1),
      ).sort((a, b) => a - b);
    }
    if (rt.path.length || now < rt.nextStepAt) {
      if (this.followPath(rt, now, 'flying')) return;
    }
    const onPerch = perch.some((p) => p.x === rt.s.pos.x && p.y === rt.s.pos.y);
    if (!onPerch) {
      this.startPath(rt, [perch[0]!], now);
      this.followPath(rt, now, 'flying');
      return;
    }
    if (!isAwake(minute, AWAKE.crow!)) {
      this.setStatus(rt, 'sleeping');
      return;
    }
    if (rt.s.status !== 'idle') this.setStatus(rt, 'idle');
    while (this.crowFlights.length && this.crowFlights[0]! <= now) {
      const flightAt = this.crowFlights.shift()!;
      if (now - flightAt > 30) continue;
      const rng = rt.rng;
      const center = perch[0]!;
      const points = rng.int(3, 5);
      const loop: Point[] = [];
      for (let i = 0; i < points; i++) {
        const x = Math.min(
          this.map.width - 1,
          Math.max(0, center.x + rng.int(-CROW_FLIGHT_RADIUS, CROW_FLIGHT_RADIUS)),
        );
        const y = Math.min(
          this.map.height - 1,
          Math.max(0, center.y + rng.int(-CROW_FLIGHT_RADIUS, CROW_FLIGHT_RADIUS)),
        );
        loop.push({ x, y });
      }
      loop.push({ ...rng.pick(perch)! });
      const duration = rng.int(2, 5);
      this.startPath(rt, loop, now, duration / loop.length);
      this.followPath(rt, now, 'flying');
      return;
    }
    if (now >= rt.nextAt) {
      const others = perch.filter((p) => p.x !== rt.s.pos.x || p.y !== rt.s.pos.y);
      const hop = rt.rng.pick(others);
      if (hop) this.moveTo(rt, hop);
      rt.nextAt = now + rt.rng.int(10, 30);
    }
  }
}

export function createAnimalSim(opts: AnimalSimOptions): DeterministicAnimalSim {
  return new DeterministicAnimalSim(opts);
}
