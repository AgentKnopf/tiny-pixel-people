/** Romance through the real engine (spec v2 §7): storage, seed, save round-trip and the full date flow. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from '../../../src/shared/time.ts';
import type { Romance } from '../../../src/shared/types.ts';
import type { SaveData } from '../../../src/server/persistence/types.ts';
import { MemoryStore } from '../../../src/server/cognition/memory.ts';
import type { ScoreWeights } from '../../../src/server/cognition/retrieval.ts';
import { ready, SIM_FEATURES, waitingFor } from '../../helpers/features.ts';
import { createTestWorld, mutualAffinity, type TestWorld } from '../../helpers/world.ts';
import { DATE_VENUE_RE } from '../../../src/server/cognition/romance.ts';

const FEATURES = SIM_FEATURES;
/** The engine stores romances (MindWorld.upsertRomance, view.romances, the data/romance.json seed). */
const STORES_ROMANCE = (() => {
  try {
    return readFileSync(new URL('../../../src/server/sim/engine.ts', import.meta.url), 'utf8').includes(
      'upsertRomance',
    );
  } catch {
    return false;
  }
})();
/** Upper bound for runs that wait for dates: they have no deadline in the spec. */
const MAX_DAYS = 8;
const romances = (w: TestWorld): Romance[] => w.state().romances ?? [];
const between = (w: TestWorld, a: string, b: string) =>
  romances(w).find((r) => r.pair.includes(a) && r.pair.includes(b) && r.stage !== 'ended');

const crush = (a: string, b: string): Romance => ({
  id: `romance-${[a, b].sort().join('-')}`,
  pair: [a, b].sort() as [string, string],
  stage: 'crush',
  since: 0,
  crushFrom: [a],
  dates: [],
  updatedAt: 0,
});

const NAMES = new Map(
  (
    JSON.parse(readFileSync(new URL('../../../data/villagers.json', import.meta.url), 'utf8')) as {
      id: string;
      name: string;
    }[]
  ).map((p) => [p.id, p.name]),
);

/**
 * Finished conversations between `a` and `b` before the sim starts, recorded as the engine records
 * them (a `Talked with` memory on each side sharing the conversation id, plus lastTalkedAt), so a
 * crush test does not hinge on chance meetings.
 */
