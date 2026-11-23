import { describe, expect, it } from 'vitest';
import { distance } from '../../../src/server/player/geometry.ts';
import { PLAYER_ID } from '../../../src/shared/types.ts';
import { advance, setup } from './fake-host.ts';

describe('backpack and ground items', () => {
  it('spawns forageables up to the area max and respawns after the interval', () => {
    const { host, pw } = setup();
    expect(pw.items.items).toHaveLength(3);
    for (const i of pw.items.items) {
      expect(i.itemId).toBe('flower');
      expect(i.pos.x).toBeGreaterThanOrEqual(22);
      expect(i.pos.y).toBeLessThan(7);
    }
    const first = pw.items.items[0]!;
    pw.pickup(first.id);
    expect(pw.items.items).toHaveLength(2);
    advance(host, pw, 180, 10);
    expect(pw.items.items).toHaveLength(3);
    expect(host.of('items.updated').at(-1)!.items).toHaveLength(3);
  });

  it('picks items up when the avatar walks onto them', () => {
    const { host, pw } = setup();
    const target = pw.items.items[0]!;
    pw.handleCommand({ type: 'player.move', to: target.pos });
    advance(host, pw, 60);
    expect(pw.state.inventory.find((e) => e.itemId === 'flower')?.count).toBeGreaterThanOrEqual(1);
    expect(pw.items.items.find((i) => i.id === target.id)).toBeUndefined();
    expect(host.of('toast').some((t) => t.text === 'Picked up wild flower')).toBe(true);
  });

  it('gifts: removes the item, stores a memory, raises affinity (+2 if liked) and requests a reply', () => {
    const { host, pw } = setup();
    pw.pickup(pw.items.items[0]!.id);
    pw.pickup(pw.items.items[0]!.id);
    expect(pw.gift('ada', 'flower')).toEqual({ ok: true });
    expect(pw.gift('ben', 'flower')).toEqual({ ok: true });
    expect(pw.state.inventory).toEqual([]);
    const ada = host.states.find((v) => v.id === 'ada')!;
    const ben = host.states.find((v) => v.id === 'ben')!;
    expect(ada.relationships[PLAYER_ID]!.affinity).toBe(2);
    expect(ben.relationships[PLAYER_ID]!.affinity).toBe(1);
    expect(host.memoriesOf('ada')[0]).toMatchObject({
      importance: 5,
      text: expect.stringContaining('favourite'),
    });
    expect(host.replies.map((r) => [r.villagerId, r.mode, r.itemId, r.liked])).toEqual([
      ['ada', 'gift', 'flower', true],
      ['ben', 'gift', 'flower', false],
    ]);
    expect(pw.gift('ada', 'flower')).toMatchObject({ ok: false });
  });
});

describe('pet', () => {
  it('follows the player within 2 tiles', () => {
    const { host, pw } = setup();
    pw.handleCommand({ type: 'player.move', to: { x: 20, y: 10 } });
    advance(host, pw, 30);
    expect(pw.state.pos).toEqual({ x: 20, y: 10 });
    expect(distance(pw.state.pet.pos, pw.state.pos)).toBeLessThanOrEqual(2);
    // Stays close while the player idles (wanders only within range).
    for (let i = 0; i < 60; i++) {
      advance(host, pw, 1);
      expect(distance(pw.state.pet.pos, pw.state.pos)).toBeLessThanOrEqual(2.5);
    }
  });

  it('stays put in stay mode; rename and pet work', () => {
    const { host, pw } = setup();
    const start = { ...pw.state.pet.pos };
    expect(pw.handleCommand({ type: 'pet.command', action: 'stay' })).toEqual([]);
    pw.handleCommand({ type: 'player.move', to: { x: 20, y: 10 } });
    advance(host, pw, 20);
    expect(pw.state.pet.pos).toEqual(start);
    pw.handleCommand({ type: 'pet.command', action: 'rename', name: ' Biscuit ' });
    expect(pw.state.pet.name).toBe('Biscuit');
    expect(pw.handleCommand({ type: 'pet.command', action: 'rename', name: '' })?.[0]).toMatchObject({
      type: 'error',
    });
    pw.handleCommand({ type: 'pet.command', action: 'pet' });
    expect(host.of('toast').at(-1)).toMatchObject({ icon: '❤', text: 'You pet Biscuit' });
  });
});

describe('rumors', () => {
  it('player.rumor gives a heard memory and starts a rumor; learned facts add hops', () => {
    const { host, pw } = setup();
    pw.handleCommand({ type: 'player.rumor', villagerId: 'ada', text: 'The mayor has a secret twin' });
    const mem = host.memoriesOf('ada')[0]!;
    expect(mem).toMatchObject({ kind: 'heard', importance: 7, meta: { heardFrom: PLAYER_ID } });
    const originId = mem.meta!.originId!;
    const rumor = pw.rumors.all()[0]!;
    expect(rumor).toMatchObject({
      originMemoryId: originId,
      startedBy: PLAYER_ID,
      knownBy: ['ada'],
      text: 'The mayor has a secret twin',
    });

    pw.onLearned({
      from: 'ada',
      to: 'ben',
      originId,
      text: 'the mayor has a twin',
      said: 'Did you hear? The mayor has a twin!',
      conversationId: 'c1',
      at: host.time,
    });
    pw.onLearned({ from: 'ben', to: 'cy', originId, text: 'mayor twin', at: host.time });
    pw.onLearned({ from: 'ada', to: 'ben', originId, text: 'dupe', at: host.time });
    expect(pw.onLearned({ from: 'ada', to: 'ben', originId: 'other', text: 'x', at: 0 })).toBeNull();
    const r = pw.rumors.all()[0]!;
    expect(r.knownBy).toEqual(['ada', 'ben', 'cy']);
    expect(r.hops).toEqual([
      {
        from: 'ada',
        to: 'ben',
        at: host.time,
        text: 'Did you hear? The mayor has a twin!',
        conversationId: 'c1',
      },
      { from: 'ben', to: 'cy', at: host.time, text: 'mayor twin' },
    ]);
    expect(host.of('rumor.updated')).toHaveLength(3);
  });

  it('door notes and debug injects start rumors; important heard memories can too', () => {
    const { host, pw } = setup();
    pw.onNoteRead(
      {
        id: 'n1',
        houseId: 'house_ada',
        ownerId: 'ada',
        authorId: PLAYER_ID,
        text: 'Meet me at the pond',
        postedAt: 0,
        status: 'read',
      },
      'mem_note',
    );
    pw.onDebugInject('ben', "The mayor's cat is named Biscuit", 'mem_dbg');
    const auto = pw.onMemoryAdded({
      id: 'm9',
      villagerId: 'cy',
      createdAt: host.time,
      lastAccessedAt: host.time,
      kind: 'heard',
      text: 'Ben is moving away',
      importance: 8,
      keywords: [],
      meta: { heardFrom: 'ben', originId: 'm1' },
    });
    expect(auto).toMatchObject({ startedBy: 'ben', knownBy: ['ben', 'cy'], originMemoryId: 'm1' });
    expect(pw.rumors.all().map((r) => r.originMemoryId)).toEqual(['mem_note', 'mem_dbg', 'm1']);
    expect(pw.rumors.all()[0]!.knownBy).toEqual(['ada']);
  });
});
