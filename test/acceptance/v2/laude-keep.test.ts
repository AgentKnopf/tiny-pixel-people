/** AC22: Laude knows every note, letter, notice and rumor at once; the Keep archives them (spec v2 §8.3–§8.4). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { KeepDataMsg, ServerMessage } from '../../../src/shared/protocol.ts';
import {
  PLAYER_ID,
  type GameMinutes,
  type KeepEntry,
  type KeepEntryKind,
  type Memory,
  type Rumor,
  type VillagerId,
} from '../../../src/shared/types.ts';
import { at } from '../../../src/shared/time.ts';
import { readyV2, waitingForV2, type Feature } from '../../helpers/features.ts';
import { loc, V2, walkPlayerTo } from '../../helpers/v2.ts';
import { awake, createTestWorld, type TestWorld } from '../../helpers/world.ts';

const F: Feature[] = [...V2.post, 'rumors'];
const LAUDE = 'laude';

const NOTE = 'The blue heron statue by the fountain wobbles whenever the wind blows.';
const LETTER = 'Please keep a jar of quince jam for me at the market on Friday.';
const NOTICE = 'Choir practice moves to the old mill this week. Bring a lantern!';
const RUMOR = 'Somebody hid a silver trumpet under the bandstand floorboards.';

const keepIdOf = (m: Memory) => m.meta.keepId;
const isError = (replies: readonly ServerMessage[]) => replies.some((m) => m.type === 'error');
const keepData = (replies: readonly ServerMessage[]) =>
  replies.find((m): m is KeepDataMsg => m.type === 'keep.data');
const keepEntries = (w: TestWorld): KeepEntry[] => w.of('keep.added').map((m) => m.entry);

interface LogCheck {
  kind: KeepEntryKind;
  refId: string;
  at: GameMinutes;
  entry: KeepEntry | undefined;
  memory: Memory | undefined;
}

/** What the log produced for `refId` since keep.added index `from`, read right after the action. */
function captureLog(w: TestWorld, kind: KeepEntryKind, refId: string, from: number): LogCheck {
  const entry = keepEntries(w)
    .slice(from)
    .find((e) => e.kind === kind && e.refId === refId);
  const memory = entry ? w.memories(LAUDE).find((m) => keepIdOf(m) === entry.id) : undefined;
  return { kind, refId, at: w.now(), entry, memory };
}

function expectLogged(c: LogCheck | undefined, memoryKind: 'note' | 'heard', importance: number) {
  expect(c, 'action ran').toBeDefined();
  expect(c!.entry, `${c!.kind} Keep entry`).toBeDefined();
  expect(c!.entry!.at).toBe(c!.at);
  expect(c!.memory, `Laude memory with meta.keepId for ${c!.kind}`).toBeDefined();
  expect(c!.memory!.createdAt).toBe(c!.at);
  expect(c!.memory!.kind).toBe(memoryKind);
  expect(c!.memory!.importance).toBe(importance);
}

