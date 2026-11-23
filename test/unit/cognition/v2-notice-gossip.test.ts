/** Notice gossip (spec v2 §8.2, AC21): a notice read at the board spreads through conversations. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLAYER_ID, type Memory, type Point } from '../../../src/shared/types.ts';
import { NEWS_FAIR_SHARE, isNewsworthy, selectNews } from '../../../src/server/cognition/gossip.ts';
import { ready, SIM_FEATURES, waitingFor } from '../../helpers/features.ts';
import { createTestWorld, type TestWorld } from '../../helpers/world.ts';

let seq = 0;
function mem(
  kind: Memory['kind'],
  text: string,
  at: number,
  importance: number,
  meta: Memory['meta'] = {},
): Memory {
  return {
    id: `m${++seq}`,
    villagerId: 'ben',
    kind,
    text,
    createdAt: at,
    lastAccessedAt: at,
    importance,
    keywords: [],
    meta,
  };
}

describe('news selection', () => {
  const notice = () =>
    mem('observation', 'The notice board says: Lost: a green umbrella.', 420, 5, {
      noticeId: 'n1',
      originId: 'n1',
    });

  it('a notice read at the board is news even at importance 5', () => {
    expect(isNewsworthy(notice())).toBe(true);
    expect(isNewsworthy(mem('observation', 'Mia is walking by.', 420, 5))).toBe(false);
  });

  it('an earlier fact keeps its place until told to a few villagers; musings never jump the queue', () => {
    const n = notice();
    const fresh = [
      mem('heard', 'Mia told me: the bakery has rye bread.', 990, 6, { heardFrom: 'mia', originId: 'o2' }),
      mem('event', 'I attended the bake-off.', 1020, 6),
      mem('reflection', 'I keep thinking about the bake-off.', 1030, 8),
    ];
    expect(selectNews([n, ...fresh], 'ben', 1040, 1)[0]).toBe(n);

    n.meta.toldTo = ['leo'];
    expect(selectNews([n, ...fresh], 'ben', 1040, 1)[0]).toBe(n);
    // Already told to Ben: never offered to him again.
    expect(selectNews([n, ...fresh], 'leo', 1040, 3)).not.toContain(n);

    n.meta.toldTo = Array.from({ length: NEWS_FAIR_SHARE }, (_, i) => `v${i}`);
    const after = selectNews([n, ...fresh], 'ben', 1040, 4);
    expect(after[0]!.meta.originId).toBe('o2');
    // Past its fair share it competes on importance and freshness, but is still offered.
    expect(after).toContain(n);
    expect(after.indexOf(n)).toBeGreaterThan(after.findIndex((m) => m.kind === 'event'));
  });

  it('queues a fact by when it was first known, not by its freshest copy', () => {
    // Laude logged the notice in the Keep at 06:36 and read it on the board himself at 10:33.
    const keep = mem('note', '📒 Notice by You: Lost: a green umbrella.', 396, 4, {
      originId: 'n1',
      keepId: 'k1',
    });
    const read = mem('observation', 'The notice board says: Lost: a green umbrella.', 633, 5, {
      noticeId: 'n1',
      originId: 'n1',
    });
    const invite = mem('event', 'Mia invited me to the bake-off.', 500, 6);
    const picked = selectNews([keep, read, invite], 'nora', 739, 3);
    expect(picked[0]).toBe(read);
    expect(picked[1]).toBe(invite);
  });
  it('copies of one fact count tellings together', () => {
    const n = notice();
    const copy = mem('heard', 'Franzi told me: Lost: a green umbrella.', 500, 5, {
      originId: 'n1',
      heardFrom: 'franzi',
      toldTo: ['a', 'b'],
    });
    const other = mem('heard', 'Mia told me: rye bread.', 990, 6, { heardFrom: 'mia', originId: 'o2' });
    expect(selectNews([n, copy, other], 'ben', 1040, 1)[0]).toBe(other);
  });
});

const STORES_NOTICES = (() => {
  try {
    return readFileSync(new URL('../../../src/server/sim/engine.ts', import.meta.url), 'utf8').includes(
      'noticesInReach',
    );
  } catch {
    return false;
  }
})();

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
async function walk(w: TestWorld, to: Point): Promise<boolean> {
  w.command({ type: 'player.move', to });
  return w.until((x) => dist(x.state().player.pos, to) < 0.6 && x.state().player.path.length === 0, 180);
}
const TEXT = 'Lost: a green umbrella with yellow ducks. Reward at the bakery!';

describe.skipIf(!ready(...SIM_FEATURES) || !STORES_NOTICES)(
  `notice gossip in the engine${waitingFor(...SIM_FEATURES)}${STORES_NOTICES ? '' : ' (waiting for engine notices)'}`,
  () => {
    it("a player notice reaches villagers who never read it, and only through someone's conversation", async () => {
      const w = await createTestWorld({ villagers: 12, startAt: '06:00', seed: 9 });
      expect(await walk(w, w.location('notice_board')!.entry)).toBe(true);
      w.command({ type: 'notice.post', text: TEXT });
      const notice = (w.state().notices ?? []).find((n) => n.text === TEXT && n.authorId === PLAYER_ID)!;
      expect(notice).toBeDefined();
      const origin = notice.originId ?? notice.id;
      await walk(w, w.location('square')!.entry);
      await w.advanceTo('23:00');

      const ids = w.state().villagers.map((v) => v.id);
      // Direct knowledge: read at the board, or the board keeper's own note of it.
      const readAt = new Map<string, number>();
      for (const id of ids) {
        const r = w.memories(id).find((m) => m.meta.originId === origin && m.meta.noticeId === notice.id);
        if (r) readAt.set(id, r.createdAt);
      }
      expect(readAt.size).toBeGreaterThan(0);

      // Every villager who knows the notice without reading it heard it from someone, in a
      // conversation they both took part in, after that person knew it.
      const knewAt = new Map(readAt);
      const heard = ids.flatMap((id) =>
        w
          .memories(id)
          .filter((m) => m.kind === 'heard' && m.meta.originId === origin)
          .map((m) => ({ id, m })),
      );
      for (const { id, m } of heard)
        if (!knewAt.has(id) || m.createdAt < knewAt.get(id)!) knewAt.set(id, m.createdAt);
      const nonReaders = heard.filter(({ id }) => !readAt.has(id));
      expect(nonReaders.length, 'villagers who heard the notice without reading it').toBeGreaterThanOrEqual(
        3,
      );
      for (const { id, m } of heard) {
        const from = m.meta.heardFrom!;
        expect(from, id).toBeTruthy();
        expect(knewAt.get(from)!, `${from} knew it before telling ${id}`).toBeLessThanOrEqual(m.createdAt);
        const said = w
          .conversations()
          .some(
            (c) =>
              c.participants.includes(id) &&
              c.participants.includes(from) &&
              c.messages.some((x) => x.speakerId === from && /umbrella/i.test(x.text)),
          );
        expect(said, `${from} told ${id} in a conversation`).toBe(true);
      }

      // The notice does not crowd out other news told the same day.
      const otherNews = ids.flatMap((id) =>
        w.memories(id).filter((m) => m.kind === 'heard' && m.meta.originId !== origin && m.createdAt > 420),
      );
      expect(otherNews.length, 'other news heard after the notice was read').toBeGreaterThan(0);

      // Control: nobody knows it any other way.
      for (const id of ids) {
        const knows = w.memories(id).some((m) => m.meta.originId === origin);
        if (knows) expect(knewAt.has(id), id).toBe(true);
      }
      expect(w.errors()).toEqual([]);
      w.dispose();
    }, 180_000);
  },
);