function priorTalks(save: SaveData, a: string, b: string, times: readonly number[]): void {
  for (const [self, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const snap = save.minds.find((m) => m.villagerId === self)!;
    const state = save.villagers.find((v) => v.id === self)!;
    const store = new MemoryStore(self, { weights: {} as ScoreWeights, defaultK: 8 });
    store.load(snap.memories);
    times.forEach((t, i) =>
      store.add({
        kind: 'conversation',
        at: t,
        text: `Talked with ${NAMES.get(other)}: I chatted with ${NAMES.get(other)} about the weather.`,
        meta: { conversationId: `prior-${[a, b].sort().join('-')}-${i + 1}` },
      }),
    );
    snap.memories = [...store.all()];
    state.relationships[other] = { ...state.relationships[other]!, lastTalkedAt: Math.max(...times) };
  }
}
async function days(w: TestWorld, n: number, each?: (day: number) => void): Promise<void> {
  for (let d = 0; d < n; d++) {
    await w.advanceTo('23:59', { chunk: 5 });
    await w.advance(2);
    each?.(d);
  }
}

describe.skipIf(!ready(...FEATURES) || !STORES_ROMANCE)(
  `romance in the engine${waitingFor(...FEATURES)}${STORES_ROMANCE ? '' : ' (waiting for engine romance storage)'}`,
  () => {
    it('the shy seed reaches the minds: short chats, no early date, and it survives a save round-trip', async () => {
      const w = await createTestWorld({ villagers: 12, startAt: '06:00' });
      const seed = between(w, 'laude', 'franzi')!;
      expect(seed).toMatchObject({ id: 'romance-franzi-laude', stage: 'crush', shy: true });
      expect(w.inspect('laude')?.romance).toMatchObject({ shy: true, stage: 'crush' });
      const max = w.config.romance!.shyMaxTurns;
      const shyChats = () =>
        w
          .conversations()
          .filter((c) => c.participants.includes('laude') && c.participants.includes('franzi'));
      // Chance meetings depend on the day's plans, so the player brings them together once.
      await w.advanceTo('10:00');
      w.command({ type: 'player.pairTalk', aId: 'laude', bId: 'franzi' });
      await days(w, 1);
      expect(shyChats().length).toBeGreaterThan(0);
      // The runner may add one canned reaction line after the cap.
      for (const c of shyChats()) expect(c.messages.length).toBeLessThanOrEqual(max + 1);
      expect(
        w.provider.calls.filter((c) => c.task === 'date.ask' && c.meta?.villagerId === 'laude'),
      ).toHaveLength(0);

      const save = w.engine.toSaveData();
      w.dispose();
      expect(save.romances?.some((r) => r.shy && r.pair.includes('laude'))).toBe(true);
      const w2 = await createTestWorld({ villagers: 12, restore: save });
      expect(romances(w2).filter((r) => r.shy)).toHaveLength(1);
      const before = w2.conversations().length;
      await days(w2, 1);
      const later = w2
        .conversations()
        .slice(before)
        .filter((c) => c.participants.includes('laude') && c.participants.includes('franzi'));
      for (const c of later) expect(c.messages.length).toBeLessThanOrEqual(max + 1);
      w2.dispose();
    }, 120_000);

    it('a pair at affinity 7 with two talks gets a crush within 3 nights; a 16-year-old never does', async () => {
      const w = await createTestWorld({
        villagers: 12,
        startAt: '06:00',
        affinities: [...mutualAffinity('sam', 'ivy', 7), ...mutualAffinity('leo', 'nora', 9)],
        patchSave: (s) => {
          priorTalks(s, 'sam', 'ivy', [30, 80]);
          priorTalks(s, 'leo', 'nora', [30, 80]);
        },
      });
      let crushDay = -1;
      await days(w, 3, (d) => {
        if (crushDay < 0 && between(w, 'sam', 'ivy')) crushDay = d;
      });
      expect(crushDay).toBeGreaterThanOrEqual(0);
      const r = between(w, 'sam', 'ivy')!;
      for (const id of r.crushFrom)
        expect(
          w.memories(id).some((m) => m.text.startsWith('I think I have a crush on') && m.importance === 7),
        ).toBe(true);
      expect(romances(w).some((x) => x.pair.includes('leo'))).toBe(false);
      expect(w.errors()).toEqual([]);
      w.dispose();
    }, 180_000);

    it('a crush leads to dates at §7 venues, witnesses gossip about them, and two done dates make a couple', async () => {
      const w = await createTestWorld({
        villagers: 12,
        startAt: '06:00',
        affinities: mutualAffinity('sam', 'ivy', 7),
        patchSave: (s) => {
          s.romances = [
            ...(s.romances ?? []),
            {
              id: 'romance-ivy-sam',
              pair: ['ivy', 'sam'],
              stage: 'crush',
              since: 0,
              crushFrom: ['sam'],
              dates: [],
              updatedAt: 0,
            },
          ];
        },
      });
      // When the pair first meets depends on the day's routes, so the player brings them together once;
      // dates have no deadline (spec v2 §7), so the run is bounded but waits for the couple and its gossip.
      await w.advanceTo('08:00');
      w.command({ type: 'player.pairTalk', aId: 'sam', bId: 'ivy' });
      const seen = /^I saw (Sam|Ivy) \S+ and (Sam|Ivy) \S+ on a date/;
      const others = w.engine.profiles.map((p) => p.id).filter((id) => !['sam', 'ivy'].includes(id));
      const witnesses = () => others.filter((id) => w.memories(id).some((m) => seen.test(m.text)));
      const heard = () =>
        others.filter(
          (id) =>
            !witnesses().includes(id) &&
            w.memories(id).some((m) => m.kind === 'heard' && /on a date/.test(m.text)),
        );
      for (let d = 0; d < MAX_DAYS && !(between(w, 'sam', 'ivy')?.stage === 'couple' && heard().length); d++)
        await days(w, 1);
      const dates = w
        .state()
        .events.filter((e) => e.kind === 'date' && [e.hostId, ...e.invitees].includes('sam'));
      expect(dates.length).toBeGreaterThanOrEqual(2);
      for (const e of dates) {
        const loc = w.location(e.locationId)!;
        expect(loc.kind === 'ride' || DATE_VENUE_RE.test(loc.id)).toBe(true);
        expect(e.end - e.start).toBe(90);
      }
      const done = dates.filter(
        (e) => e.status === 'done' && e.attendees.includes('sam') && e.attendees.includes('ivy'),
      );
      expect(
        done.length,
        JSON.stringify(dates.map((e) => [e.id, e.locationId, e.status, e.start, e.attendees])),
      ).toBeGreaterThanOrEqual(2);
      expect(w.memories('sam').some((m) => m.text.startsWith('I had a lovely date with Ivy'))).toBe(true);

      expect(witnesses().length).toBeGreaterThan(0);
      expect(heard().length).toBeGreaterThan(0);

      const r = between(w, 'sam', 'ivy')!;
      expect(r.stage).toBe('couple');
      expect(w.of('toast').some((t) => /💕 .*Ivy.* and .*Sam.* are now a couple!/.test(t.text))).toBe(true);
      expect(w.of('world.event').some((m) => m.event.kind === 'couple')).toBe(true);
      expect(w.of('romance.updated').some((m) => m.romance.stage === 'couple')).toBe(true);
      expect(w.inspect('sam')?.romance?.stage).toBe('couple');
      for (const id of ['sam', 'ivy'])
        expect(w.memories(id).some((m) => /are a couple now!/.test(m.text) && m.importance === 8)).toBe(true);
      expect(w.errors()).toEqual([]);
      w.dispose();
    }, 180_000);
    it('a date at a ride counts when both ride together', async () => {
      const w = await createTestWorld({
        villagers: 12,
        startAt: '06:00',
        affinities: mutualAffinity('sam', 'ivy', 7),
        patchSave: (s) => {
          s.romances = [...(s.romances ?? []), crush('sam', 'ivy')];
        },
      });
      w.provider.setScript('date.ask', (req) => {
        const venues = (req.meta?.venues ?? []) as { id: string; name: string }[];
        const ride = venues.find((v) => w.location(v.id)?.kind === 'ride') ?? venues[0]!;
        return JSON.stringify({
          text: `Ride the ${ride.name} with me?`,
          locationId: ride.id,
          start: '17:00',
        });
      });
      // The pair meets in the morning, so the 17:00 date is the same day (asked after 17:00 it would
      // be the next day's).
      await w.advanceTo('08:00');
      w.command({ type: 'player.pairTalk', aId: 'sam', bId: 'ivy' });
      const rideDates = () =>
        w
          .state()
          .events.filter(
            (e) => e.kind === 'date' && e.hostId === 'sam' && w.location(e.locationId)?.kind === 'ride',
          );
      expect(await w.until(() => rideDates().length > 0, 8 * 60)).toBe(true);
      const date = rideDates()[0]!;
      expect(date.start).toBe(at(0, '17:00'));
      // Before it starts nobody has attended and nothing is settled.
      await w.advanceTo(date.start - 5);
      expect(rideDates()[0]).toMatchObject({ status: 'scheduled', attendees: [] });
      expect(between(w, 'sam', 'ivy')!.dates.find((d) => d.eventId === date.id)?.status).toBe('planned');
      await w.advanceTo(date.end + 5);
      expect(rideDates().find((e) => e.id === date.id)!.status).toBe('done');
      const both = rideDates().filter((e) => e.attendees.includes('sam') && e.attendees.includes('ivy'));
      expect(
        both.length,
        JSON.stringify(rideDates().map((e) => [e.locationId, e.attendees])),
      ).toBeGreaterThan(0);
      const r = between(w, 'sam', 'ivy')!;
      expect(
        r.dates.filter((d) => both.some((e) => e.id === d.eventId)).every((d) => d.status === 'done'),
      ).toBe(true);
      w.dispose();
    }, 120_000);

    it('a 17:00 date asked in the evening is the next day: still scheduled, nobody attends yet', async () => {
      const w = await createTestWorld({
        villagers: 12,
        startAt: '18:00',
        affinities: mutualAffinity('sam', 'ivy', 7),
        patchSave: (s) => {
          s.romances = [...(s.romances ?? []), crush('sam', 'ivy')];
        },
      });
      w.provider.setScript('date.ask', (req) => {
        const venues = (req.meta?.venues ?? []) as { id: string; name: string }[];
        return JSON.stringify({ text: 'Tomorrow?', locationId: venues[0]!.id, start: '17:00' });
      });
      // Asked only after a chat, so none before the player brings them together.
      const dates = () => w.state().events.filter((e) => e.kind === 'date' && e.hostId === 'sam');
      await w.advance(1);
      const before = dates().length;
      w.command({ type: 'player.pairTalk', aId: 'sam', bId: 'ivy' });
      expect(await w.until(() => dates().length > before, 3 * 60)).toBe(true);
      const date = dates().at(-1)!;
      expect(date.start).toBe(at(1, '17:00'));
      await w.advanceTo(at(1, '06:00'));
      expect(dates().find((e) => e.id === date.id)).toMatchObject({ status: 'scheduled', attendees: [] });
      w.dispose();
    }, 120_000);
    it('a partner who never comes makes the date missed and costs the waiter 1 affinity', async () => {
      const start = 10 * 60;
      const w = await createTestWorld({
        villagers: 12,
        startAt: '06:00',
        affinities: mutualAffinity('sam', 'ivy', 7),
        patchSave: (s) => {
          // Ivy never accepted, so she has no plan block for it; Sam goes and waits.
          s.events.push({
            id: 'date-sam-ivy-control',
            title: 'Date at the park',
            description: 'A walk in the park?',
            hostId: 'sam',
            locationId: 'park',
            start,
            end: start + 90,
            invitees: ['ivy'],
            accepted: [],
            declined: [],
            attendees: [],
            status: 'scheduled',
            source: 'llm',
            kind: 'date',
          });
          s.romances = [
            ...(s.romances ?? []),
            {
              ...crush('sam', 'ivy'),
              stage: 'dating',
              dates: [
                {
                  eventId: 'date-sam-ivy-control',
                  locationId: 'park',
                  at: start,
                  askedBy: 'sam',
                  status: 'planned',
                  source: 'llm',
                },
              ],
            },
          ];
        },
      });
      // No new dates during the control.
      w.provider.setScript('date.decide', () => JSON.stringify({ accept: false, reply: 'Not today.' }));
      await w.advanceTo('13:00');
      const e = w.state().events.find((x) => x.id === 'date-sam-ivy-control')!;
      expect(e.attendees).toContain('sam');
      expect(e.attendees).not.toContain('ivy');
      const rec = between(w, 'sam', 'ivy')!.dates.find((d) => d.eventId === e.id)!;
      expect(rec.status).toBe('missed');
      expect(w.villager('sam').relationships.ivy!.affinity).toBe(6);
      expect(w.villager('ivy').relationships.sam!.affinity).toBe(7);
      expect(w.memories('sam').some((m) => /never came to our date/.test(m.text))).toBe(true);
      w.dispose();
    }, 120_000);
  },
);
