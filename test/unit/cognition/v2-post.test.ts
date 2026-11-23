import { describe, expect, it } from 'vitest';
import { at } from '../../../src/shared/time.ts';
import { DEFAULT_CONFIG } from '../../../src/server/config.ts';
import type {
  Conversation,
  HouseVisit,
  KeepEntry,
  Letter,
  Romance,
  VillagerProfile,
} from '../../../src/shared/types.ts';
import { MockChatProvider, MockEmbeddingProvider } from '../../../src/server/llm/providers/mock.ts';
import { LAG_OVERLOADED, loadTracker } from '../../../src/server/cognition/llm.ts';
import { createConversationRunner } from '../../../src/server/cognition/conversation.ts';
import { KEEP_THOUGHT } from '../../../src/server/cognition/post.ts';
import { createTestVillage, PROFILES, testConfig, V2_LOCATIONS } from './helpers.ts';

function person(id: string, name: string, occupation: string): VillagerProfile {
  return {
    id,
    name,
    age: 40,
    occupation,
    bio: `${name} lives on the post row.`,
    traits: ['shy'],
    homeId: `house_${id}`,
    sprite: `characters/${id}.png`,
    wakeTime: '06:00',
    sleepTime: '23:00',
  };
}
const LAUDE = person('laude', 'Laude', 'Postmaster');
const FRANZI = person('franzi', 'Franzi', 'Illustrator (draws postcards)');
const SHY: Romance = {
  id: 'r-shy',
  pair: ['laude', 'franzi'],
  stage: 'crush',
  crushFrom: ['laude', 'franzi'],
  shy: true,
  since: 0,
  dates: [],
  updatedAt: 0,
};

const visit = (houseId: string, t: number): HouseVisit => ({
  id: 'v1',
  houseId,
  ownerIds: ['mia'],
  at: t,
  kind: 'visit',
  witnesses: [],
});

const letter = (from: string, to: string, text: string, t: number): Letter => ({
  id: `L-${from}-${to}`,
  from,
  to,
  text,
  postedAt: t,
  deliveredAt: t,
  readAt: t,
  status: 'read',
});

const KEEP: KeepEntry[] = [1, 2, 3, 4, 5].map((n) => ({
  id: `k${n}`,
  kind: 'letter',
  at: n,
  refId: `L${n}`,
  authorId: 'player',
  recipientId: 'mia',
  text: `Letter ${n} to Mia about the rye bread`,
}));

describe('house visit greetings (v2)', () => {
  it('asks visit.greet at player-facing priority and returns the model greeting', async () => {
    const v = createTestVillage({ start: at(0, '10:00') });
    await v.advanceTo(at(0, '10:01'));
    const res = await v.minds.get('mia')!.greetVisitor(v.view('mia'), visit('house_mia', v.time.now));
    expect(res.source).toBe('llm');
    expect(res.reply).toContain('make yourself at home');
    const req = v.queue.requests.find((r) => r.task === 'visit.greet')!;
    expect(v.queue.priorities.get(req)).toBe(105);
    expect(req.meta).toMatchObject({
      villagerId: 'mia',
      houseId: 'house_mia',
      playerName: expect.any(String),
    });
  });

  it('falls back to the template greeting with the owner name', async () => {
    const p = new MockChatProvider();
    p.failNext('visit.greet', 5);
    const v = createTestVillage({ start: at(0, '15:00'), provider: p });
    await v.advanceTo(at(0, '15:01'));
    const res = await v.minds.get('mia')!.greetVisitor(v.view('mia'), visit('house_mia', v.time.now));
    expect(res.source).toBe('fallback');
    expect(res.reply).toContain('Oh, hello! Come on in, make yourself at home.');
    expect(res.reply).toContain('Mia');
    expect(res.reply).toContain('afternoon');
  });
});

describe('letter replies (v2)', () => {
  it('answers a player letter once, through sendLetter, without writing a read memory', async () => {
    const v = createTestVillage({ start: at(0, '12:00') });
    await v.advanceTo(at(0, '12:01'));
    const mia = v.minds.get('mia')!;
    const l = letter('player', 'mia', 'Do you sell rye bread on Sundays?', v.time.now);
    const before = mia.memory.all().length;
    mia.onLetterRead(v.view('mia'), l);
    mia.onLetterRead(v.view('mia'), l);
    await v.queue.drain();
    expect(v.queue.count('letter.reply')).toBe(1);
    expect(v.letters).toHaveLength(1);
    expect(v.letters[0]).toMatchObject({ from: 'mia', to: 'player', replyTo: l.id, source: 'llm' });
    expect(v.letters[0]!.text.toLowerCase()).toMatch(/rye|bread|sundays/);
    const added = mia.memory.all().slice(before);
    expect(added.some((m) => m.text.startsWith('I got a letter'))).toBe(false);
    expect(added.find((m) => m.text.startsWith('I wrote back'))?.meta.letterId).toBe(l.id);
  });

  it('quotes the first 6 words when the model fails, and ignores letters from villagers', async () => {
    const p = new MockChatProvider();
    p.failNext('letter.reply', 5);
    const v = createTestVillage({ start: at(0, '12:00'), provider: p });
    await v.advanceTo(at(0, '12:01'));
    const mia = v.minds.get('mia')!;
    mia.onLetterRead(v.view('mia'), letter('ben', 'mia', 'See you at the market', v.time.now));
    mia.onLetterRead(
      v.view('mia'),
      letter('player', 'mia', 'Could you bake a lemon cake for Friday please?', v.time.now),
    );
    await v.queue.drain();
    expect(v.letters).toHaveLength(1);
    expect(v.letters[0]!.source).toBe('fallback');
    expect(v.letters[0]!.text).toContain('"Could you bake a lemon cake…"');
  });
});

