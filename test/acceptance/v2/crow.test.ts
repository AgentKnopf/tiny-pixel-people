/** AC23: the crow on the post office roof. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnimalState, GameMinutes, Location, Point, WorldMap } from '../../../src/shared/types.ts';
import { at, dayOf, minuteOfDay, parseClock } from '../../../src/shared/time.ts';
import { readyV2, waitingForV2, type Feature } from '../../helpers/features.ts';
import { dist, loc, V2, walkPlayerTo } from '../../helpers/v2.ts';
import { walkable } from '../../helpers/invariants.ts';
import { createTestWorld, stubMind, type TestWorld, type TestWorldOptions } from '../../helpers/world.ts';

const F: Feature[] = [...new Set<Feature>([...V2.animals, ...V2.post])];

const SEED = 21;
const RANGE = 6;
const CAW_RADIUS = 3;
const COOLDOWN = 30;
const SLEEP_FROM = parseClock('20:00');
const SLEEP_UNTIL = parseClock('06:00');
/** A flight back to the perch may still be landing just after 20:00. */
const LANDING_SLACK = 5;

interface CrowSample {
  t: GameMinutes;
  x: number;
  y: number;
  status: AnimalState['status'];
  facing: AnimalState['facing'];
  player: Point;
}

interface CrowRun {
  samples: CrowSample[];
  caws: GameMinutes[];
  post: Location;
}

const crowOf = (w: TestWorld): AnimalState => {
  const c = (w.state().animals ?? []).find((a) => a.species === 'crow');
  if (!c) throw new Error('no crow in the world');
  return c;
};

const onPerch = (post: Location, p: Point, slack = 0.5) =>
  (post.perch ?? []).some((q) => Math.abs(q.x - p.x) < slack && Math.abs(q.y - p.y) < slack);

const perchDistance = (post: Location, p: Point) => Math.min(...(post.perch ?? []).map((q) => dist(p, q)));

function rectDistance(p: Point, r: Location['area']): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w - 1));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h - 1));
  return Math.hypot(dx, dy);
}

const asleepWindow = (t: GameMinutes) => {
  const m = minuteOfDay(t);
  return m >= SLEEP_FROM + LANDING_SLACK || m < SLEEP_UNTIL;
};

/** Walkable tiles connected to `from` (4-neighbour flood fill). */
function reachableFrom(map: WorldMap, from: Point): Set<string> {
  const key = (p: Point) => `${p.x},${p.y}`;
  const seen = new Set([key(from)]);
  const queue = [from];
  for (let p = queue.pop(); p; p = queue.pop())
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const q = { x: p.x + dx, y: p.y + dy };
      if (!seen.has(key(q)) && walkable(map, q)) {
        seen.add(key(q));
        queue.push(q);
      }
    }
  return seen;
}

/** The reachable tile closest to the perch (where the player can stand near the crow). */
function nearPerchTile(map: WorldMap, post: Location): Point {
  // Isolated walkable pockets behind the building exist; the player must be able to walk there.
  const reachable = reachableFrom(map, post.entry);
  let best: Point | null = null;
  let bestD = Infinity;
  for (let y = 0; y <= post.area.y + post.area.h + 4; y++)
    for (let x = post.area.x - 6; x <= post.area.x + post.area.w + 6; x++) {
      const p = { x, y };
      if (!reachable.has(`${x},${y}`)) continue;
      const d = perchDistance(post, p);
      if (d < bestD) [best, bestD] = [p, d];
    }
  if (!best) throw new Error('no walkable tile near the post office');
  return best;
}

/** A walkable tile within 2 tiles of the post office door (the post box). */
function postBoxTile(map: WorldMap, post: Location): Point {
  const door = post.door ?? post.entry;
  if (walkable(map, post.entry) && dist(post.entry, door) <= 2) return post.entry;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const p = { x: door.x + dx, y: door.y + dy };
      if (walkable(map, p) && dist(p, door) <= 2) return p;
    }
  throw new Error('no walkable tile within 2 tiles of the post office door');
}

/** Step one minute at a time, recording the crow and its caws. */
async function stepRecording(w: TestWorld, crowId: string, run: CrowRun, minutes: number): Promise<void> {
  for (let i = 0; i < minutes; i++) {
    const before = w.messages.length;
    await w.advance(1, { chunk: 1 });
    const t = w.now();
    if (w.messages.slice(before).some((m) => m.type === 'animal.emote' && m.animalId === crowId))
      run.caws.push(t);
    const c = crowOf(w);
    run.samples.push({
      t,
      x: c.pos.x,
      y: c.pos.y,
      status: c.status,
      facing: c.facing,
      player: { ...w.state().player.pos },
    });
  }
}

