/** AC21: the notice board (spec v2 §8.2). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../../src/shared/protocol.ts';
import { PLAYER_ID, type GameMinutes, type Memory, type Notice } from '../../../src/shared/types.ts';
import { formatClock, minuteOfDay } from '../../../src/shared/time.ts';
import { readyV2, waitingForV2, type Feature } from '../../helpers/features.ts';
import { noticeProblems } from '../../helpers/invariants.ts';
import { dist, loc, V2, walkPlayerTo } from '../../helpers/v2.ts';
import { createTestWorld, stubMind, type TestWorld } from '../../helpers/world.ts';

const F: Feature[] = [...V2.post];

const PLAYER_NOTICE = 'Lost: a green umbrella with yellow ducks. Reward at the bakery!';
const FAR_NOTICE = 'This notice was pinned from far away.';
const READ_PREFIX = 'The notice board says';

const isError = (replies: readonly ServerMessage[]) => replies.some((m) => m.type === 'error');
const originOf = (n: Notice) => n.originId ?? n.id;
const readsOf = (mems: readonly Memory[], origin: string) =>
  mems.filter((m) => m.meta.originId === origin && m.text.includes(READ_PREFIX));

/** Latest version of every notice ever posted (snapshot plus notice.updated broadcasts). */
function allNotices(w: TestWorld): { notices: Notice[]; removed: Set<string> } {
  const byId = new Map<string, Notice>();
  const removed = new Set<string>();
  for (const m of w.of('notice.updated')) {
    byId.set(m.notice.id, m.notice);
    if (m.removed) removed.add(m.notice.id);
  }
  for (const n of w.state().notices ?? []) byId.set(n.id, n);
  return { notices: [...byId.values()], removed };
}

const activeNotices = (w: TestWorld) => (w.state().notices ?? []).filter((n) => n.expiresAt > w.now());

