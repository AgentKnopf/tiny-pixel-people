import type { HelloMessage, InspectDataMsg } from '../../../src/shared/protocol.ts';
import { PLAYER_ID, type Memory, type VillagerState, type WorldMap } from '../../../src/shared/types.ts';

export function makeMap(): WorldMap {
  const width = 10;
  const height = 8;
  return {
    width,
    height,
    tileSize: 16,
    tilesets: [],
    layers: { ground: [], decor: [], overhead: [] },
    collision: new Array(width * height).fill(0),
    locations: [
      {
        id: 'house_01',
        name: 'Brown house',
        kind: 'house',
        area: { x: 0, y: 0, w: 3, h: 3 },
        entry: { x: 1, y: 3 },
        door: { x: 1, y: 2 },
        ownerIds: ['ada'],
      },
      {
        id: 'house_02',
        name: 'Blue house',
        kind: 'house',
        area: { x: 4, y: 0, w: 3, h: 3 },
        entry: { x: 5, y: 3 },
      },
      {
        id: 'bakery',
        name: 'Bakery & Café',
        kind: 'shop',
        area: { x: 7, y: 0, w: 3, h: 3 },
        entry: { x: 8, y: 3 },
      },
      {
        id: 'player_home',
        name: 'Your cottage',
        kind: 'house',
        area: { x: 0, y: 5, w: 3, h: 3 },
        entry: { x: 1, y: 4 },
        door: { x: 1, y: 5 },
        ownerIds: [PLAYER_ID],
      },
    ],
    scenes: [
      { id: 'plaza', name: 'Plaza', subtitle: 'The whole town', rect: { x: 0, y: 0, w: 10, h: 8 } },
      { id: 'farm', name: 'Farm', subtitle: 'Scene', rect: { x: 0, y: 0, w: 5, h: 4 } },
      { id: 'home', name: 'Your home', subtitle: 'Your cottage', rect: { x: 0, y: 4, w: 5, h: 4 } },
    ],
    itemSpawns: [],
  };
}

export function makeVillagerState(id: string, homeId: string): VillagerState {
  return {
    id,
    pos: { x: 2, y: 3 },
    facing: 'down',
    path: [],
    locationId: homeId,
    status: 'idle',
    activity: { text: 'waking up', emoji: '🌅', locationId: homeId, since: 0 },
    thought: 'What a lovely morning.',
    needs: { hunger: 51, energy: 76, social: 80, fun: 65 },
    plan: null,
    relationships: {},
  };
}

export function makeHello(): HelloMessage {
  return {
    type: 'hello',
    protocolVersion: 1,
    map: makeMap(),
    villagers: [
      {
        id: 'ada',
        name: 'Ada',
        age: 34,
        occupation: 'baker',
        bio: 'Bakes bread at dawn.',
        traits: ['warm', 'early riser'],
        homeId: 'house_01',
        sprite: 'a',
      },
      {
        id: 'bo',
        name: 'Bo',
        age: 41,
        occupation: 'farmer',
        bio: 'Grows turnips.',
        traits: ['quiet'],
        homeId: 'house_02',
        sprite: 'b',
      },
      {
        id: 'cy',
        name: 'Cy',
        age: 25,
        occupation: 'painter',
        bio: 'Paints the pond.',
        traits: ['dreamy'],
        homeId: 'house_02',
        sprite: 'c',
      },
    ],
    snapshot: {
      time: 7 * 60 + 5,
      speed: 1,
      villagers: [
        makeVillagerState('ada', 'house_01'),
        makeVillagerState('bo', 'house_02'),
        makeVillagerState('cy', 'house_02'),
      ],
      events: [],
      notes: [],
      activeConversations: [],
      player: {
        id: PLAYER_ID,
        name: 'Kim',
        pos: { x: 1, y: 4 },
        facing: 'down',
        path: [],
        homeId: 'player_home',
        gold: 20,
        inventory: [
          { itemId: 'flower', count: 2 },
          { itemId: 'apple', count: 1 },
        ],
        ownedDecorations: ['welcome_rug'],
        placedDecorations: ['welcome_rug'],
        pet: { name: 'Pip', species: 'cat', pos: { x: 2, y: 4 }, facing: 'down', mode: 'follow' },
      },
      rumors: [],
      weather: { state: 'clear', since: 0, until: null },
      items: [],
      worldEvents: [],
    },
    llm: { provider: 'ollama', model: 'qwen2.5:7b', embeddings: 'nomic-embed-text' },
    debug: false,
  };
}

export function makeMemory(i: number, extra: Partial<Memory> = {}): Omit<Memory, 'embedding'> {
  return {
    id: `m${i}`,
    villagerId: 'ada',
    createdAt: 400 + i,
    lastAccessedAt: 400 + i,
    kind: 'observation',
    text: `memory number ${i}`,
    importance: 3,
    keywords: [],
    meta: {},
    ...extra,
  };
}

export function makeInspect(): InspectDataMsg {
  const state = makeVillagerState('ada', 'house_01');
  const plan = {
    day: 0,
    summary: 'A baking day',
    revision: 1,
    source: 'llm' as const,
    createdAt: 360,
    blocks: [
      { start: 6 * 60, end: 7 * 60, locationId: 'house_01', activity: 'wake up and stretch', done: true },
      { start: 7 * 60, end: 10 * 60, locationId: 'bakery', activity: 'bake bread', emoji: '🍞' },
      { start: 10 * 60, end: 12 * 60, locationId: 'house_02', activity: 'visit Bo', taskId: 't1' },
    ],
  };
  const memories = Array.from({ length: 12 }, (_, i) => makeMemory(i));
  memories[0] = makeMemory(0, {
    kind: 'heard',
    text: 'Kim said the mayor sings',
    meta: { heardFrom: PLAYER_ID },
  });
  return {
    type: 'inspect.data',
    villagerId: 'ada',
    state: { ...state, plan, thought: 'The oven is warm.' },
    plan,
    memories,
    relationships: {
      bo: { affinity: 5, summary: 'old friend' },
      cy: { affinity: -2 },
      [PLAYER_ID]: { affinity: 3 },
    },
  };
}