async function runCrowDays(neverAnswer: boolean): Promise<CrowRun> {
  const opts: TestWorldOptions = {
    villagers: 12,
    seed: SEED,
    startAt: '06:00',
    neverAnswer,
    // No villager-written letters, so the crow's only letter triggers are identical in both runs.
    config: {
      post: { maxVillagerLettersPerDay: 0 },
      sim: { wakeUpMode: 'hold', wakeUpTimeoutSec: 2 },
      llm: { timeoutMs: 3000 },
    },
  };
  const w = await createTestWorld(opts);
  try {
    const map = w.engine.map;
    const post = loc(map, 'post_office');
    const near = nearPerchTile(map, post);
    const far = loc(map, 'player_home').entry;
    const moves = new Map<GameMinutes, Point>([
      [at(0, '10:00'), near],
      [at(1, '07:00'), far],
      [at(1, '12:00'), near],
      [at(1, '17:00'), far],
    ]);
    const run: CrowRun = { samples: [], caws: [], post };
    const crowId = crowOf(w).id;
    const end = at(2, '06:00');
    while (w.now() < end) {
      const to = moves.get(w.now());
      if (to) w.command({ type: 'player.move', to });
      await stepRecording(w, crowId, run, 1);
    }
    return run;
  } finally {
    w.dispose();
  }
}

function firstDifference(a: CrowRun, b: CrowRun): string | null {
  const n = Math.max(a.samples.length, b.samples.length);
  for (let i = 0; i < n; i++) {
    const x = JSON.stringify(a.samples[i]);
    const y = JSON.stringify(b.samples[i]);
    if (x !== y) return `sample ${i}: fast ${x} vs never-answer ${y}`;
  }
  return JSON.stringify(a.caws) === JSON.stringify(b.caws)
    ? null
    : `caws: fast ${JSON.stringify(a.caws)} vs never-answer ${JSON.stringify(b.caws)}`;
}

