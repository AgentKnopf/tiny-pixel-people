/** AC11: animals and the other deterministic systems never wait on the LLM. */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FOREST_SPECIES,
  PLAYER_ID,
  type AnimalState,
  type FarmState,
  type GameMinutes,
  type Location,
  type Point,
  type WorldMap,
  type WorldSnapshot,
} from '../../../src/shared/types.ts';
import { at, dayOf, minuteOfDay, parseClock } from '../../../src/shared/time.ts';
import { readyV2, waitingForV2, type Feature } from '../../helpers/features.ts';
import { walkable } from '../../helpers/invariants.ts';
import { dist, loc, V2 } from '../../helpers/v2.ts';
import { createTestWorld } from '../../helpers/world.ts';

const F: Feature[] = [...new Set<Feature>([...V2.animals, ...V2.farm, ...V2.visitors, ...V2.post])];

const SEED = 31;
const DAYS = 3;
const LETTER_TIMES = [parseClock('09:00'), parseClock('15:00')];
const NOTICE_TIME = parseClock('09:30');
/** Forest animals flee from people (spec v2 §3.5), so their paths only match while nobody came near. */
const SHY_RADIUS = 4;

/** Identical in both runs; short timeouts keep the never-answering run moving in real time. */
const CONFIG = { sim: { wakeUpMode: 'hold' as const, wakeUpTimeoutSec: 2 }, llm: { timeoutMs: 3000 } };

type Key =
  | 'zoo'
  | 'farm'
  | 'leaving'
  | 'crow'
  | 'farmState'
  | 'shopStock'
  | 'butchered'
  | 'train'
  | 'hotel'
  | 'letters'
  | 'notices';
const KEYS: Key[] = [
  'zoo',
  'farm',
  'leaving',
  'crow',
  'farmState',
  'shopStock',
  'butchered',
  'train',
  'hotel',
  'letters',
  'notices',
];

interface Hour extends Record<Key, string> {
  t: GameMinutes;
  forest: string;
  forestIds: string;
}

interface Run {
  hours: Hour[];
  /** First minute somebody came within SHY_RADIUS of a forest animal (Infinity: never). */
  forestDisturbedAt: number;
  end: GameMinutes;
  wakingUpDays: Set<number>;
  runningDays: Set<number>;
}

const byId = (xs: AnimalState[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
const isForest = (a: AnimalState) =>
  a.group === 'ambient' && (FOREST_SPECIES as readonly string[]).includes(a.species);

function rectDistance(p: Point, r: Location['area']): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w - 1));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h - 1));
  return Math.hypot(dx, dy);
}

/** A walkable tile within 2 tiles of the post office door and 3 of the notice board. */
function postTile(map: WorldMap): Point {
  const post = loc(map, 'post_office');
  const board = loc(map, 'notice_board');
  const door = post.door ?? post.entry;
  let best: Point | null = null;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const p = { x: door.x + dx, y: door.y + dy };
      if (!walkable(map, p) || dist(p, door) > 2 || rectDistance(p, board.area) > 3) continue;
      if (!best || rectDistance(p, board.area) < rectDistance(best, board.area)) best = p;
    }
  if (!best) throw new Error('no tile near both the post office door and the notice board');
  return best;
}

function project(snap: WorldSnapshot, farm: FarmState | undefined, butchered: string[]): Hour {
  const animals = snap.animals ?? [];
  const farmAnimals = animals.filter((a) => a.group === 'farm');
  const forest = byId(animals.filter(isForest));
  const stock = Object.fromEntries(
    Object.entries(snap.stock ?? {}).filter(([venue]) => venue !== 'burger_joint'),
  );
  const train = snap.train ?? null;
  return {
    t: snap.time,
    zoo: JSON.stringify(byId(animals.filter((a) => a.group === 'zoo'))),
    // A leaving animal may follow the farmer, whose day depends on the LLM; compare who leaves, not where.
    farm: JSON.stringify(byId(farmAnimals.filter((a) => a.status !== 'leaving'))),
    leaving: JSON.stringify(
      farmAnimals
        .filter((a) => a.status === 'leaving')
        .map((a) => a.id)
        .sort(),
    ),
    crow: JSON.stringify(animals.filter((a) => a.species === 'crow')),
    forest: JSON.stringify(forest),
    forestIds: JSON.stringify(forest.map((a) => `${a.id}:${a.species}:${a.homeId}`)),
    farmState: JSON.stringify(farm ?? null),
    // Villagers eat burgers when their plans take them to the burger joint, so only farm-made stock is compared.
    shopStock: JSON.stringify(stock),
    butchered: JSON.stringify(butchered),
    train: JSON.stringify(
      train && {
        status: train.status,
        arrivesAt: train.arrivesAt,
        departsAt: train.departsAt,
        arriving: train.arriving.length,
      },
    ),
    hotel: JSON.stringify(snap.hotel ? snap.hotel.rooms.map((r) => [r.id, r.guestId !== null]) : null),
    letters: JSON.stringify(
      (snap.letters ?? [])
        .filter((l) => l.from === PLAYER_ID)
        .map((l) => [l.to, l.postedAt, l.deliveredAt ?? null])
        .sort(),
    ),
    notices: JSON.stringify(
      (snap.notices ?? [])
        .filter((n) => n.authorId === PLAYER_ID)
        .map((n) => [n.postedAt, n.expiresAt, n.expiresAt > snap.time])
        .sort(),
    ),
  };
}

