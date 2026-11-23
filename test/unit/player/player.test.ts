import { describe, expect, it } from 'vitest';
import { loadCatalogs } from '../../../src/server/player/catalog.ts';
import { DEFAULT_CONFIG } from '../../../src/server/config.ts';
import { PLAYER_ID } from '../../../src/shared/types.ts';
import { advance, setup } from './fake-host.ts';

describe('catalogs', () => {
  it('loads valid item, decoration and stranger data', () => {
    const c = loadCatalogs();
    expect(c.items.map((i) => i.id)).toEqual(expect.arrayContaining(['flower', 'apple', 'seed', 'gem']));
    expect(c.decorations).toHaveLength(10);
    expect(new Set(c.decorations.map((d) => d.slot)).size).toBe(10);
    expect(c.decorations.find((d) => d.id === 'mailbox')).toBeDefined();
    expect(c.strangers.length).toBeGreaterThanOrEqual(3);
    const itemIds = new Set(c.items.map((i) => i.id));
    for (const s of c.strangers) for (const like of s.likes) expect(itemIds.has(like)).toBe(true);
  });

  it('defaults the pet to Pip the cat', () => {
    expect(DEFAULT_CONFIG.player).toMatchObject({ petName: 'Pip', petSpecies: 'cat' });
  });
});

describe('player state', () => {
  it('starts at home with config gold and pet', () => {
    const { pw, host } = setup();
    expect(pw.state).toMatchObject({
      id: PLAYER_ID,
      name: 'Kai',
      gold: 50,
      homeId: 'player_home',
      pos: { x: 4, y: 16 },
    });
    expect(pw.state.pet).toMatchObject({ name: 'Pip', species: 'cat', mode: 'follow' });
    expect(host.of('player.updated')).toHaveLength(0);
  });

  it('walks along an A* path on player.move and broadcasts progress', () => {
    const { pw, host } = setup();
    expect(pw.handleCommand({ type: 'player.move', to: { x: 14, y: 16 } })).toEqual([]);
    expect(pw.state.path.length).toBe(10);
    advance(host, pw, 10);
    expect(pw.state.pos).toEqual({ x: 14, y: 16 });
    expect(pw.state.path).toEqual([]);
    expect(pw.state.facing).toBe('right');
    expect(host.of('player.updated').length).toBeGreaterThan(3);
  });

  it('rejects unwalkable targets with an error carrying the requestId', () => {
    const { pw } = setup();
    expect(pw.handleCommand({ type: 'player.move', to: { x: 0, y: 0 }, requestId: 'r1' })).toEqual([
      { type: 'error', message: "You can't walk there", requestId: 'r1' },
    ]);
  });

  it('ignores commands it does not own', () => {
    const { pw } = setup();
    expect(pw.handleCommand({ type: 'speed', speed: 2 })).toBeNull();
    expect(pw.handleCommand({ type: 'note.post', houseId: 'house_ada', text: 'hi' })).toBeNull();
  });
});

describe('say / ask / pair talk', () => {
  it('player.say broadcasts the line, walks over and requests a reply', () => {
    const { pw, host } = setup();
    expect(
      pw.handleCommand({ type: 'player.say', villagerId: 'ada', text: '  Lovely day! ', mode: 'say' }),
    ).toEqual([]);
    expect(host.of('conversation.message')).toEqual([
      expect.objectContaining({
        conversationId: 'player:ada',
        speakerId: PLAYER_ID,
        listenerId: 'ada',
        text: 'Lovely day!',
      }),
    ]);
    expect(host.replies).toEqual([
      expect.objectContaining({
        villagerId: 'ada',
        text: 'Lovely day!',
        mode: 'say',
        conversationId: 'player:ada',
        mailboxPlaced: false,
      }),
    ]);
    expect(pw.state.path.length).toBeGreaterThan(0);
    const last = pw.state.path[pw.state.path.length - 1]!;
    expect(Math.hypot(last.x - 15, last.y - 10)).toBeLessThanOrEqual(1);
  });

  it('ask mode is forwarded for task.decide', () => {
    const { pw, host } = setup();
    pw.handleCommand({
      type: 'player.say',
      villagerId: 'ben',
      text: 'Could you water my plants?',
      mode: 'ask',
    });
    expect(host.replies[0]).toMatchObject({ mode: 'ask', villagerId: 'ben' });
  });

  it('refuses sleeping and unknown villagers, and empty or long text', () => {
    const { pw } = setup();
    expect(
      pw.handleCommand({ type: 'player.say', villagerId: 'dot', text: 'hi', mode: 'say' })?.[0],
    ).toMatchObject({ message: 'Dot is asleep' });
    expect(
      pw.handleCommand({ type: 'player.say', villagerId: 'zed', text: 'hi', mode: 'say' })?.[0],
    ).toMatchObject({ type: 'error' });
    expect(
      pw.handleCommand({ type: 'player.say', villagerId: 'ada', text: '   ', mode: 'say' })?.[0],
    ).toMatchObject({ type: 'error' });
    expect(
      pw.handleCommand({ type: 'player.say', villagerId: 'ada', text: 'x'.repeat(301), mode: 'say' })?.[0],
    ).toMatchObject({ type: 'error' });
  });

  it('pairTalk asks the engine to start a conversation', () => {
    const { pw, host } = setup();
    expect(pw.handleCommand({ type: 'player.pairTalk', aId: 'ada', bId: 'ben' })).toEqual([]);
    expect(host.conversations).toEqual([['ada', 'ben']]);
    expect(pw.handleCommand({ type: 'player.pairTalk', aId: 'ada', bId: 'ada' })?.[0]).toMatchObject({
      type: 'error',
    });
  });
});

describe('save round trip', () => {
  it('serialize -> restore keeps player, rumors, weather, items, world events and strangers', () => {
    const a = setup();
    a.pw.addGold(25, 'test');
    a.pw.handleCommand({ type: 'decor.toggle', itemId: 'mailbox' });
    a.pw.handleCommand({ type: 'player.rumor', villagerId: 'ada', text: 'The mill is haunted' });
    a.pw.handleCommand({ type: 'world.trigger', kind: 'rain' });
    a.pw.handleCommand({ type: 'world.trigger', kind: 'stranger' });
    const saved = JSON.parse(JSON.stringify(a.pw.serialize()));
    const b = setup({ restore: saved });
    expect(b.pw.serialize()).toEqual(saved);
    expect(b.pw.mailboxPlaced()).toBe(true);
    expect(b.pw.weather.state).toBe('rain');
    expect(
      b.pw.events
        .active()
        .map((e) => e.kind)
        .sort(),
    ).toEqual(['rain', 'stranger']);
  });
});
