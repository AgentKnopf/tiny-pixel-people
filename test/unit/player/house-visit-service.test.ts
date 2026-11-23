import { describe, expect, it } from 'vitest';
import { GREETING_TEMPLATE } from '../../../src/server/player/house-visits.ts';
import { at } from '../../../src/shared/time.ts';
import { PLAYER_ID, type HouseVisit, type PlayerState, type Provenance } from '../../../src/shared/types.ts';
import { advance, setup, type FakeHost } from './fake-host.ts';
import { addInteriors } from './v2-fixtures.ts';

function world() {
  const { host, pw } = setup();
  addInteriors(host);
  host.time = at(0, '12:00');
  const player = pw.state as PlayerState;
  player.pos = { x: 4, y: 5 };
  return { host, pw, player };
}

const state = (host: FakeHost, id: string) => host.states.find((s) => s.id === id)!;
const affinity = (host: FakeHost, id: string) => state(host, id).relationships[PLAYER_ID]?.affinity ?? 0;
const enter = (pw: ReturnType<typeof world>['pw'], locationId: string) =>
  pw.handleCommand({ type: 'player.enter', locationId });

describe('HouseVisitService', () => {
  it('owner home and awake: inside is set, the owner greets, remembers and likes it once a day', async () => {
    const { host, pw, player } = world();
    state(host, 'ada').locationId = 'house_ada';
    const asked: [string, HouseVisit][] = [];
    host.requestGreeting = (id, visit) => {
      asked.push([id, visit]);
      return Promise.resolve({ reply: 'Kai! What a nice surprise.', source: 'llm' as Provenance });
    };
    expect(enter(pw, 'house_ada')).toEqual([]);
    expect(player.inside).toEqual({ locationId: 'house_ada', pos: { x: 3, y: 2 } });
    expect(host.of('player.updated').at(-1)?.player.inside?.locationId).toBe('house_ada');
    expect(asked.map(([id]) => id)).toEqual(['ada']);
    await Promise.resolve();
    await Promise.resolve();
    const bubble = host.of('conversation.message').at(-1)!;
    expect(bubble).toMatchObject({
      speakerId: 'ada',
      listenerId: PLAYER_ID,
      text: 'Kai! What a nice surprise.',
    });
    const visit = host.of('visit.updated').at(-1)!.visit;
    expect(visit).toMatchObject({
      kind: 'visit',
      greetedBy: 'ada',
      greetingSource: 'llm',
      houseId: 'house_ada',
    });
    expect(host.memoriesOf('ada').map((m) => [m.text, m.importance])).toEqual([
      ['Kai came to visit me at home', 5],
    ]);
    expect(affinity(host, 'ada')).toBe(1);

    expect(pw.handleCommand({ type: 'player.exit' })).toEqual([]);
    expect(player.inside).toBeNull();
    expect(player.pos).toEqual({ x: 4, y: 4 });
    expect(enter(pw, 'house_ada')).toEqual([]);
    expect(host.memoriesOf('ada')).toHaveLength(1);
    expect(affinity(host, 'ada')).toBe(1);
    expect(asked).toHaveLength(1);
    expect(pw.houseVisits.visits()).toHaveLength(2);
  });

  it('greeting falls back to the template after 60 game minutes when the model never answers', () => {
    const { host, pw } = world();
    state(host, 'ada').locationId = 'house_ada';
    host.requestGreeting = () => new Promise(() => {});
    enter(pw, 'house_ada');
    advance(host, pw, 59);
    expect(pw.houseVisits.visits()[0]!.greeting).toBeUndefined();
    advance(host, pw, 1);
    expect(pw.houseVisits.visits()[0]).toMatchObject({
      greeting: GREETING_TEMPLATE,
      greetingSource: 'fallback',
    });
    expect(host.of('conversation.message').at(-1)?.text).toBe(GREETING_TEMPLATE);
  });

  it('uses the template at once when the player leaves before the greeting arrives', () => {
    const { host, pw } = world();
    state(host, 'ada').locationId = 'house_ada';
    host.requestGreeting = () => new Promise(() => {});
    enter(pw, 'house_ada');
    pw.handleCommand({ type: 'player.exit' });
    expect(pw.houseVisits.visits()[0]).toMatchObject({
      greeting: GREETING_TEMPLATE,
      greetingSource: 'fallback',
    });
  });

  it('nobody home: snooping is noticed on return (once a day) and witnesses see it', () => {
    const { host, pw } = world();
    state(host, 'cy').pos = { x: 6, y: 7 };
    state(host, 'dot').status = 'idle';
    state(host, 'dot').locationId = 'square';
    expect(enter(pw, 'house_ada')).toEqual([]);
    const visit = pw.houseVisits.visits()[0]!;
    expect(visit).toMatchObject({ kind: 'snoop', noticedAt: null, ownerIds: ['ada', 'dot'] });
    expect(visit.witnesses).toEqual(['cy']);
    expect(host.of('conversation.message')).toHaveLength(0);
    const seen = host.memoriesOf('cy')[0]!;
    expect(seen).toMatchObject({
      kind: 'observation',
      importance: 6,
      text: "I saw Kai go into Ada's house while they were out",
    });
    expect(seen.meta?.originId).toBeTruthy();
    // The fact id only lives in memories; the saved visit id must be newer so a restore skips past it.
    const suffix = (id: string) => Number(id.split('_').at(-1));
    expect(suffix(visit.id)).toBeGreaterThan(suffix(seen.meta!.originId as string));
    expect(host.memoriesOf('ben')).toHaveLength(0);

    advance(host, pw, 30);
    expect(host.memoriesOf('ada')).toHaveLength(0);
    state(host, 'ada').locationId = 'house_ada';
    advance(host, pw, 1);
    expect(host.memoriesOf('ada').map((m) => [m.text, m.importance])).toEqual([
      ['Someone was in my house while I was out. It was Kai.', 7],
    ]);
    expect(affinity(host, 'ada')).toBe(-2);
    expect(pw.houseVisits.visits()[0]!.noticedAt).toBe(host.time);

    // A second snoop the same day is noticed but costs nothing more.
    pw.handleCommand({ type: 'player.exit' });
    state(host, 'ada').locationId = 'square';
    enter(pw, 'house_ada');
    state(host, 'ada').locationId = 'house_ada';
    advance(host, pw, 1);
    expect(host.memoriesOf('ada')).toHaveLength(1);
    expect(affinity(host, 'ada')).toBe(-2);
  });

  it('owner home asleep: remembered on waking with affinity -1', () => {
    const { host, pw } = world();
    state(host, 'dot').locationId = 'house_ada';
    expect(enter(pw, 'house_ada')).toEqual([]);
    expect(pw.houseVisits.visits()[0]!.kind).toBe('sleeping');
    advance(host, pw, 10);
    expect(host.memoriesOf('dot')).toHaveLength(0);
    state(host, 'dot').status = 'idle';
    advance(host, pw, 1);
    expect(host.memoriesOf('dot').map((m) => [m.text, m.importance])).toEqual([
      ['Kai walked into my house while I was asleep', 6],
    ]);
    expect(affinity(host, 'dot')).toBe(-1);
  });

  it('the hotel lobby and the post office can be entered without any reaction', () => {
    const { host, pw, player } = world();
    player.pos = { x: 12, y: 15 };
    expect(enter(pw, 'hotel')).toEqual([]);
    expect(player.inside?.locationId).toBe('hotel');
    pw.handleCommand({ type: 'player.exit' });
    player.pos = { x: 24, y: 5 };
    expect(enter(pw, 'post_office')).toEqual([]);
    expect(pw.houseVisits.visits()).toHaveLength(0);
    expect(host.memories).toHaveLength(0);
  });

  it('rejects entry away from the door, into the player home, and twice', () => {
    const { pw, player } = world();
    player.pos = { x: 15, y: 10 };
    expect(enter(pw, 'house_ada')?.[0]).toMatchObject({ message: expect.stringMatching(/door/) });
    player.pos = { x: 4, y: 16 };
    expect(enter(pw, 'player_home')?.[0]).toMatchObject({ type: 'error' });
    expect(enter(pw, 'bakery')?.[0]).toMatchObject({ type: 'error' });
    player.pos = { x: 4, y: 5 };
    expect(enter(pw, 'house_ada')).toEqual([]);
    expect(enter(pw, 'house_ada')?.[0]).toMatchObject({ message: expect.stringMatching(/already inside/) });
    expect(pw.handleCommand({ type: 'player.exit' })).toEqual([]);
    expect(pw.handleCommand({ type: 'player.exit' })?.[0]).toMatchObject({ type: 'error' });
  });

  it('player.move inside walks the interior grid and the exit tile leaves', () => {
    const { host, pw, player } = world();
    enter(pw, 'house_ada');
    expect(pw.handleCommand({ type: 'player.move', to: { x: 0, y: 0 } })?.[0]).toMatchObject({
      type: 'error',
    });
    expect(pw.handleCommand({ type: 'player.move', to: { x: 1, y: 1 } })).toEqual([]);
    advance(host, pw, 3);
    expect(player.inside?.pos).toEqual({ x: 1, y: 1 });
    expect(player.pos).toEqual({ x: 4, y: 5 });
    pw.handleCommand({ type: 'player.move', to: { x: 3, y: 3 } });
    advance(host, pw, 5);
    expect(player.inside).toBeNull();
    expect(player.pos).toEqual({ x: 4, y: 4 });
  });

  it('v1 door notes still work from outside', () => {
    const { pw } = world();
    // The door note flow lives in the engine; WP8 only logs notes. Logging one does not move the player.
    const entry = pw.onNoteChanged({
      id: 'n1',
      houseId: 'house_ada',
      ownerId: 'ada',
      authorId: PLAYER_ID,
      text: 'Hi Ada!',
      postedAt: 0,
      status: 'unread',
    });
    expect(entry.kind).toBe('note');
    expect(pw.state.inside ?? null).toBeNull();
  });

  it('round-trips visits and the inside state through the save', () => {
    const { pw } = world();
    enter(pw, 'house_ada');
    const save = JSON.parse(JSON.stringify(pw.serialize()));
    const b = setup({ restore: save });
    expect(b.pw.houseVisits.visits()).toEqual(save.houseVisits);
    expect(b.pw.state.inside).toEqual(save.player.inside);
  });
});
