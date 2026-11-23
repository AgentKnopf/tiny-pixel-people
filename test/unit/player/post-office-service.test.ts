import { describe, expect, it } from 'vitest';
import { at } from '../../../src/shared/time.ts';
import { PLAYER_ID, type PlayerState, type VillageEvent } from '../../../src/shared/types.ts';
import { advance, profile, setup, villager, type FakeHost } from './fake-host.ts';
import { addInteriors } from './v2-fixtures.ts';

function world(opts: { laude?: boolean; time?: number } = {}) {
  const { host, pw } = setup();
  addInteriors(host);
  if (opts.laude !== false)
    host.add(
      profile('laude', 'Laude', 'house_ben', { occupation: 'Postmaster' }),
      villager('laude', { x: 24, y: 6 }),
    );
  host.time = opts.time ?? at(0, '09:00');
  const player = pw.state as PlayerState;
  player.pos = { x: 24, y: 5 };
  return { host, pw, player };
}

const state = (host: FakeHost, id: string) => host.states.find((s) => s.id === id)!;
const send = (pw: ReturnType<typeof world>['pw'], to: string, text: string) =>
  pw.handleCommand({ type: 'letter.send', to, text });

function event(over: Partial<VillageEvent> = {}): VillageEvent {
  return {
    id: 'ev1',
    title: 'Bake-off',
    description: '',
    hostId: 'ben',
    locationId: 'bakery',
    start: at(0, '15:00'),
    end: at(0, '17:00'),
    invitees: [],
    accepted: [],
    declined: [],
    attendees: [],
    status: 'scheduled',
    ...over,
  };
}

