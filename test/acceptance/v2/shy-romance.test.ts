/** AC25: Laude and Franzi's slow-burn shy crush. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
      const world = await createTestWorld({ villagers: 12, seed: 25, startAt: '06:00', provider });
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

    it('another villager has a memory about them at the post office', () => {
      const others = w!.state().villagers.filter((v) => !PAIR.includes(v.id));
      const hits = others.filter((v) =>
        w!
          .memories(v.id)
          .some((m) => /franzi/i.test(m.text) && /laude/i.test(m.text) && /post office/i.test(m.text)),
      );
      expect(hits.length).toBeGreaterThanOrEqual(1);
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