describe.skipIf(!readyV2(...F))(`AC22: Laude and the Keep${waitingForV2(...F)}`, () => {
  describe('with Laude (12 villagers)', () => {
    let w: TestWorld;
    const checks = new Map<string, LogCheck>();
    const hopChecks: { hop: Rumor['hops'][number]; entry: boolean; memory: boolean }[] = [];
    const knownByProblems: string[] = [];
    let rumorId = '';
    let rumorAtStart: Rumor | undefined;
    let laudeLogAtStart: Memory | undefined;
    let archiveCheckAt: GameMinutes = 0;
    let outsideReplies: ServerMessage[] = [];
    let insideOk = false;
    let keepAll: KeepDataMsg | undefined;
    let keepLetters: KeepDataMsg | undefined;
    let keepSearch: KeepDataMsg | undefined;
    let keepPage: KeepDataMsg | undefined;
    let keepSideEffects = { keepSize: 0, laudeMemories: 0, keepSizeAfter: 0, laudeMemoriesAfter: 0 };
    let replyCallStart = 0;

    const rumor = () => w.state().rumors.find((r) => r.id === rumorId);

    beforeAll(async () => {
      w = await createTestWorld({ villagers: 12, startAt: '06:00', seed: 13 });
      await w.advanceTo('07:00');
      if (!w.state().villagers.some((v) => v.id === LAUDE)) throw new Error('laude is not in the world');
      const others = w.state().villagers.filter((v) => v.id !== LAUDE && v.id !== 'franzi');
      const owner = others[0]!.id;

      let from = keepEntries(w).length;
      w.command({ type: 'note.post', houseId: w.profile(owner).homeId, text: NOTE });
      const note = w.state().notes.find((n) => n.text === NOTE);
      if (note) checks.set('note', captureLog(w, 'note', note.id, from));

      const post = loc(w.engine.map, 'post_office');
      if (!(await walkPlayerTo(w, post.entry))) throw new Error('the player could not reach the post office');
      from = keepEntries(w).length;
      w.command({ type: 'letter.send', to: owner, text: LETTER });
      const letter = (w.state().letters ?? []).find((l) => l.text === LETTER);
      if (letter) checks.set('letter', captureLog(w, 'letter', letter.id, from));

      if (!(await walkPlayerTo(w, loc(w.engine.map, 'notice_board').entry)))
        throw new Error('the player could not reach the notice board');
      from = keepEntries(w).length;
      w.command({ type: 'notice.post', text: NOTICE });
      const notice = (w.state().notices ?? []).find((n) => n.text === NOTICE);
      if (notice) checks.set('notice', captureLog(w, 'notice', notice.id, from));

      const target = w.state().villagers.find((v) => awake(v) && v.id !== LAUDE && v.id !== 'franzi');
      if (!target) throw new Error('nobody is awake to hear the rumor');
      from = keepEntries(w).length;
      w.command({ type: 'player.rumor', villagerId: target.id, text: RUMOR });
      const started = w
        .state()
        .rumors.find((r) => r.startedBy === PLAYER_ID && r.text.includes('silver trumpet'));
      if (started) {
        rumorId = started.id;
        rumorAtStart = structuredClone(started);
        const c = captureLog(w, 'rumor', started.id, from);
        checks.set('rumor', c);
        laudeLogAtStart = c.memory;
      }

      let seenHops = rumor()?.hops.length ?? 0;
      let keepIndex = keepEntries(w).length;
      let stepStart = w.now();
      const pairTalkAt = [at(0, '11:00'), at(0, '14:00'), at(0, '17:00')];
      await w.until(
        (x) => {
          const r = rumor();
          if (!r) return false;
          const entries = keepEntries(x).slice(keepIndex);
          keepIndex += entries.length;
          for (const hop of r.hops.slice(seenHops)) {
            const entry = entries.find((e) => e.kind === 'rumor' && e.refId === r.id);
            const memory =
              !!entry &&
              x
                .memories(LAUDE)
                .some((m) => keepIdOf(m) === entry.id && m.createdAt >= stepStart && m.createdAt <= x.now());
            hopChecks.push({ hop, entry: !!entry, memory });
          }
          seenHops = r.hops.length;
          stepStart = x.now();
          const laudeInHops = r.hops.some((h) => h.to === LAUDE || h.from === LAUDE);
          if (r.knownBy.includes(LAUDE) && !laudeInHops)
            knownByProblems.push(`${x.now()}: laude in knownBy without a hop`);
          if (pairTalkAt[0] !== undefined && x.now() >= pairTalkAt[0]) {
            pairTalkAt.shift();
            if (!r.hops.some((h) => h.from === LAUDE)) {
              const b = x
                .state()
                .villagers.find(
                  (v) => awake(v) && v.id !== LAUDE && !r.knownBy.includes(v.id) && !v.conversationId,
                );
              if (b) x.command({ type: 'player.pairTalk', aId: LAUDE, bId: b.id });
            }
          }
          return false;
        },
        at(0, '22:00') - w.now(),
      );

      await w.advanceTo(at(1, '09:00'));
      archiveCheckAt = w.now();

      outsideReplies = w.command({ type: 'keep.open' });

      replyCallStart = w.provider.calls.length;
      w.command({
        type: 'player.say',
        villagerId: LAUDE,
        text: 'Laude, has anyone written to you about the heron statue?',
        mode: 'say',
      });
      await w.until((x) => x.provider.calls.slice(replyCallStart).some((c) => c.task === 'player.reply'), 90);
      await w.advance(5);

      if (!(await walkPlayerTo(w, post.entry))) throw new Error('the player could not reach the post office');
      w.command({ type: 'player.enter', locationId: 'post_office' });
      insideOk = w.state().player.inside?.locationId === 'post_office';
      keepSideEffects = {
        keepSize: w.state().keepSize ?? -1,
        laudeMemories: w.memories(LAUDE).length,
        keepSizeAfter: 0,
        laudeMemoriesAfter: 0,
      };
      keepAll = keepData(w.command({ type: 'keep.open', limit: 50 }));
      keepLetters = keepData(w.command({ type: 'keep.open', kind: 'letter' }));
      keepSearch = keepData(w.command({ type: 'keep.open', query: 'heron' }));
      keepPage = keepData(w.command({ type: 'keep.open', limit: 1, offset: 1 }));
      keepSideEffects.keepSizeAfter = w.state().keepSize ?? -1;
      keepSideEffects.laudeMemoriesAfter = w.memories(LAUDE).length;
    }, 600_000);

    afterAll(() => w?.dispose());

    it('logs a door note in the same step: a Keep entry and a Laude memory with meta.keepId', () => {
      expectLogged(checks.get('note'), 'note', 3);
    });

    it('logs a letter in the same step', () => {
      expectLogged(checks.get('letter'), 'note', 3);
    });

    it('logs a notice in the same step', () => {
      expectLogged(checks.get('notice'), 'note', 3);
    });

    it('logs a rumor start and every rumor hop in the same step', () => {
      expectLogged(checks.get('rumor'), 'heard', 5);
      expect(laudeLogAtStart!.meta.originId).toBe(rumorAtStart!.originMemoryId);
      expect(hopChecks.length, 'rumor hops').toBeGreaterThanOrEqual(1);
      for (const h of hopChecks) {
        expect(h.entry, `Keep entry for hop ${h.hop.from}->${h.hop.to}`).toBe(true);
        expect(h.memory, `Laude memory for hop ${h.hop.from}->${h.hop.to}`).toBe(true);
      }
    });

    it("leaves the rumor's knownBy and hops alone", () => {
      expect(rumorAtStart!.knownBy).not.toContain(LAUDE);
      expect(rumorAtStart!.hops).toEqual([]);
      expect(knownByProblems).toEqual([]);
      const convos = new Map(w.conversations().map((c) => [c.id, c]));
      for (const hop of rumor()!.hops) {
        expect(hop.conversationId, `hop ${hop.from}->${hop.to} has a conversation`).toBeDefined();
        expect(convos.get(hop.conversationId!)?.participants).toEqual(
          expect.arrayContaining([hop.from, hop.to]),
        );
      }
      const logIds = new Set(
        w
          .memories(LAUDE)
          .filter((m) => keepIdOf(m))
          .map((m) => m.id),
      );
      expect(w.state().rumors.filter((r) => logIds.has(r.originMemoryId))).toEqual([]);
    });

    it('when Laude later tells the rumor to B, it counts as a real hop', () => {
      const r = rumor()!;
      const hop = r.hops.find((h) => h.from === LAUDE);
      expect(hop, 'a hop from laude').toBeDefined();
      expect(r.knownBy).toContain(hop!.to);
      const heard = w.memories(hop!.to).find((m) => m.meta.originId === r.originMemoryId);
      expect(heard?.meta.heardFrom).toBe(LAUDE);
    });

    it('keep.open inside the post office returns entries newest first, with search and kind filters', () => {
      expect(insideOk).toBe(true);
      expect(keepAll, 'keep.data').toBeDefined();
      const all = keepAll!.entries;
      expect(keepAll!.total).toBeGreaterThanOrEqual(4);
      expect(all.length).toBeLessThanOrEqual(50);
      for (let i = 1; i < all.length; i++) expect(all[i - 1]!.at).toBeGreaterThanOrEqual(all[i]!.at);
      for (const k of ['note', 'letter', 'notice', 'rumor'] as const)
        expect(all.some((e) => e.kind === k) || keepAll!.total > all.length, k).toBe(true);
      expect(keepLetters!.entries.length).toBeGreaterThanOrEqual(1);
      expect(keepLetters!.entries.every((e) => e.kind === 'letter')).toBe(true);
      expect(keepLetters!.entries.some((e) => e.text.includes('quince'))).toBe(true);
      expect(keepSearch!.entries.length).toBeGreaterThanOrEqual(1);
      expect(keepSearch!.entries.every((e) => /heron/i.test(e.text))).toBe(true);
      expect(keepPage!.entries).toHaveLength(1);
      expect(keepPage!.offset).toBe(1);
      expect(keepPage!.entries[0]!.id).toBe(all[1]!.id);
      expect(keepSideEffects.keepSizeAfter).toBe(keepSideEffects.keepSize);
      expect(keepSideEffects.laudeMemoriesAfter).toBe(keepSideEffects.laudeMemories);
    });

    it('rejects keep.open outside the post office', () => {
      expect(isError(outsideReplies)).toBe(true);
      expect(keepData(outsideReplies)).toBeUndefined();
    });

    it("archives Laude's log memories after a day; his player.reply meta carries matching Keep entries", () => {
      const old = w.memories(LAUDE).filter((m) => keepIdOf(m) && m.createdAt <= archiveCheckAt - 1440);
      expect(old.length).toBeGreaterThanOrEqual(4);
      for (const m of old) expect(m.meta.archived, m.text).toBe(true);
      const call = w.provider.calls
        .slice(replyCallStart)
        .find((c) => c.task === 'player.reply' && (c.meta?.villagerId ?? LAUDE) === LAUDE);
      expect(call, 'player.reply call for laude').toBeDefined();
      const { text: _asked, ...rest } = call!.meta ?? {};
      expect(JSON.stringify(rest)).toContain('wobbles');
    });

    it('a whole day of logging adds no importance.rate calls', () => {
      const logTexts = new Set(
        w
          .memories(LAUDE)
          .filter((m) => keepIdOf(m))
          .map((m) => m.text),
      );
      expect(logTexts.size).toBeGreaterThanOrEqual(5);
      const rated = w.provider.calls
        .filter((c) => c.task === 'importance.rate')
        .flatMap((c) => (Array.isArray(c.meta?.memories) ? c.meta.memories : []))
        .map((m: unknown) => (typeof m === 'object' && m !== null && 'text' in m ? String(m.text) : ''));
      expect(rated.filter((t) => logTexts.has(t))).toEqual([]);
    });
  });

  describe('without Laude (sim.villagers: 10)', () => {
    let w: TestWorld;
    const kinds = new Set<KeepEntryKind>();
    let keepSize = 0;

    beforeAll(async () => {
      w = await createTestWorld({ villagers: 10, startAt: '07:00', seed: 13 });
      const owner: VillagerId = w.state().villagers[0]!.id;
      w.command({ type: 'note.post', houseId: w.profile(owner).homeId, text: NOTE });
      if (!(await walkPlayerTo(w, loc(w.engine.map, 'post_office').entry)))
        throw new Error('the player could not reach the post office');
      w.command({ type: 'letter.send', to: owner, text: LETTER });
      if (!(await walkPlayerTo(w, loc(w.engine.map, 'notice_board').entry)))
        throw new Error('the player could not reach the notice board');
      w.command({ type: 'notice.post', text: NOTICE });
      w.command({ type: 'player.rumor', villagerId: owner, text: RUMOR });
      await w.advance(5);
      for (const e of keepEntries(w)) kinds.add(e.kind);
      keepSize = w.state().keepSize ?? 0;
    }, 300_000);

    afterAll(() => w?.dispose());

    it('still logs every note, letter, notice and rumor in the Keep', () => {
      expect(w.state().villagers.some((v) => v.id === LAUDE)).toBe(false);
      expect(w.memories(LAUDE)).toEqual([]);
      for (const k of ['note', 'letter', 'notice', 'rumor'] as const) expect(kinds.has(k), k).toBe(true);
      expect(keepSize).toBeGreaterThanOrEqual(4);
    });
  });
});