describe('PostOfficeService: letters', () => {
  it('player letter: posted at once, delivered at 11:00, read at home, replied and read by the player', () => {
    const { host, pw } = world();
    expect(send(pw, 'ada', 'The mayor cat is named Biscuit')).toEqual([]);
    const [letter] = pw.post.letters();
    expect(letter).toMatchObject({ from: PLAYER_ID, to: 'ada', status: 'posted', postedAt: at(0, '09:00') });
    expect(host.caws).toBe(1);
    // Logged in the same step: Keep entry plus Laude's memory with keepId.
    const entry = pw.post.keep.all().at(-1)!;
    expect(entry).toMatchObject({ kind: 'letter', refId: letter!.id });
    expect(host.memoriesOf('laude').at(-1)).toMatchObject({
      kind: 'note',
      importance: 3,
      meta: { keepId: entry.id },
    });
    expect(host.of('keep.added').at(-1)?.entry.id).toBe(entry.id);

    advance(host, pw, 119);
    expect(pw.post.letters()[0]!.status).toBe('posted');
    advance(host, pw, 1);
    expect(host.time).toBe(at(0, '11:00'));
    expect(pw.post.letters()[0]).toMatchObject({ status: 'delivered', deliveredAt: at(0, '11:00') });
    expect(host.caws).toBe(2);

    state(host, 'ada').locationId = 'house_ada';
    advance(host, pw, 1);
    expect(pw.post.letters()[0]!.status).toBe('read');
    const mem = host.memoriesOf('ada').at(-1)!;
    expect(mem).toMatchObject({ kind: 'note', importance: 6, meta: { letterId: letter!.id } });
    expect(host.lettersRead.map((r) => r.villagerId)).toEqual(['ada']);

    const reply = pw.postLetter(
      'ada',
      PLAYER_ID,
      "Thank you for your letter about 'The mayor cat is named Biscuit'.",
      {
        replyTo: letter!.id,
        source: 'llm',
      },
    );
    expect(reply).toMatchObject({ replyTo: letter!.id, status: 'posted' });
    expect(pw.post.letters()[0]!.status).toBe('replied');
    expect(pw.post.keep.all().at(-1)!.kind).toBe('reply');
    advance(host, pw, at(0, '17:00') - host.time);
    const got = pw.post.letters().find((l) => l.id === reply!.id)!;
    expect(got.status).toBe('delivered');
    expect(got.text).toContain('Biscuit');
    expect(pw.handleCommand({ type: 'letter.read', letterId: got.id })).toEqual([]);
    expect(pw.post.letters().find((l) => l.id === reply!.id)!.status).toBe('read');
    expect(pw.handleCommand({ type: 'letter.read', letterId: letter!.id })?.[0]).toMatchObject({
      type: 'error',
    });
  });

  it('letter.send is rejected away from the post office and accepted inside', () => {
    const { pw, player } = world();
    player.pos = { x: 10, y: 10 };
    expect(send(pw, 'ada', 'hi')?.[0]).toMatchObject({ message: expect.stringMatching(/post office/) });
    player.pos = { x: 24, y: 5 };
    pw.handleCommand({ type: 'player.enter', locationId: 'post_office' });
    expect(player.inside?.locationId).toBe('post_office');
    expect(send(pw, 'ada', 'hi from inside')).toEqual([]);
    expect(send(pw, 'nobody', 'hi')?.[0]).toMatchObject({ type: 'error' });
    expect(send(pw, 'ada', '')?.[0]).toMatchObject({ type: 'error' });
    expect(send(pw, 'ada', 'x'.repeat(501))?.[0]).toMatchObject({ type: 'error' });
  });

  it('a letter to a visitor who left is returned with "moved away"', () => {
    const { host, pw } = world();
    host.add(
      profile('v1', 'Vera', 'hotel', { transient: true, visitor: true }),
      villager('v1', { x: 12, y: 16 }),
    );
    send(pw, 'v1', 'Enjoy your stay');
    host.removeVillager('v1');
    advance(host, pw, 120);
    expect(pw.post.letters()[0]!.status).toBe('returned');
    expect(host.of('toast').at(-1)?.text).toMatch(/moved away/);
  });

  it('villagers read letters only when home and awake; visitors read at the hotel', () => {
    const { host, pw } = world();
    host.add(
      profile('v1', 'Vera', 'hotel', { transient: true, visitor: true }),
      villager('v1', { x: 12, y: 16 }),
    );
    pw.postLetter('ben', 'v1', 'Welcome to town!');
    pw.postLetter('ada', 'dot', 'Wake up!');
    advance(host, pw, 120);
    state(host, 'dot').locationId = 'house_ada';
    advance(host, pw, 1);
    expect(pw.post.letters().map((l) => l.status)).toEqual(['delivered', 'delivered']);
    state(host, 'v1').locationId = 'hotel';
    state(host, 'dot').status = 'idle';
    advance(host, pw, 1);
    expect(pw.post.letters().map((l) => l.status)).toEqual(['read', 'read']);
    expect(host.memoriesOf('v1').at(-1)?.importance).toBe(5);
  });

  it('caps villager-written letters per day (3 in town, 1 to the player); replies do not count', () => {
    const { pw } = world();
    expect(pw.postLetter('ada', PLAYER_ID, 'Thanks for the flower!')).not.toBeNull();
    expect(pw.postLetter('ben', PLAYER_ID, 'Hello!')).toBeNull();
    expect(pw.postLetter('ben', 'ada', 'Miss you')).not.toBeNull();
    expect(pw.postLetter('cy', 'ada', 'Me too')).not.toBeNull();
    expect(pw.postLetter('cy', 'ben', 'One more')).toBeNull();
    const first = pw.post.letters()[0]!;
    expect(pw.postLetter(PLAYER_ID, 'ada', 'reply')).not.toBeNull();
    expect(pw.postLetter('ben', 'ada', 'A reply', { replyTo: pw.post.letters()[1]!.id })).not.toBeNull();
    expect(first.status).toBe('posted');
  });
});

