import { describe, expect, it } from 'vitest';
import type { HelloMessage, ServerMessage } from '../../src/shared/protocol.ts';
import { createPlaceholderMap, createPlaceholderSnapshot } from '../../src/server/sim/placeholder.ts';
import { BUBBLE_MS, GameStore, entityPos, facingFromDelta, isMoving } from '../../src/client/state.ts';
import type { VillagerState } from '../../src/shared/types.ts';

function villager(id: string, x: number, y: number): VillagerState {
  return {
    id,
    pos: { x, y },
    facing: 'down',
    path: [],
    locationId: null,
    status: 'idle',
    activity: { text: 'idle', emoji: '🙂', locationId: null, since: 0 },
    thought: '',
    needs: { hunger: 80, energy: 80, social: 80, fun: 80 },
    plan: null,
    relationships: {},
  };
}

function hello(): HelloMessage {
  const snapshot = createPlaceholderSnapshot(360, 1);
  snapshot.villagers = [villager('ada', 5, 5), villager('bo', 10, 10)];
  snapshot.notes = [
    {
      id: 'n2',
      houseId: 'h1',
      ownerId: 'ada',
      authorId: 'player',
      text: 'b',
      postedAt: 20,
      status: 'unread',
    },
    { id: 'n1', houseId: 'h1', ownerId: 'ada', authorId: 'player', text: 'a', postedAt: 10, status: 'read' },
  ];
  return {
    type: 'hello',
    protocolVersion: 1,
    map: createPlaceholderMap(),
    villagers: [
      {
        id: 'ada',
        name: 'Ada',
        age: 30,
        occupation: 'baker',
        bio: '',
        traits: [],
        homeId: 'h1',
        sprite: 'villager-01',
      },
      {
        id: 'bo',
        name: 'Bo',
        age: 40,
        occupation: 'farmer',
        bio: '',
        traits: [],
        homeId: 'h2',
        sprite: 'villager-02',
      },
    ],
    snapshot,
    llm: { provider: 'mock', model: 'mock', embeddings: null },
    debug: false,
  };
}

function tick(
  time: number,
  x: number,
  extra: Partial<{ bubble: string; status: 'walking' | 'idle' }> = {},
): ServerMessage {
  return {
    type: 'tick',
    time,
    speed: 1,
    villagers: [
      {
        id: 'ada',
        x,
        y: 5,
        facing: 'right',
        status: extra.status ?? 'walking',
        activity: 'walking',
        emoji: '🚶',
        ...extra,
      },
    ],
  };
}