async function runDays(neverAnswer: boolean): Promise<Run> {
  const w = await createTestWorld({
    villagers: 12,
    seed: SEED,
    startAt: '06:00',
    neverAnswer,
    config: CONFIG,
  });
  try {
    const spot = postTile(w.engine.map);
    w.command({ type: 'player.move', to: spot });
    const run: Run = {
      hours: [],
      forestDisturbedAt: Infinity,
      end: at(DAYS, '06:00'),
      wakingUpDays: new Set(),
      runningDays: new Set(),
    };
    while (w.now() < run.end) {
      const mod = minuteOfDay(w.now());
      const day = dayOf(w.now());
      if (LETTER_TIMES.includes(mod))
        w.command({ type: 'letter.send', to: 'rosa', text: `Dear Rosa, a note for day ${day} at ${mod}.` });
      if (mod === NOTICE_TIME)
        w.command({ type: 'notice.post', text: `Lost scarf, day ${day}. Ask at the post office.` });
      const before = w.messages.length;
      await w.advance(1, { chunk: 1 });
      for (const m of w.messages.slice(before))
        if (m.type === 'sim.status')
          (m.phase === 'wakingUp' ? run.wakingUpDays : run.runningDays).add(dayOf(w.now()));
      const snap = w.state();
      if (run.forestDisturbedAt === Infinity) {
        const people = [snap.player.pos, ...snap.villagers.map((v) => v.pos)];
        const near = (snap.animals ?? [])
          .filter(isForest)
          .some((a) => people.some((p) => dist(p, a.pos) <= SHY_RADIUS));
        if (near) run.forestDisturbedAt = w.now();
      }
      if (minuteOfDay(w.now()) % 60 === 0) {
        const butchered = w
          .of('animals.changed')
          .flatMap((m) => m.removed)
          .map((r) => `${r.id}:${r.reason}`);
        run.hours.push(project(snap, w.engine.toSaveData().farm, butchered));
      }
    }
    run.end = w.now();
    return run;
  } finally {
    w.dispose();
  }
}

function firstMismatch(a: Hour[], b: Hour[], key: keyof Hour, until = Infinity): string | null {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x && x.t >= until) break;
    if (x?.[key] !== y?.[key])
      return `${String(key)} differs at hour ${i} (t=${x?.t ?? y?.t}):\n fast:  ${String(x?.[key]).slice(0, 400)}\n never: ${String(y?.[key]).slice(0, 400)}`;
  }
  return null;
}

describe.skipIf(!readyV2(...F))(
  `AC11: deterministic systems never wait on the LLM${waitingForV2(...F)}`,
  () => {
    let fast: Run;
    let hung: Run;

    beforeAll(async () => {
      fast = await runDays(false);
      hung = await runDays(true);
    }, 1_200_000);

    it('records every game hour of both runs', () => {
      expect(fast.hours.length).toBe(DAYS * 24);
      expect(hung.hours.length).toBe(fast.hours.length);
      expect(hung.hours.map((h) => h.t)).toEqual(fast.hours.map((h) => h.t));
    });

    it.each(KEYS)('keeps %s identical at every game hour', (key) => {
      expect(firstMismatch(fast.hours, hung.hours, key)).toBeNull();
    });

    it('keeps the forest animals identical while nobody comes near them, and always the same animals', () => {
      const until = Math.min(fast.forestDisturbedAt, hung.forestDisturbedAt);
      expect(firstMismatch(fast.hours, hung.hours, 'forest', until)).toBeNull();
      expect(firstMismatch(fast.hours, hung.hours, 'forestIds')).toBeNull();
    });

    it('exercises the systems it compares', () => {
      const last = fast.hours.at(-1)!;
      expect(JSON.parse(last.letters) as unknown[]).toHaveLength(DAYS * LETTER_TIMES.length);
      expect(
        (JSON.parse(last.letters) as [string, number, number | null][]).every((l) => l[2] !== null),
      ).toBe(true);
      expect((JSON.parse(last.notices) as unknown[]).length).toBeGreaterThanOrEqual(1);
      expect(fast.hours.some((h) => /"boarding"/.test(h.train))).toBe(true);
      expect(fast.hours.some((h) => /true/.test(h.hotel))).toBe(true);
    });

    it('keeps the clock advancing with a model that never answers (the wake-up hold times out)', () => {
      expect(hung.end).toBe(at(DAYS, '06:00'));
      for (const d of hung.wakingUpDays) expect(hung.runningDays.has(d), `day ${d} resumed`).toBe(true);
    });
  },
);