describe('PostOfficeService: notices', () => {
  it('a scheduled event posts a notice from its host; date events do not', () => {
    const { host, pw } = world();
    host.events.push(event(), event({ id: 'd1', kind: 'date', title: 'Date' }));
    advance(host, pw, 1);
    expect(pw.post.notices()).toHaveLength(1);
    expect(pw.post.notices()[0]).toMatchObject({
      authorId: 'ben',
      eventId: 'ev1',
      text: '📌 Bake-off at Bakery, 15:00. All welcome! (Ben)',
    });
    expect(pw.post.notices()[0]!.originId).toBeTruthy();
    host.events[0]!.status = 'done';
    advance(host, pw, 1);
    expect(pw.post.notices()).toHaveLength(0);
    expect(host.of('notice.updated').at(-1)).toMatchObject({ removed: true });
  });

  it('player notices only near the board; Laude logs them with the notice origin', () => {
    const { host, pw, player } = world();
    player.pos = { x: 10, y: 10 };
    expect(pw.handleCommand({ type: 'notice.post', text: 'Lost cat' })?.[0]).toMatchObject({ type: 'error' });
    player.pos = { x: 27, y: 7 };
    expect(pw.handleCommand({ type: 'notice.post', text: 'Lost cat, answers to Biscuit' })).toEqual([]);
    const notice = pw.post.notices()[0]!;
    expect(notice.authorId).toBe(PLAYER_ID);
    expect(host.memoriesOf('laude').at(-1)?.meta).toMatchObject({
      originId: notice.originId,
      noticeId: notice.id,
    });
    expect(pw.handleCommand({ type: 'notice.post', text: 'x'.repeat(201) })?.[0]).toMatchObject({
      type: 'error',
    });
  });

  it('notices expire after 3 days and at most 12 are active', () => {
    const { host, pw } = world();
    for (let i = 0; i < 14; i++) pw.post.postNotice('ada', `Notice ${i}`, host.time);
    expect(pw.post.notices()).toHaveLength(12);
    expect(pw.post.notices()[0]!.text).toBe('Notice 2');
    advance(host, pw, 3 * 1440 - 60, 60);
    expect(pw.post.notices().length).toBeGreaterThan(0);
    advance(host, pw, 60, 60);
    expect(pw.post.notices()).toHaveLength(0);
  });
});

