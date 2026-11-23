/** Romance through the real engine (spec v2 §7): storage, seed, save round-trip and the full date flow. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Romance } from '../../../src/shared/types.ts';
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
const romances = (w: TestWorld): Romance[] => w.state().romances ?? [];
const between = (w: TestWorld, a: string, b: string) =>
  romances(w).find((r) => r.pair.includes(a) && r.pair.includes(b) && r.stage !== 'ended');

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
      await days(w, 1);
      const shyChats = () =>
        w
          .conversations()
          .filter((c) => c.participants.includes('laude') && c.participants.includes('franzi'));
      // Franzi's post office visit falls in Laude's time there.
      expect(shyChats().some((c) => c.locationId === 'post_office')).toBe(true);
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

    it('a pair at affinity 7 gets a crush within a few nights; a 16-year-old never does', async () => {
      const w = await createTestWorld({
        villagers: 12,
        startAt: '06:00',
        affinities: [...mutualAffinity('sam', 'ivy', 7), ...mutualAffinity('leo', 'nora', 9)],
      });
      let crushDay = -1;
      await days(w, 5, (d) => {
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
      await days(w, 3);
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
      expect(done.length).toBeGreaterThanOrEqual(2);
      expect(w.memories('sam').some((m) => m.text.startsWith('I had a lovely date with Ivy'))).toBe(true);

      const seen = /^I saw (Sam|Ivy) \S+ and (Sam|Ivy) \S+ on a date/;
      const witnesses = w.engine.profiles
        .map((p) => p.id)
        .filter((id) => !['sam', 'ivy'].includes(id) && w.memories(id).some((m) => seen.test(m.text)));
      expect(witnesses.length).toBeGreaterThan(0);
      const heard = w.engine.profiles
        .map((p) => p.id)
        .filter(
          (id) =>
            !['sam', 'ivy', ...witnesses].includes(id) &&
            w.memories(id).some((m) => m.kind === 'heard' && /on a date/.test(m.text)),
        );
      expect(heard.length).toBeGreaterThan(0);

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
  },
);
