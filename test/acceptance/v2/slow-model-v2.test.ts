/** AC16: slow-model behaviour covers the new v2 LLM tasks. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAG_OVERLOADED, loadTracker, type LoadLevel } from '../../../src/server/cognition/llm.ts';
import type { LlmTask } from '../../../src/server/llm/types.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import { Engine } from '../../../src/server/sim/engine.ts';
import { at, dayOf, formatClock } from '../../../src/shared/time.ts';
import {
  PLAYER_ID,
  type GameMinutes,
  type HouseVisit,
  type Letter,
  type Location,
  type Point,
  type Romance,
  type VillagerId,
  type VisitorInfo,
} from '../../../src/shared/types.ts';
import { readyV2, waitingForV2 } from '../../helpers/features.ts';
import { dist, loc, V2, walkPlayerTo } from '../../helpers/v2.ts';
import { createTestWorld, mutualAffinity, presetTalks, sleep, type TestWorld } from '../../helpers/world.ts';

const F = [...new Set([...V2.visitors, ...V2.romance, ...V2.interiors, ...V2.post])];

/**
 * Spec: 30 s per call on a 15-minute day (0.625 s per game minute), i.e. about 48 game minutes per
 * call. The loop below paces the virtual clock at about PACE_MS per game minute, so LATENCY_MS keeps
 * roughly that ratio while one game day takes seconds of real time.
 */
const LATENCY_MS = 250;
const PACE_MS = 5;
const START = at(0, '06:00');
const END = at(1, '06:00');
/** After the morning's house visit and letter. */
const PAIR_TALK_FROM = at(0, '10:00');
const NEW_TASKS: LlmTask[] = [
  'visit.greet',
  'letter.reply',
  'letter.write',
  'visitor.create',
  'date.ask',
  'date.decide',
];
const LETTER = 'Dear Mia, the plum jam you made was wonderful. Could you teach me the recipe?';
const RECIPIENT = 'mia';
const A = 'sam';
const B = 'ivy';
/** The engine's romance id format (`romance-<a>-<b>`, ids sorted). */
const SEED_ROMANCE_ID = `romance-${[A, B].sort().join('-')}`;

type House = Location & { door: Point; ownerIds: VillagerId[] };