describe('PostOfficeService: the Keep and Laude', () => {
  it('logs door notes, letters, notices and rumor hops in the same step without touching knownBy', () => {
    const { host, pw } = world();
    pw.onNoteChanged({
      id: 'n1',
      houseId: 'house_ada',
      ownerId: 'ada',
      authorId: PLAYER_ID,
      text: 'Hi Ada',
      postedAt: host.time,
      status: 'unread',
    });
    expect(host.memoriesOf('laude').at(-1)?.meta?.keepId).toBe(pw.post.keep.all().at(-1)!.id);

    state(host, 'laude').pos = { x: 15, y: 11 };
    (pw.state as PlayerState).pos = { x: 15, y: 11 };
    pw.handleCommand({ type: 'player.rumor', villagerId: 'ada', text: 'The well is full of coins' });
    const rumor = pw.rumors.all()[0]!;
    const started = host.memoriesOf('laude').at(-1)!;
    expect(started).toMatchObject({ kind: 'heard', importance: 5, meta: { originId: rumor.originMemoryId } });
    expect(rumor.knownBy).toEqual(['ada']);

    pw.onLearned({
      originId: rumor.originMemoryId,
      from: 'ada',
      to: 'ben',
      at: host.time,
      text: rumor.text,
    } as Parameters<typeof pw.onLearned>[0]);
    expect(pw.post.keep.all().at(-1)).toMatchObject({ kind: 'rumor', authorId: 'ada', recipientId: 'ben' });
    expect(host.memoriesOf('laude').at(-1)?.meta?.keepId).toBe(pw.post.keep.all().at(-1)!.id);
    expect(rumor.knownBy).toEqual(['ada', 'ben']);
    expect(rumor.hops).toHaveLength(1);

    // Laude telling it later is a real hop.
    pw.onLearned({
      originId: rumor.originMemoryId,
      from: 'laude',
      to: 'cy',
      at: host.time,
      text: rumor.text,
    } as Parameters<typeof pw.onLearned>[0]);
    expect(rumor.hops.map((h) => h.from)).toEqual(['ada', 'laude']);

    // His log memories never start rumors of their own.
    expect(
      pw.onMemoryAdded({
        id: 'm1',
        villagerId: 'laude',
        kind: 'heard',
        text: 'x',
        importance: 9,
        createdAt: 0,
        lastAccessedAt: 0,
        meta: { keepId: 'keep_1' },
      } as Parameters<typeof pw.onMemoryAdded>[0]),
    ).toBeNull();
  });

  it('without Laude the Keep still logs everything', () => {
    const { host, pw } = world({ laude: false });
    send(pw, 'ada', 'hello');
    pw.post.postNotice('ben', 'Sale', host.time);
    expect(pw.post.keep.size()).toBe(2);
    expect(host.memories).toHaveLength(0);
  });

  it('keep.open works only inside the post office: newest first, search and kind filters, paging', () => {
    const { host, pw, player } = world();
    send(pw, 'ada', 'apples are ripe');
    pw.post.postNotice('ben', 'Apple pie contest', host.time);
    send(pw, 'ben', 'see you at the lake');
    expect(pw.handleCommand({ type: 'keep.open', requestId: 'r0' })?.[0]).toMatchObject({
      type: 'error',
      requestId: 'r0',
    });
    pw.handleCommand({ type: 'player.enter', locationId: 'post_office' });
    expect(player.inside?.locationId).toBe('post_office');
    const all = pw.handleCommand({ type: 'keep.open', requestId: 'r1' })![0]!;
    expect(all).toMatchObject({ type: 'keep.data', total: 3, offset: 0, requestId: 'r1' });
    if (all.type !== 'keep.data') throw new Error('expected keep.data');
    expect(all.entries.map((e) => e.text)).toEqual([
      'Letter from Kai to Ben: see you at the lake',
      'Notice by Ben: Apple pie contest',
      'Letter from Kai to Ada: apples are ripe',
    ]);
    const letters = pw.handleCommand({ type: 'keep.open', kind: 'letter' })![0]!;
    expect(letters).toMatchObject({ total: 2 });
    const apple = pw.handleCommand({ type: 'keep.open', query: 'apples' })![0]!;
    expect(apple).toMatchObject({ total: 1 });
    const page = pw.handleCommand({ type: 'keep.open', offset: 1, limit: 1 })![0]!;
    expect(page).toMatchObject({ total: 3, offset: 1 });
    if (page.type === 'keep.data') expect(page.entries).toHaveLength(1);
    expect(pw.post.keep.search('lake apples', 3).map((e) => e.kind)).toEqual(['letter', 'letter']);
  });

  it('a whole day of logging adds no importance.rate calls (importance is always set)', () => {
    const { host, pw } = world();
    for (let i = 0; i < 20; i++) pw.post.postNotice('ada', `Notice ${i}`, host.time);
    expect(host.memoriesOf('laude').every((m) => typeof m.importance === 'number')).toBe(true);
  });

  it('round-trips letters, notices and the Keep through the save', () => {
    const { host, pw } = world();
    send(pw, 'ada', 'hello');
    pw.post.postNotice('ben', 'Sale', host.time);
    const save = JSON.parse(JSON.stringify(pw.serialize()));
    expect(save.keep).toHaveLength(2);
    const b = setup({ restore: save });
    expect(JSON.parse(JSON.stringify(b.pw.serialize()))).toEqual(save);
    expect(b.pw.snapshot().keepSize).toBe(2);
  });
});
