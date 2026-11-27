/** AC25: Laude and Franzi's slow-burn shy crush. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMind } from '../../../src/server/cognition/mind.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import { at, dayOf, formatClock } from '../../../src/shared/time.ts';
import type {
  Conversation,
  GameMinutes,
  Romance,
  VillageEvent,
  VillagerId,
} from '../../../src/shared/types.ts';
import { readyV2, waitingForV2 } from '../../helpers/features.ts';
import { V2 } from '../../helpers/v2.ts';
import { createTestWorld, mutualAffinity, type TestWorld } from '../../helpers/world.ts';

const F = [...V2.romance, 'postOffice' as const];
const LAUDE = 'laude';
const FRANZI = 'franzi';
const PAIR: [VillagerId, VillagerId] = [FRANZI, LAUDE];
const DAYS = 7;
const SHY_AFFINITY = 8;
const SCRIPTED_CHATS = 6;

const isPair = (ids: readonly VillagerId[]) =>
  ids.length === 2 && ids.includes(LAUDE) && ids.includes(FRANZI);
const pairRomance = (w: TestWorld): Romance | undefined =>
  (w.state().romances ?? []).find((r) => isPair(r.pair));
const affinity = (w: TestWorld, from: VillagerId, to: VillagerId) =>
  w.villager(from).relationships[to]?.affinity ?? 0;

interface DateAsk {
  at: GameMinutes;
  villagerId: string;
  affinities: [number, number];
}

/** Records every date.ask the pair sends to the model, with both affinities at that moment. */
function recordAsks(provider: MockChatProvider, world: () => TestWorld | undefined, out: DateAsk[]): void {
  provider.setLatency((req) => {
    const w = world();
    const id = String(req.meta?.villagerId ?? '');
    if (w && req.task === 'date.ask' && (id === LAUDE || id === FRANZI))
      out.push({
        at: w.now(),
        villagerId: id,
        affinities: [affinity(w, LAUDE, FRANZI), affinity(w, FRANZI, LAUDE)],
      });
    return 0;
  });
}

function pairDates(events: Map<string, VillageEvent>): VillageEvent[] {
  return [...events.values()].filter((e) => e.kind === 'date' && isPair([e.hostId, ...e.invitees]));
}

async function shyCrushLine(w: TestWorld, id: VillagerId): Promise<string[]> {
  const { romanceLines } = await import('../../../src/client/ui/inspector.ts');
  const r = w.inspect(id)?.romance;
  return r ? romanceLines(r, id).map((l) => l.text) : [];
}