describe.skipIf(!readyV2(...F))(`AC16: slow model, v2 tasks${waitingForV2(...F)}`, () => {
  let w: TestWorld;
  let level: () => LoadLevel = () => 'normal';
  const enqueued: { task: LlmTask; at: GameMinutes; level: LoadLevel }[] = [];
  const levels: { at: GameMinutes; level: LoadLevel }[] = [];
  const stepMs: number[] = [];
  const visitors = new Map<VillagerId, VisitorInfo>();
  const villagerLetters: { letter: Letter; level: LoadLevel }[] = [];
  let visit: HouseVisit | undefined;
  let sent: Letter | undefined;
  let byTask: Record<string, unknown> = {};
  let thrown: unknown = null;
  /** Conversations of the crush pair, with the load level when each ended (an ask would follow). */
  const pairTalks: { at: GameMinutes; level: LoadLevel }[] = [];
  let pairTalkRequestedAt = -Infinity;

  async function paced(until: GameMinutes): Promise<void> {
    while (w.now() < until) {
      const t0 = performance.now();
      await w.advance(1, { chunk: 1 });
      stepMs.push(performance.now() - t0);
      levels.push({ at: w.now(), level: level() });
      for (const v of w.state().visitors ?? []) visitors.set(v.villagerId, v);
      // "Have them talk" while overloaded, so the pair has a real chance to ask that must be skipped.
      const now = w.now();
      if (
        now >= PAIR_TALK_FROM &&
        !pairTalks.some((t) => t.level === 'overloaded') &&
        level() === 'overloaded' &&
        now - pairTalkRequestedAt >= 60 &&
        w.command({ type: 'player.pairTalk', aId: A, bId: B }).length === 0
      )
        pairTalkRequestedAt = now;
      await sleep(PACE_MS);
    }
  }

  async function visitAnOwner(): Promise<HouseVisit | undefined> {
    const houses = w.engine.map.locations.filter(
      (l): l is House => l.kind === 'house' && !!l.interiorId && !!l.door && !!l.ownerIds?.length,
    );
    const homeAwake = (h: House) =>
      h.ownerIds.some((id) => {
        const v = w.state().villagers.find((x) => x.id === id);
        return !!v && v.locationId === h.id && v.status !== 'sleeping';
      });
    for (let i = 0; i < 6; i++) {
      const p = w.state().player.pos;
      const h = houses.filter(homeAwake).sort((a, b) => dist(a.entry, p) - dist(b.entry, p))[0];
      if (!h) {
        await paced(w.now() + 15);
        continue;
      }
      if (!(await walkPlayerTo(w, h.entry)) || !homeAwake(h)) continue;
      const since = w.now();
      w.command({ type: 'player.enter', locationId: h.id });
      const find = () => (w.state().houseVisits ?? []).find((v) => v.houseId === h.id && v.at >= since);
      while (w.now() < since + 65 && !find()?.greeting) await paced(w.now() + 1);
      w.command({ type: 'player.exit' });
      return find();
    }
    return undefined;
  }

  beforeAll(async () => {
    const provider = new MockChatProvider('mock');
    provider.setLatency(LATENCY_MS);
    w = await createTestWorld({
      villagers: 12,
      seed: 16,
      startAt: START,
      provider,
      drainLlm: false,
      config: { llm: { concurrency: 1 }, sim: { wakeUpTimeoutSec: 0 } },
      affinities: mutualAffinity(A, B, 8),
      patchSave: (save) => {
        save.romances = [
          ...(save.romances ?? []),
          {
            id: SEED_ROMANCE_ID,
            pair: [B, A],
            stage: 'crush',
            since: 0,
            crushFrom: [A, B],
            dates: [],
            updatedAt: 0,
          },
        ];
      },
    });
    if (!(w.engine instanceof Engine)) throw new Error('expected the WP2 engine');
    const queue = w.engine.queue;
    const tracker = loadTracker(queue);
    level = () => tracker.level(w.now());
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = (req, opts) => {
      enqueued.push({ task: req.task, at: w.now(), level: level() });
      return enqueue(req, opts);
    };
    w.engine.onMessage((m) => {
      if (m.type === 'conversation.ended' && m.participants.every((id) => id === A || id === B))
        pairTalks.push({ at: w.now(), level: level() });
      if (
        m.type === 'letter.updated' &&
        m.letter.status === 'posted' &&
        m.letter.from !== PLAYER_ID &&
        !m.letter.replyTo
      )
        villagerLetters.push({ letter: m.letter, level: level() });
    });
    try {
      await paced(at(0, '07:00'));
      visit = await visitAnOwner();
      await paced(at(0, '09:00'));
      const po = loc(w.engine.map, 'post_office');
      if (!(await walkPlayerTo(w, po.entry))) throw new Error('player could not reach the post office');
      w.command({ type: 'letter.send', to: RECIPIENT, text: LETTER });
      sent = (w.state().letters ?? []).find((l) => l.from === PLAYER_ID && l.text === LETTER);
      await paced(END);
    } catch (err) {
      thrown = err;
    }
    byTask = queue.stats().byTask ?? {};
  }, 600_000);

  afterAll(() => w?.dispose());

  const overloadedEnqueues = (task: LlmTask) =>
    enqueued
      .filter((e) => e.task === task && e.level === 'overloaded')
      .map((e) => `${dayOf(e.at)} ${formatClock(e.at)}`);

  it('no exception, and the clock runs a whole day without waiting on the model', () => {
    expect(thrown).toBeNull();
    expect(w.errors()).toEqual([]);
    expect(w.now()).toBeGreaterThanOrEqual(END);
    const sorted = [...stepMs].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    expect(sorted.length).toBeGreaterThan(20 * 60);
    // Anti-blocking gate relative to one model call, cold first step included; the §16 step budget
    // (p95 ≤ 4 ms, max ≤ 20 ms) is checked by perf-v2.test.ts in the sequential perf project.
    expect(p95).toBeLessThan(LATENCY_MS / 5);
    expect(sorted.at(-1)!).toBeLessThan(LATENCY_MS);
  });

  it('the load level reaches overloaded', () => {
    expect(levels.some((l) => l.level === 'overloaded')).toBe(true);
  });

  it('visitor.create falls back (provenance fallback)', () => {
    expect(visitors.size).toBeGreaterThanOrEqual(1);
    expect([...visitors.values()].some((v) => v.source === 'fallback')).toBe(true);
    expect(overloadedEnqueues('visitor.create')).toEqual([]);
  });

  it('date.decide falls back without a model call while overloaded', () => {
    expect(overloadedEnqueues('date.decide')).toEqual([]);
  });

  it('date.ask and letter.write are skipped while overloaded', () => {
    expect(
      pairTalks.filter((t) => t.level === 'overloaded').length,
      'the crush pair never finished a talk while overloaded, so no ask was ever due',
    ).toBeGreaterThanOrEqual(1);
    expect(overloadedEnqueues('date.ask')).toEqual([]);
    expect(overloadedEnqueues('letter.write')).toEqual([]);
    expect(villagerLetters.filter((l) => l.level === 'overloaded').map((l) => l.letter.id)).toEqual([]);
  });

  it('visit.greet still answers, with provenance', () => {
    expect(visit).toBeDefined();
    expect(visit!.kind).toBe('visit');
    expect(visit!.greeting?.length ?? 0).toBeGreaterThan(0);
    expect(['llm', 'fallback']).toContain(visit!.greetingSource);
  });

  it('letter.reply still answers, with provenance', () => {
    expect(sent).toBeDefined();
    const reply = (w.state().letters ?? []).find((l) => l.replyTo === sent!.id);
    expect(reply, 'no reply to the player letter').toBeDefined();
    expect(reply!.from).toBe(RECIPIENT);
    expect(reply!.to).toBe(PLAYER_ID);
    expect(['llm', 'fallback']).toContain(reply!.source);
  });

  it('the queue stats list the new tasks', () => {
    const keys = Object.keys(byTask);
    expect(keys).toEqual(expect.arrayContaining(['visit.greet', 'letter.reply']));
    const used = NEW_TASKS.filter((t) => enqueued.filter((e) => e.task === t).length >= 2);
    expect(keys).toEqual(expect.arrayContaining(used));
  });
});