describe("Laude's Keep (v2)", () => {
  it('weights log memories 0.25x, rates none, batches their embeddings and forgets them after a day', async () => {
    const v = createTestVillage({
      start: at(0, '09:00'),
      profiles: [LAUDE, PROFILES[0]!],
      locations: V2_LOCATIONS,
      embeddings: new MockEmbeddingProvider(),
    });
    await v.advanceTo(at(0, '09:01'));
    const laude = v.minds.get('laude')!;
    const w0 = laude.serialize().bookkeeping.importanceSinceReflection;
    for (let i = 0; i < 4; i++)
      laude.observe({
        at: v.time.now,
        kind: 'note',
        text: `Mia pinned note ${i} on Ben's door about the harvest`,
        importance: 3,
        meta: { keepId: `k${i}` },
      });
    expect(laude.serialize().bookkeeping.importanceSinceReflection - w0).toBeCloseTo(4 * 3 * 0.25);
    const logs = laude.memory.all().filter((m) => m.meta.keepId);
    expect(logs).toHaveLength(4);
    await v.queue.drain();
    expect(logs.every((m) => !m.embedding)).toBe(true);
    await v.advanceTo(at(0, '09:12'));
    expect(logs.every((m) => !!m.embedding)).toBe(true);
    await v.advanceTo(at(0, '18:00'), 30);
    expect(logs.some((m) => m.meta.archived)).toBe(false);
    await v.advanceTo(at(1, '10:30'), 30);
    expect(logs.every((m) => m.meta.archived)).toBe(true);
    expect(
      v.queue.requests
        .filter((r) => r.task === 'importance.rate')
        .some((r) => JSON.stringify(r.messages).includes('pinned note')),
    ).toBe(false);
  }, 30_000);

  it('writes in the Keep for 5 minutes at the post office when an entry arrives', async () => {
    const v = createTestVillage({ start: at(0, '10:00'), profiles: [LAUDE], locations: V2_LOCATIONS });
    await v.advanceTo(at(0, '10:01'));
    const laude = v.minds.get('laude')!;
    const s = v.states.get('laude')!;
    s.locationId = 'post_office';
    laude.update(v.view('laude'));
    laude.observe({
      at: v.time.now,
      kind: 'note',
      text: 'A letter for Mia was posted',
      importance: 3,
      meta: { keepId: 'k1' },
    });
    v.time.now += 1;
    expect(laude.update(v.view('laude'))).toEqual({
      type: 'act',
      activity: 'writing in the Keep',
      emoji: '📒',
    });
    v.time.now += 5;
    expect(laude.update(v.view('laude'))).not.toMatchObject({ activity: 'writing in the Keep' });
  });

  it('adds up to 3 Keep entries to Laude’s player reply and conversation turns, not to others', async () => {
    const searched: string[] = [];
    const v = createTestVillage({
      start: at(0, '10:00'),
      profiles: [LAUDE, PROFILES[0]!],
      locations: V2_LOCATIONS,
      extraView: (id) => ({
        searchKeep: (q: string, k: number) => {
          searched.push(id);
          return KEEP.slice(0, k + 2);
        },
      }),
    });
    await v.advanceTo(at(0, '10:01'));
    const laude = v.minds.get('laude')!;
    const thoughts: string[] = [];
    const world = v.worlds.get('laude')!;
    const set = world.setThought.bind(world);
    world.setThought = (t) => {
      thoughts.push(t);
      set(t);
    };
    await laude.replyToPlayer(v.view('laude'), {
      text: 'Did Mia get my letter about rye bread?',
      mode: 'say',
    });
    const req = v.queue.requests.find((r) => r.task === 'player.reply' && r.meta?.villagerId === 'laude')!;
    expect((req.meta!.keep as unknown[]).length).toBe(3);
    expect(JSON.stringify(req.messages)).toContain('You check the Keep');
    expect(thoughts).toContain(KEEP_THOUGHT);

    await v.minds.get('mia')!.replyToPlayer(v.view('mia'), { text: 'Hello!', mode: 'say' });
    const miaReq = v.queue.requests.find((r) => r.task === 'player.reply' && r.meta?.villagerId === 'mia')!;
    expect(miaReq.meta!.keep).toBeUndefined();
    expect(searched.every((id) => id === 'laude')).toBe(true);

    const conv: Conversation = {
      id: 'c1',
      participants: ['laude', 'mia'],
      locationId: 'post_office',
      startedAt: v.time.now,
      messages: [],
      status: 'active',
    };
    await createConversationRunner({
      config: testConfig(),
      queue: v.queue,
      now: () => v.time.now,
      emit: () => {},
    }).run(conv, [laude, v.minds.get('mia')!]);
    const turns = v.queue.requests.filter((r) => r.task === 'convo.turn');
    expect(turns.some((r) => r.meta?.villagerId === 'laude' && (r.meta.keep as unknown[]).length === 3)).toBe(
      true,
    );
    expect(turns.filter((r) => r.meta?.villagerId === 'mia').every((r) => r.meta?.keep === undefined)).toBe(
      true,
    );
  });
});