describe.skipIf(!readyV2(...F))(`AC25: Laude and Franzi's shy crush${waitingForV2(...F)}`, () => {
  describe('7 seeded days', () => {
    let w: TestWorld | undefined;
    let seed: Romance | undefined;
    const asks: DateAsk[] = [];
    const events = new Map<string, VillageEvent>();
    const datesFirstSeen = new Map<string, { at: GameMinutes; affinities: [number, number] }>();
    const franziAtPostOffice = new Set<number>();
    const seedLines: Record<string, string[]> = {};

    beforeAll(async () => {
      const provider = new MockChatProvider('mock');
      recordAsks(provider, () => w, asks);
      // The seeded week was tuned on the 06:00 hold; soft wake shifts day 1 by a minute, and the
      // butterfly effect moves Franzi's later post-office trips.
      const world = await createTestWorld({
        villagers: 12,
        seed: 25,
        startAt: '06:00',
        provider,
        config: { sim: { wakeUpMode: 'hold' } },
      });
      w = world;
      seed = pairRomance(world);
      for (const id of PAIR) seedLines[id] = await shyCrushLine(world, id);
      world.engine.onMessage((m) => {
        if (m.type !== 'event.updated') return;
        events.set(m.event.id, m.event);
        if (m.event.kind === 'date' && !datesFirstSeen.has(m.event.id))
          datesFirstSeen.set(m.event.id, {
            at: world.now(),
            affinities: [affinity(world, LAUDE, FRANZI), affinity(world, FRANZI, LAUDE)],
          });
      });
      await world.advanceTo(at(DAYS, '06:00'), {
        onStep: ({ time, snapshot }) => {
          if (snapshot().villagers.find((v) => v.id === FRANZI)?.locationId === 'post_office')
            franziAtPostOffice.add(dayOf(time));
        },
      });
    }, 600_000);

    afterAll(() => w?.dispose());

    it('the seed romance is a shy crush from both sides', () => {
      expect(seed).toBeDefined();
      expect(seed!.pair).toEqual(PAIR);
      expect(seed!.stage).toBe('crush');
      expect(seed!.shy).toBe(true);
      expect([...seed!.crushFrom].sort()).toEqual(PAIR);
    });

    it('Franzi visits the post office on at least 4 of the 7 days', () => {
      const days = [...franziAtPostOffice].filter((d) => d < DAYS);
      expect(days.length).toBeGreaterThanOrEqual(4);
    });

    it('their conversations have at most shyMaxTurns turns', () => {
      const chats: Conversation[] = w!.conversations().filter((c) => isPair(c.participants));
      expect(chats.length).toBeGreaterThanOrEqual(1);
      const long = chats.filter((c) => c.messages.length > w!.config.romance.shyMaxTurns);
      expect(long.map((c) => `${c.id}: ${c.messages.length} turns`)).toEqual([]);
    });

    it('no date is asked before day shyMinDays or while either affinity is below 8', () => {
      const { shyMinDays } = w!.config.romance;
      const early = asks
        .filter((a) => dayOf(a.at) < shyMinDays || a.affinities.some((x) => x < SHY_AFFINITY))
        .map(
          (a) =>
            `${a.villagerId} asked on day ${dayOf(a.at)} ${formatClock(a.at)} at ${a.affinities.join('/')}`,
        );
      expect(early).toEqual([]);
      const earlyDates = pairDates(events)
        .map((e) => ({ e, seen: datesFirstSeen.get(e.id)! }))
        .filter(({ seen }) => dayOf(seen.at) < shyMinDays || seen.affinities.some((x) => x < SHY_AFFINITY))
        .map(({ e }) => e.id);
      expect(earlyDates).toEqual([]);
    });

    // Within the 7 days the pair may date and become a couple under the §7.1 rules, so the shy
    // crush line is checked on the seed.
    it('the inspector shows the seeded shy crush', () => {
      expect(seedLines[LAUDE]).toContainEqual(expect.stringContaining('Shy crush'));
      expect(seedLines[FRANZI]).toContainEqual(expect.stringContaining('Shy crush'));
    });
  });

  // Controlled scenario for the gossip bullet (spec v2 §7.1 "Gossip"). Under the mock provider with
  // drainLlm, a pair chat that starts with both standing on adjacent tiles runs and ends inside one
  // step, so no observer's update ever sees it; whether a week brings such a visible chat and a
  // witness together is luck (about 2 of 16 seeds). Controls, and what this scenario does not cover:
  // - four villagers' intents are pinned in the window (Franzi and Laude go to the post office, the
  //   witness Mia to the notice board, the control Tom to the penguins); each pinned mind still
  //   runs its real update() first, so romance and shyGossip run unchanged;
  // - the post office keeps only two of its real spots, 2 tiles apart, so the engine's chat start
  //   always needs a one-tile approach walk and the chat is live for one step;
  // - the 7-day run above therefore no longer proves that gossip happens on its own in a normal week,
  //   and the pair's own plans bringing them there are covered by the visit bullet, not here.
  describe('gossip at the post office, with a witness nearby', () => {
    const WITNESS = 'mia';
    const CONTROL = 'tom';
    const GOSSIP = 'Franzi was at the post office again, chatting shyly with Laude.';
    const PINS: Record<VillagerId, { from: string; locationId: string; activity: string }> = {
      [FRANZI]: { from: '09:00', locationId: 'post_office', activity: 'drop by the post office' },
      [LAUDE]: { from: '09:00', locationId: 'post_office', activity: 'sort the letters' },
      [WITNESS]: { from: '06:30', locationId: 'notice_board', activity: 'read the notices' },
      [CONTROL]: { from: '06:30', locationId: 'zoo_penguin', activity: 'watch the penguins' },
    };
    const UNTIL = at(0, '11:00');
    let w: TestWorld | undefined;
    const startDistance = new Map<string, number>();
    const live: { id: string; witness: number; control: number }[] = [];

    beforeAll(async () => {
      const base = await createTestWorld({ villagers: 12, seed: 25 });
      const map = structuredClone(base.engine.map);
      base.dispose();
      const post = map.locations.find((l) => l.id === 'post_office')!;
      post.spots = [
        { x: 52, y: 6 },
        { x: 54, y: 6 },
      ];
      const world = await createTestWorld({
        villagers: 12,
        seed: 25,
        startAt: '06:00',
        map,
        createMind: (profile, deps) => {
          const mind = createMind(profile, deps);
          const pin = PINS[profile.id];
          if (!pin) return mind;
          const update = mind.update.bind(mind);
          mind.update = (view) => {
            const intent = update(view);
            return view.now >= at(0, pin.from) && view.now < UNTIL
              ? { type: 'goto', locationId: pin.locationId, activity: pin.activity }
              : intent;
          };
          return mind;
        },
      });
      w = world;
      const tiles = (p: { x: number; y: number }) => {
        const { x, y, w: aw, h } = post.area;
        return Math.max(Math.max(x - p.x, 0, p.x - (x + aw - 1)), Math.max(y - p.y, 0, p.y - (y + h - 1)));
      };
      await world.advanceTo(UNTIL, {
        chunk: 1,
        onStep: ({ snapshot }) => {
          const vs = snapshot().villagers;
          const [f, l] = [FRANZI, LAUDE].map((id) => vs.find((v) => v.id === id)!);
          if (!f!.conversationId || f!.conversationId !== l!.conversationId) return;
          // Seen right after the step that started it, before the approach walk moves anyone.
          if (!live.some((s) => s.id === f!.conversationId))
            startDistance.set(f!.conversationId, Math.hypot(f!.pos.x - l!.pos.x, f!.pos.y - l!.pos.y));
          live.push({
            id: f!.conversationId,
            witness: tiles(vs.find((v) => v.id === WITNESS)!.pos),
            control: tiles(vs.find((v) => v.id === CONTROL)!.pos),
          });
        },
      });
    }, 600_000);

    afterAll(() => w?.dispose());

    it('the engine starts their chat at the post office with an approach walk, and it is live at a step', () => {
      // The test never starts a conversation itself: every one here was started by the engine.
      const atPost = w!
        .conversations()
        .filter((c) => isPair(c.participants) && c.locationId === 'post_office');
      expect(atPost.length).toBeGreaterThanOrEqual(1);
      const seen = live.filter((s) => atPost.some((c) => c.id === s.id));
      expect([...startDistance.values()].every((d) => d > 1.5)).toBe(true);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen.every((s) => s.witness <= 8 && s.control > 8)).toBe(true);
    });

    it('the witness remembers it once; the control and the pair do not', () => {
      const gossip = (id: VillagerId) => w!.memories(id).filter((m) => m.text === GOSSIP);
      expect(gossip(WITNESS)).toHaveLength(1);
      expect(gossip(WITNESS)[0]).toMatchObject({ kind: 'observation', importance: 5 });
      for (const id of [CONTROL, FRANZI, LAUDE]) expect(gossip(id)).toHaveLength(0);
    });
  });

  describe('with scripted affinities of 8 and 6 chats by day 5', () => {
    let w: TestWorld | undefined;
    const asks: DateAsk[] = [];
    const events = new Map<string, VillageEvent>();
    let acceptedDay: number | null = null;

    const accepted = (world: TestWorld) =>
      pairDates(events).some((e) => e.invitees.every((id) => e.accepted.includes(id))) ||
      (pairRomance(world)?.dates ?? []).some((d) => d.status === 'planned' || d.status === 'done');

    beforeAll(async () => {
      const provider = new MockChatProvider('mock');
      recordAsks(provider, () => w, asks);
      const world = await createTestWorld({
        villagers: 12,
        seed: 25,
        startAt: '06:00',
        provider,
        affinities: mutualAffinity(LAUDE, FRANZI, SHY_AFFINITY),
        patchSave: (save) => {
          for (let i = 0; i < SCRIPTED_CHATS; i++) {
            const t = at(0, '00:30') + i * 40;
            save.conversations.push({
              id: `scripted_shy_${i}`,
              participants: [LAUDE, FRANZI],
              locationId: 'post_office',
              startedAt: t,
              endedAt: t + 5,
              messages: [
                { speakerId: LAUDE, text: 'Oh, hello Franzi. Lovely day.', at: t },
                { speakerId: FRANZI, text: 'Hi Laude! Yes, lovely.', at: t + 2 },
              ],
              status: 'ended',
            });
          }
        },
      });
      w = world;
      world.engine.onMessage((m) => {
        if (m.type === 'event.updated') events.set(m.event.id, m.event);
      });
      while (world.now() < at(DAYS + 1, '00:00') && acceptedDay === null) {
        await world.advance(60);
        if (accepted(world)) acceptedDay = dayOf(world.now());
      }
    }, 600_000);

    afterAll(() => w?.dispose());

    it('a date is asked on day shyMinDays or later', () => {
      expect(asks.length).toBeGreaterThanOrEqual(1);
      expect(Math.min(...asks.map((a) => dayOf(a.at)))).toBeGreaterThanOrEqual(w!.config.romance.shyMinDays);
      expect(pairDates(events).length).toBeGreaterThanOrEqual(1);
    });

    it('the date is accepted by day 7', () => {
      expect(acceptedDay).not.toBeNull();
      expect(acceptedDay!).toBeLessThanOrEqual(DAYS);
      expect(['dating', 'couple']).toContain(pairRomance(w!)?.stage);
    });

    it('the inspector shows "Shy crush"', async () => {
      expect(pairRomance(w!)?.shy).toBe(true);
      expect(await shyCrushLine(w!, FRANZI)).toContainEqual(expect.stringContaining('Shy crush'));
    });
  });
});