describe.skipIf(!readyV2(...F))(`AC23: the crow${waitingForV2(...F)}`, () => {
  describe('two days, fast mock and a mock that never answers', () => {
    let fast: CrowRun;
    let hung: CrowRun;

    beforeAll(async () => {
      fast = await runCrowDays(false);
      hung = await runCrowDays(true);
    }, 900_000);

    it('is always on a perch tile, or flying within 6 tiles of the post office', () => {
      const problems: string[] = [];
      for (const s of fast.samples) {
        const p = { x: s.x, y: s.y };
        if (onPerch(fast.post, p)) continue;
        if (rectDistance(p, fast.post.area) > RANGE) problems.push(`${s.t}: (${s.x}, ${s.y}) too far`);
        else if (perchDistance(fast.post, p) > 1.5 && s.status !== 'flying')
          problems.push(`${s.t}: off the perch while ${s.status}`);
      }
      expect(problems.slice(0, 10), `${problems.length} problems`).toEqual([]);
    });

    it('makes 3–6 short flights a day and hops between perch tiles', () => {
      for (const day of [0, 1]) {
        const daySamples = fast.samples.filter(
          (s) => dayOf(s.t) === day && minuteOfDay(s.t) >= SLEEP_UNTIL && minuteOfDay(s.t) < SLEEP_FROM,
        );
        let flights = 0;
        let away = false;
        let longest = 0;
        let current = 0;
        for (const s of daySamples) {
          const off = perchDistance(fast.post, { x: s.x, y: s.y }) > 1.5;
          if (off && !away) flights++;
          current = off ? current + 1 : 0;
          longest = Math.max(longest, current);
          away = off;
        }
        expect(flights, `day ${day} flights`).toBeGreaterThanOrEqual(3);
        expect(flights, `day ${day} flights`).toBeLessThanOrEqual(6);
        expect(longest, `day ${day} longest flight (min)`).toBeLessThanOrEqual(5);
        const perchTiles = new Set(
          daySamples.filter((s) => onPerch(fast.post, s)).map((s) => `${Math.round(s.x)},${Math.round(s.y)}`),
        );
        expect(perchTiles.size, `day ${day} perch tiles used`).toBeGreaterThanOrEqual(2);
      }
    });

    it('sleeps on the perch from 20:00 to 06:00', () => {
      const night = fast.samples.filter((s) => asleepWindow(s.t));
      expect(night.length).toBeGreaterThan(2 * 9 * 60);
      const awake = night.filter((s) => s.status !== 'sleeping' || !onPerch(fast.post, s));
      expect(
        awake.slice(0, 5).map((s) => `${s.t} ${s.status} (${s.x}, ${s.y})`),
        `${awake.length} samples`,
      ).toEqual([]);
    });

    it('caws when the player comes within 3 tiles, at most once per 30 minutes', () => {
      const gaps = fast.caws.slice(1).map((t, i) => t - fast.caws[i]!);
      expect(gaps.filter((g) => g < COOLDOWN)).toEqual([]);
      const approaches: GameMinutes[] = [];
      for (let i = 1; i < fast.samples.length; i++) {
        const prev = fast.samples[i - 1]!;
        const cur = fast.samples[i]!;
        if (cur.status === 'sleeping') continue;
        if (dist(prev.player, prev) > CAW_RADIUS && dist(cur.player, cur) <= CAW_RADIUS)
          approaches.push(cur.t);
      }
      expect(approaches.length, 'the player came within 3 tiles of the awake crow').toBeGreaterThanOrEqual(1);
      const silent = approaches.filter((t) => !fast.caws.some((c) => c >= t - COOLDOWN && c <= t + 1));
      expect(silent, 'approaches with no caw (and no caw in the 30 min before)').toEqual([]);
    });

    it('behaves identically with a mock that never answers', () => {
      expect(hung.samples.length).toBe(fast.samples.length);
      expect(firstDifference(fast, hung)).toBeNull();
    });
  });

  describe('caws for letters', () => {
    let w: TestWorld;
    let run: CrowRun;
    let crowId = '';
    let firstPost: GameMinutes = 0;
    let secondPostReplies: string[] = [];
    let cawsAfterSecond: GameMinutes[] = [];

    beforeAll(async () => {
      w = await createTestWorld({ villagers: 12, seed: SEED, startAt: '08:00', createMind: stubMind });
      const map = w.engine.map;
      run = { samples: [], caws: [], post: loc(map, 'post_office') };
      crowId = crowOf(w).id;
      if (!(await walkPlayerTo(w, postBoxTile(map, run.post))))
        throw new Error('player never reached the post box');
      const quiet = () => {
        const last = run.caws.at(-1);
        return crowOf(w).status !== 'sleeping' && (last === undefined || w.now() - last >= COOLDOWN);
      };
      for (let i = 0; i < 120 && !quiet(); i++) await stepRecording(w, crowId, run, 1);
      if (!quiet()) throw new Error('the crow never left its cooldown');
      firstPost = w.now();
      const before = w.messages.length;
      w.command({
        type: 'letter.send',
        to: 'arthur',
        text: 'Dear Arthur, the tulips are blooming. Come and see!',
      });
      if (w.messages.slice(before).some((m) => m.type === 'animal.emote' && m.animalId === crowId))
        run.caws.push(firstPost);
      await stepRecording(w, crowId, run, 5);
      const replies = w.command({
        type: 'letter.send',
        to: 'rosa',
        text: 'Dear Rosa, may I hear a story soon?',
      });
      secondPostReplies = replies.map((m) => m.type);
      await stepRecording(w, crowId, run, COOLDOWN - 6);
      cawsAfterSecond = run.caws.filter((t) => t > firstPost + 1);
      w.command({ type: 'player.move', to: loc(map, 'player_home').entry });
      await stepRecording(w, crowId, run, at(0, '11:03') - w.now());
    }, 300_000);

    afterAll(() => w?.dispose());

    it('caws when a letter is posted', () => {
      expect(run.caws.filter((t) => t >= firstPost && t <= firstPost + 1)).toHaveLength(1);
    });

    it('stays quiet for 30 minutes after a caw', () => {
      expect(secondPostReplies).not.toContain('error');
      expect(cawsAfterSecond).toEqual([]);
    });

    it('caws at the delivery round that delivers the letters', () => {
      const round = at(0, w.config.post.deliveryTimes[0]!);
      expect(run.caws.filter((t) => t >= round && t <= round + 2).length).toBe(1);
      const letters = (w.state().letters ?? []).filter((l) => l.from === 'player');
      expect(letters.length).toBe(2);
      for (const l of letters) expect(l.deliveredAt, l.to).toBe(round);
    });
  });
});