describe('GameStore', () => {
  it('initialises from hello', () => {
    const s = new GameStore();
    const seen: string[] = [];
    s.subscribe((m) => seen.push(m.type));
    s.apply(hello(), 1000);
    expect(s.map?.width).toBe(40);
    expect(s.villagers.size).toBe(2);
    expect(s.displayName('ada')).toBe('Ada');
    expect(s.displayName('player')).toBe('You');
    expect(s.positionOf('ada', 1000)).toEqual({ x: 5, y: 5 });
    expect(s.positionOf('player', 1000)).toEqual({ x: 4, y: 27 });
    expect(s.positionOf('pet', 1000)).toEqual({ x: 5, y: 27 });
    expect(s.notesForHouse('h1').map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(seen).toEqual(['hello']);
  });

  it('glides between ticks and snaps on teleports', () => {
    const s = new GameStore();
    s.apply(hello(), 1000);
    s.apply(tick(361, 6), 1100);
    const e = s.villagers.get('ada')!;
    expect(entityPos(e, 1100).x).toBeCloseTo(5);
    expect(entityPos(e, 1150).x).toBeCloseTo(5.5);
    expect(entityPos(e, 1200).x).toBeCloseTo(6);
    expect(entityPos(e, 5000).x).toBeCloseTo(6);
    expect(e.facing).toBe('right');
    expect(isMoving(e, 1150)).toBe(true);
    s.apply(tick(362, 30), 1300);
    expect(entityPos(e, 1300).x).toBe(30);
  });

  it('keeps unchanged villagers when a tick only lists changed ones', () => {
    const s = new GameStore();
    s.apply(hello(), 1000);
    s.apply(tick(361, 6), 1100);
    expect(s.positionOf('bo', 1200)).toEqual({ x: 10, y: 10 });
  });

  it('shows bubbles from conversation messages and tick frames, without restarting repeats', () => {
    const s = new GameStore();
    s.apply(hello(), 1000);
    s.apply(
      {
        type: 'conversation.message',
        conversationId: 'c',
        speakerId: 'bo',
        listenerId: 'ada',
        text: 'Hi Ada',
        time: 361,
      },
      1000,
    );
    expect(s.conversations.get('c')?.participants).toEqual(['bo', 'ada']);
    s.apply(tick(361, 5, { bubble: 'Hello!' }), 2000);
    s.apply(tick(361, 5, { bubble: 'Hello!' }), 3000);
    expect(s.bubbles.get('ada')?.startedAt).toBe(2000);
    expect(
      s
        .activeBubbles(2500)
        .map((b) => b.speakerId)
        .sort(),
    ).toEqual(['ada', 'bo']);
    expect(s.activeBubbles(1000 + BUBBLE_MS).map((b) => b.speakerId)).toEqual(['ada']);
    expect(s.activeBubbles(2000 + BUBBLE_MS)).toEqual([]);
    s.apply({ type: 'conversation.ended', conversationId: 'c', participants: ['bo', 'ada'] }, 3000);
    expect(s.conversations.size).toBe(0);
  });

  it('tracks selection and only keeps inspect data for the selected villager', () => {
    const s = new GameStore();
    s.apply(hello(), 1000);
    const local: unknown[] = [];
    s.subscribe((m) => {
      if (m.type === 'local.select') local.push(m.villagerId);
    });
    s.select('ada');
    const data = {
      type: 'inspect.data' as const,
      villagerId: 'bo',
      state: villager('bo', 1, 1),
      plan: null,
      memories: [],
      relationships: {},
    };
    s.apply(data, 1000);
    expect(s.inspect).toBeNull();
    s.apply({ ...data, villagerId: 'ada', state: villager('ada', 1, 1) }, 1000);
    expect(s.inspect?.villagerId).toBe('ada');
    s.select(null);
    expect(s.inspect).toBeNull();
    expect(local).toEqual(['ada', null]);
  });

  it('adds and removes villagers (strangers)', () => {
    const s = new GameStore();
    s.apply(hello(), 1000);
    s.select('bo');
    s.apply(
      {
        type: 'villagers.changed',
        added: [
          {
            id: 'zed',
            name: 'Zed',
            age: 50,
            occupation: 'traveller',
            bio: '',
            traits: [],
            homeId: 'h1',
            sprite: 'stranger',
            transient: true,
          },
        ],
        removed: ['bo'],
      },
      1000,
    );
    expect(s.profiles.has('zed')).toBe(true);
    expect(s.villagers.has('bo')).toBe(false);
    expect(s.selectedId).toBeNull();
  });

  it('moves the player from player.updated and from player tick frames', () => {
    const s = new GameStore();
    s.apply(hello(), 1000);
    const player = { ...s.player!, pos: { x: 5, y: 27 }, path: [{ x: 6, y: 27 }] };
    s.apply({ type: 'player.updated', player }, 1100);
    expect(s.positionOf('player', 1200)).toEqual({ x: 5, y: 27 });
    expect(s.playerEntity?.status).toBe('walking');
    s.apply(
      {
        type: 'tick',
        time: 361,
        speed: 1,
        villagers: [
          { id: 'player', x: 6, y: 27, facing: 'right', status: 'walking', activity: '', emoji: '' },
        ],
      },
      1300,
    );
    expect(s.positionOf('player', 2000)).toEqual({ x: 6, y: 27 });
  });

  it('keeps world collections current', () => {
    const s = new GameStore();
    s.apply(hello(), 1000);
    s.apply({ type: 'weather.updated', weather: { state: 'rain', since: 1, until: 100 } }, 1000);
    s.apply({ type: 'items.updated', items: [{ id: 'i1', itemId: 'flower', pos: { x: 1, y: 1 } }] }, 1000);
    s.apply(
      {
        type: 'note.updated',
        note: {
          id: 'n1',
          houseId: 'h1',
          ownerId: 'ada',
          authorId: 'player',
          text: 'a',
          postedAt: 10,
          status: 'replied',
          reply: 'ok',
        },
      },
      1000,
    );
    s.apply({ type: 'error', message: 'bad' }, 1000);
    expect(s.weather.state).toBe('rain');
    expect(s.items).toHaveLength(1);
    expect(s.notes.get('n1')?.status).toBe('replied');
    expect(s.lastError).toBe('bad');
  });

  it('extrapolates the clock from observed tick rate and freezes when paused', () => {
    const s = new GameStore();
    s.apply(hello(), 1000);
    for (let i = 1; i <= 20; i++)
      s.apply({ type: 'tick', time: 360 + i * 0.16, speed: 1, villagers: [] }, 1000 + i * 100);
    expect(s.minutesPerMs).toBeCloseTo(0.0016, 4);
    expect(s.gameTimeAt(3000 + 500)).toBeCloseTo(360 + 3.2 + 0.8, 1);
    expect(s.gameTimeAt(3000 + 60_000)).toBeCloseTo(360 + 3.2 + 1.6, 1);
    s.apply({ type: 'tick', time: 363.2, speed: 0, villagers: [] }, 3100);
    expect(s.gameTimeAt(4000)).toBe(363.2);
  });

  it('derives facing from movement', () => {
    expect(facingFromDelta(1, 0.2, 'down')).toBe('right');
    expect(facingFromDelta(-1, 0, 'down')).toBe('left');
    expect(facingFromDelta(0, -1, 'down')).toBe('up');
    expect(facingFromDelta(0, 0, 'left')).toBe('left');
  });
});