describe.skipIf(!readyV2(...F))(`AC21: notice board${waitingForV2(...F)}`, () => {
  describe('a default day', () => {
    let w: TestWorld;
    let farReplies: ServerMessage[] = [];
    let farDist = 0;
    let nearReplies: ServerMessage[] = [];
    let nearDist = 0;
    let playerNoticeId = '';
    const problems: string[] = [];

    const playerNotice = () => allNotices(w).notices.find((n) => n.id === playerNoticeId);

    beforeAll(async () => {
      w = await createTestWorld({ villagers: 12, startAt: '06:00', seed: 9 });
      const board = loc(w.engine.map, 'notice_board');
      if (dist(w.state().player.pos, board.entry) <= 4)
        await walkPlayerTo(w, loc(w.engine.map, 'square').entry);
      farDist = dist(w.state().player.pos, board.entry);
      farReplies = w.command({ type: 'notice.post', text: FAR_NOTICE });

      if (!(await walkPlayerTo(w, board.entry)))
        throw new Error('the player could not reach the notice board');
      nearDist = dist(w.state().player.pos, board.entry);
      nearReplies = w.command({ type: 'notice.post', text: PLAYER_NOTICE });
      const posted = allNotices(w).notices.find((n) => n.text === PLAYER_NOTICE);
      if (!posted) throw new Error('notice.post created no notice');
      playerNoticeId = posted.id;
      // Walk away so the player's presence does not keep villagers near the board.
      await walkPlayerTo(w, loc(w.engine.map, 'square').entry);

      await w.advanceTo('23:00', {
        onStep: ({ snapshot }) => problems.push(...noticeProblems(snapshot(), w.config.post.maxNotices)),
      });
    }, 600_000);

    afterAll(() => w?.dispose());

    it('a scheduled event posts a notice from its host automatically', () => {
      const events = w
        .state()
        .events.filter((e) => e.kind !== 'date' && e.status !== 'proposed' && e.status !== 'cancelled');
      expect(events.length, 'scheduled events today').toBeGreaterThanOrEqual(1);
      const { notices } = allNotices(w);
      for (const e of events) {
        const n = notices.find((x) => x.eventId === e.id);
        expect(n, `notice for ${e.title}`).toBeDefined();
        expect(n!.authorId).toBe(e.hostId);
        expect(n!.text).toContain(e.title);
        expect(n!.text).toContain(formatClock(minuteOfDay(e.start)));
        expect(n!.text).toMatch(/All welcome/);
        const place = w.location(e.locationId);
        expect(
          [place?.name, e.locationId].some((s) => !!s && n!.text.includes(s)),
          n!.text,
        ).toBe(true);
        expect(n!.postedAt).toBeLessThanOrEqual(e.start);
      }
    });

    it('posts a player notice near the board and rejects one from far away', () => {
      expect(nearDist).toBeLessThanOrEqual(3);
      expect(isError(nearReplies)).toBe(false);
      const n = playerNotice()!;
      expect(n).toBeDefined();
      expect(n.authorId).toBe(PLAYER_ID);
      expect(farDist).toBeGreaterThan(3);
      expect(isError(farReplies)).toBe(true);
      expect(allNotices(w).notices.some((x) => x.text === FAR_NOTICE)).toBe(false);
    });

    it("a villager passing the board gets a memory of each notice, with the notice's originId", () => {
      const pn = playerNotice()!;
      const { notices } = allNotices(w);
      const events = new Map(w.state().events.map((e) => [e.id, e]));
      const activeAt = (n: Notice, t: GameMinutes) => {
        const ev = n.eventId ? events.get(n.eventId) : undefined;
        return n.postedAt <= t && t < n.expiresAt && (!ev || t < ev.end);
      };
      const readers = w.state().villagers.filter((v) => readsOf(w.memories(v.id), originOf(pn)).length > 0);
      expect(readers.length, 'villagers who read the player notice').toBeGreaterThanOrEqual(1);
      for (const r of readers) {
        const mems = w.memories(r.id);
        const read = readsOf(mems, originOf(pn));
        expect(read, r.id).toHaveLength(1);
        expect(read[0]!.importance).toBe(5);
        expect(read[0]!.text).toContain(PLAYER_NOTICE);
        for (const n of notices.filter((x) => activeAt(x, read[0]!.createdAt)))
          expect(readsOf(mems, originOf(n)).length, `${r.id} read "${n.text}"`).toBe(1);
      }
    });

    it("by the end of the day, a villager who never passed the board knows the player's notice", () => {
      const origin = originOf(playerNotice()!);
      const knowers = w.state().villagers.filter((v) => {
        const mems = w.memories(v.id);
        return (
          readsOf(mems, origin).length === 0 &&
          mems.some((m) => m.kind === 'heard' && m.meta.originId === origin && !!m.meta.heardFrom)
        );
      });
      expect(knowers.length, 'villagers who heard about the notice').toBeGreaterThanOrEqual(1);
    });

    it('never has more than post.maxNotices active notices', () => {
      expect(problems).toEqual([]);
    });
  });

  describe('expiry and the cap', () => {
    let w: TestWorld;
    let postedAt: GameMinutes = 0;
    const ids: string[] = [];
    let activeAfterPosting: string[] = [];
    let activeBeforeExpiry: string[] = [];
    let activeAfterExpiry: string[] = [];
    let removedAfterPosting = new Set<string>();
    const problems: string[] = [];

    beforeAll(async () => {
      w = await createTestWorld({
        villagers: 10,
        startAt: '08:00',
        createMind: stubMind,
        config: { sim: { wakeUpTimeoutSec: 0 } },
      });
      if (!(await walkPlayerTo(w, loc(w.engine.map, 'notice_board').entry)))
        throw new Error('the player could not reach the notice board');
      const max = w.config.post.maxNotices;
      postedAt = w.now();
      for (let i = 1; i <= max + 2; i++) {
        w.command({ type: 'notice.post', text: `Village notice number ${i}` });
        const n = allNotices(w).notices.find((x) => x.text === `Village notice number ${i}`);
        if (n) ids.push(n.id);
      }
      activeAfterPosting = activeNotices(w).map((n) => n.id);
      removedAfterPosting = allNotices(w).removed;
      const ttl = w.config.post.noticeTtlDays * 1440;
      const onStep = ({ snapshot }: { snapshot: () => ReturnType<TestWorld['state']> }) =>
        problems.push(...noticeProblems(snapshot(), max));
      await w.advanceTo(postedAt + ttl - 10, { onStep });
      activeBeforeExpiry = activeNotices(w).map((n) => n.id);
      await w.advanceTo(postedAt + ttl + 10, { onStep });
      activeAfterExpiry = activeNotices(w).map((n) => n.id);
    }, 600_000);

    afterAll(() => w?.dispose());

    it(`keeps at most post.maxNotices active, removing the oldest first`, () => {
      const max = w.config.post.maxNotices;
      expect(ids).toHaveLength(max + 2);
      expect(activeAfterPosting.length).toBeLessThanOrEqual(max);
      expect(activeAfterPosting.sort()).toEqual(ids.slice(2).sort());
      for (const id of ids.slice(0, 2)) expect(removedAfterPosting.has(id), id).toBe(true);
      expect(problems).toEqual([]);
    });

    it('expires notices after post.noticeTtlDays days', () => {
      const ttl = w.config.post.noticeTtlDays * 1440;
      const { notices, removed } = allNotices(w);
      for (const id of ids.slice(2)) {
        const n = notices.find((x) => x.id === id)!;
        expect(n.expiresAt - n.postedAt).toBe(ttl);
        expect(activeBeforeExpiry, id).toContain(id);
        expect(activeAfterExpiry, id).not.toContain(id);
        expect(removed.has(id), `notice.updated removed for ${id}`).toBe(true);
      }
    });
  });
});
