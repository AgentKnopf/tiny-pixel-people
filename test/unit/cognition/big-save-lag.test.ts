import { describe, expect, it } from 'vitest';
import { at } from '../../../src/shared/time.ts';
import type { GameMinutes, Memory, MemoryKind, VillageEvent } from '../../../src/shared/types.ts';
import type { Mind } from '../../../src/server/cognition/mind.ts';
import { isNewsworthy } from '../../../src/server/cognition/gossip.ts';
import { extractKeywords, keywordOverlap } from '../../../src/server/cognition/keywords.ts';
import { createTestVillage } from './helpers.ts';

// The incremental scans must give exactly what the full scans they replaced gave.

const HOT_NEWS_WINDOW = 12 * 60;
const HOT_NEWS_IMPORTANCE = 6;

function hotNewsFullScan(all: readonly Memory[], now: GameMinutes): Memory | undefined {
  return all
    .filter(
      (m) =>
        isNewsworthy(m) &&
        m.kind !== 'reflection' &&
        m.importance >= HOT_NEWS_IMPORTANCE &&
        now - m.createdAt <= HOT_NEWS_WINDOW &&
        m.createdAt <= now &&
        (m.meta.toldTo?.length ?? 0) < 2,
    )
    .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)[0];
}

function heardAboutFullScan(all: readonly Memory[], e: VillageEvent): boolean {
  const kw = extractKeywords(e.title);
  if (kw.length === 0) return false;
  return all.some(
    (m) => m.meta.eventId === e.id || (m.kind === 'heard' && keywordOverlap(kw, m.keywords) >= 0.6),
  );
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const KINDS: MemoryKind[] = ['observation', 'conversation', 'heard', 'note', 'event', 'reflection'];
const TOPICS = [
  'bake-off at the bakery',
  'harvest dance in the park',
  'quiz night at the cafe',
  'a lost cat',
];

function mind(): Mind {
  return createTestVillage({ start: at(0, '05:59') }).minds.get('mia')!;
}

function event(id: string, title: string): VillageEvent {
  return {
    id,
    title,
    description: '',
    hostId: 'ben',
    locationId: 'park',
    start: at(3, '18:00'),
    end: at(3, '20:00'),
    invitees: [],
    accepted: [],
    declined: [],
    attendees: [],
    status: 'proposed',
  };
}

describe('incremental memory scans', () => {
  it('hotNews matches a full scan as memories arrive out of order and get told', () => {
    for (const seed of [1, 2, 3]) {
      const r = rng(seed);
      const m = mind();
      let now = at(0, '06:00');
      for (let step = 0; step < 600; step++) {
        now += Math.floor(r() * 20);
        for (let k = Math.floor(r() * 3); k > 0; k--) {
          const mem = m.memory.add({
            // Some memories are backdated (or slightly in the future) relative to the clock.
            at: now - Math.floor(r() * 16 * 60) + (r() < 0.05 ? 30 : 0),
            kind: KINDS[Math.floor(r() * KINDS.length)]!,
            text: `${TOPICS[Math.floor(r() * TOPICS.length)]} ${step}`,
            importance: 1 + Math.floor(r() * 10),
          });
          if (r() < 0.05) mem.meta.archived = true;
        }
        const all = m.memory.all();
        if (all.length > 0 && r() < 0.3) {
          const told = all[Math.floor(r() * all.length)]!;
          told.meta.toldTo = [...(told.meta.toldTo ?? []), 'ben'];
        }
        expect(m.hotNews(now)).toBe(hotNewsFullScan(all, now));
      }
    }
  });

  it('hotNews matches a full scan when asked about an earlier time', () => {
    const m = mind();
    for (let i = 0; i < 200; i++)
      m.memory.add({ at: at(0, '06:00') + i * 10, kind: 'heard', text: `rumor ${i}`, importance: 7 });
    for (const now of [at(1, '12:00'), at(0, '20:00'), at(0, '09:00'), at(1, '00:00')])
      expect(m.hotNews(now)).toBe(hotNewsFullScan(m.memory.all(), now));
  });

  it('heardAbout matches a full scan as memories arrive and titles change', () => {
    for (const seed of [4, 5, 6]) {
      const r = rng(seed);
      const m = mind();
      const heard = (e: VillageEvent) =>
        (m as unknown as { heardAbout(e: VillageEvent): boolean }).heardAbout(e);
      const events = [
        event('e1', 'Bake-off at the bakery'),
        event('e2', 'Quiz night at the cafe'),
        event('e3', '!!'),
      ];
      for (let step = 0; step < 400; step++) {
        const roll = r();
        m.memory.add({
          at: at(0, '06:00') + step,
          kind: roll < 0.02 ? 'heard' : KINDS[Math.floor(r() * 2)]!,
          text: roll < 0.02 ? `Heard about the ${TOPICS[Math.floor(r() * TOPICS.length)]}` : `chat ${step}`,
          ...(roll > 0.995 ? { meta: { eventId: 'e2' } } : {}),
        });
        if (r() < 0.01) events[0]!.title = TOPICS[Math.floor(r() * TOPICS.length)]!;
        for (const e of events) expect(heard(e)).toBe(heardAboutFullScan(m.memory.all(), e));
      }
    }
  });

  it('since(from) keeps every memory created at or after from, in stream order', () => {
    const m = mind();
    const times = [100, 50, 300, 200, 400, 150, 500];
    for (const t of times) m.memory.add({ at: t, kind: 'observation', text: `at ${t}` });
    for (const from of [0, 120, 250, 250, 450, 90, 600]) {
      const got = m.memory.since(from);
      const want = m.memory.all().filter((x) => x.createdAt >= from);
      expect(got.filter((x) => x.createdAt >= from)).toEqual(want);
    }
  });
});

describe('Mind.recentMemories', () => {
  it('returns up to n memories, newest first, without archived ones', () => {
    const m = mind();
    const added = Array.from({ length: 10 }, (_, i) =>
      m.memory.add({ at: at(0, '07:00') + i, kind: 'observation', text: `thing ${i}` }),
    );
    added[8]!.meta.archived = true;
    added[5]!.meta.archived = true;
    const before = m.memory.all().filter((x) => !x.meta.archived).length;
    expect(m.recentMemories(4).map((x) => x.text)).toEqual(['thing 9', 'thing 7', 'thing 6', 'thing 4']);
    expect(m.recentMemories(1000)).toHaveLength(before);
    expect(m.recentMemories(0)).toEqual([]);
  });
});