describe('villager-written letters (v2)', () => {
  it('writes at 21:00 within the town caps: at most one to the player, thanks before missing a friend', async () => {
    const config = { ...testConfig(), post: { ...DEFAULT_CONFIG.post, maxVillagerLettersPerDay: 2 } };
    const v = createTestVillage({ start: at(0, '05:00'), config });
    await v.advanceTo(at(0, '08:00'), 30);
    // Cleo misses Ben and Dan misses Mia (no talk for 2 days); Mia and Ben get gifts on day 3.
    v.worlds.get('cleo')!.relationships.ben = { affinity: 7 };
    v.worlds.get('dan')!.relationships.mia = { affinity: 6 };
    v.minds.get('cleo')!.noteTalk('ben', v.time.now);
    v.minds.get('dan')!.noteTalk('mia', v.time.now);
    await v.advanceTo(at(2, '12:00'), 30);
    expect(v.queue.count('letter.write')).toBe(0);
    for (const id of ['mia', 'ben'])
      await v.minds
        .get(id)!
        .replyToPlayer(v.view(id), { text: 'flower', mode: 'gift', itemId: 'flower', liked: true });
    await v.advanceTo(at(2, '21:30'), 10);
    const writes = v.queue.requests.filter((r) => r.task === 'letter.write');
    expect(writes.map((r) => [r.meta?.villagerId, r.meta?.reason])).toEqual([
      ['mia', 'thanks'],
      ['cleo', 'missYou'],
    ]);
    expect(v.letters.map((l) => [l.from, l.to])).toEqual([
      ['mia', 'player'],
      ['cleo', 'ben'],
    ]);
    expect(v.letters.every((l) => l.source === 'llm')).toBe(true);
    expect(
      v.minds
        .get('cleo')!
        .memory.all()
        .some((m) => m.meta.letterId && m.text.startsWith('I wrote a letter')),
    ).toBe(true);
  }, 30_000);

  it('sends one shy note per shy pair every few days', async () => {
    const v = createTestVillage({
      start: at(0, '05:00'),
      profiles: [LAUDE, FRANZI],
      locations: V2_LOCATIONS,
      extraView: () => ({ romances: [SHY] }),
    });
    await v.advanceTo(at(3, '22:00'), 30);
    const shy = v.queue.requests.filter((r) => r.task === 'letter.write');
    expect(shy.every((r) => r.meta?.reason === 'shy')).toBe(true);
    // Day 1 and day 4 (every 3 days), never both of them on one evening.
    expect(shy).toHaveLength(2);
    expect(v.letters.map((l) => [l.from, l.to, Math.floor(l.postedAt / 1440)])).toEqual([
      ['laude', 'franzi', 0],
      ['laude', 'franzi', 3],
    ]);
  }, 30_000);

  it('skips letters when overloaded and never sends a fallback letter', async () => {
    const p = new MockChatProvider();
    const v = createTestVillage({ start: at(0, '20:00'), provider: p });
    await v.advanceTo(at(0, '20:01'));
    await v.minds
      .get('mia')!
      .replyToPlayer(v.view('mia'), { text: 'flower', mode: 'gift', itemId: 'flower' });
    loadTracker(v.queue).seed(LAG_OVERLOADED * 20, v.time.now);
    await v.advanceTo(at(0, '21:10'));
    expect(v.queue.count('letter.write')).toBe(0);

    const v2 = createTestVillage({ start: at(0, '20:00'), provider: new MockChatProvider() });
    v2.provider.failNext('letter.write', 5);
    await v2.advanceTo(at(0, '20:01'));
    await v2.minds
      .get('ben')!
      .replyToPlayer(v2.view('ben'), { text: 'flower', mode: 'gift', itemId: 'flower' });
    await v2.advanceTo(at(0, '21:10'));
    expect(v2.queue.count('letter.write')).toBeGreaterThan(0);
    expect(v2.letters).toHaveLength(0);
  });
});