/**
 * The overload transition for dates: a date.ask queued while the load is normal or busy reaches the
 * model only after the load has become overloaded (forced here through the load tracker when the
 * provider picks the request up). The invitee's date.decide must then use its fallback without a
 * model call; fallback accepts at affinity 4+, so the pair (affinity 8) gets a date.
 *
 * All of it happens within the one game day: the pair starts ready to date (mutual crush, affinity
 * 8, two earlier talks), and "Have them talk" (player.pairTalk) brings them together from TALK_AT,
 * since an ask follows a conversation and a chance meeting is not guaranteed within a day.
 */
describe.skipIf(!readyV2(...F))(
  `AC16: date.decide after the load turns overloaded${waitingForV2(...F)}`,
  () => {
    let w: TestWorld | undefined;
    const asks: {
      asker: VillagerId;
      queuedAt: GameMinutes;
      queuedLevel: LoadLevel;
      overloadedAt?: GameMinutes;
    }[] = [];
    const decides: { asker: VillagerId; at: GameMinutes; level: LoadLevel }[] = [];
    const pairIds = new Set<VillagerId>([A, B]);
    const TALK_AT = at(0, '09:00');
    /** When the pair's first conversation of the day ended (an ask follows a finished talk). */
    let pairTalkAt: GameMinutes | undefined;
    let requestedAt = -Infinity;
    const pairRomance = (): Romance | undefined =>
      (w?.state().romances ?? []).find((r) => r.pair.length === 2 && r.pair.every((id) => pairIds.has(id)));

    beforeAll(async () => {
      const provider = new MockChatProvider('mock');
      provider.setLatency((req) => {
        const asker = String(req.meta?.villagerId ?? '');
        const ask = asks.find(
          (a) => a.asker === asker && a.overloadedAt === undefined && a.queuedLevel !== 'overloaded',
        );
        if (w && req.task === 'date.ask' && ask && w.engine instanceof Engine) {
          loadTracker(w.engine.queue).seed(LAG_OVERLOADED * 4, w.now());
          ask.overloadedAt = w.now();
        }
        return 0;
      });
      const world = await createTestWorld({
        villagers: 12,
        seed: 16,
        startAt: START,
        provider,
        affinities: mutualAffinity(A, B, 8),
        patchSave: (save) => {
          presetTalks(save, A, B, [at(0, '00:30'), at(0, '01:20')], 'ac16');
          save.romances = [
            ...(save.romances ?? []),
            {
              id: SEED_ROMANCE_ID,
              pair: [B, A],
              stage: 'crush',
              since: 0,
              crushFrom: [A, B],
              dates: [],
              updatedAt: 0,
            },
          ];
        },
      });
      w = world;
      if (!(world.engine instanceof Engine)) throw new Error('expected the WP2 engine');
      const queue = world.engine.queue;
      const tracker = loadTracker(queue);
      const enqueue = queue.enqueue.bind(queue);
      queue.enqueue = (req, opts) => {
        const id = String(req.meta?.villagerId ?? '');
        const level = tracker.level(world.now());
        if (req.task === 'date.ask' && pairIds.has(id))
          asks.push({ asker: id, queuedAt: world.now(), queuedLevel: level });
        if (req.task === 'date.decide' && pairIds.has(id))
          decides.push({ asker: String(req.meta?.askerId ?? ''), at: world.now(), level });
        return enqueue(req, opts);
      };
      world.engine.onMessage((m) => {
        if (
          m.type === 'conversation.ended' &&
          pairTalkAt === undefined &&
          m.participants.every((id) => pairIds.has(id))
        )
          pairTalkAt = world.now();
      });
      await world.advanceTo(END, {
        onStep: ({ time }) => {
          // A accepted request has A walk over to B; ask again only if no talk came of it within an hour.
          if (pairTalkAt !== undefined || time < TALK_AT || time - requestedAt < 60) return;
          if (world.command({ type: 'player.pairTalk', aId: A, bId: B }).length === 0) requestedAt = time;
        },
      });
      const first = asks[0];
      console.info(
        `[AC16] pair talk at ${pairTalkAt === undefined ? 'never' : formatClock(pairTalkAt)}; first ask queued at ${
          first ? `${formatClock(first.queuedAt)} (${first.queuedLevel})` : 'never'
        }, reached the model at ${first?.overloadedAt === undefined ? 'never' : formatClock(first.overloadedAt)}`,
      );
    }, 600_000);

    afterAll(() => w?.dispose());

    it('a date.ask queued at normal/busy reaches the model after the load became overloaded', () => {
      const transitioned = asks.filter((a) => a.overloadedAt !== undefined && a.queuedLevel !== 'overloaded');
      expect(
        transitioned.length,
        'no date.ask queued at normal/busy reached the model',
      ).toBeGreaterThanOrEqual(1);
    });

    it('the invitee answers with the fallback: no date.decide call, and the date is planned', () => {
      const first = asks.find((a) => a.overloadedAt !== undefined && a.queuedLevel !== 'overloaded');
      expect(first).toBeDefined();
      expect(decides.filter((d) => d.at >= first!.overloadedAt!)).toEqual([]);
      const rec = pairRomance()?.dates.find((d) => d.askedBy === first!.asker);
      expect(rec, 'no date record for the ask').toBeDefined();
      expect(rec!.status, 'fallback accepts at affinity 4+').not.toBe('declined');
    });

    it('the talk, the ask, the switch to overloaded and the fallback answer all happen on the one day', () => {
      const first = asks.find((a) => a.overloadedAt !== undefined && a.queuedLevel !== 'overloaded');
      expect(pairTalkAt, 'the pair never talked').toBeDefined();
      expect(first).toBeDefined();
      for (const t of [pairTalkAt!, first!.queuedAt, first!.overloadedAt!]) {
        expect(t).toBeGreaterThanOrEqual(START);
        expect(t).toBeLessThan(END);
      }
      expect(pairRomance()?.dates.some((d) => d.askedBy === first!.asker)).toBe(true);
    });

    it('no date.ask is queued while overloaded', () => {
      expect(asks.filter((a) => a.queuedLevel === 'overloaded')).toEqual([]);
    });
  },
);
