import { describe, expect, it } from 'vitest';
import type { HelloMessage } from '../../src/shared/protocol.ts';
import { createPlaceholderMap, createPlaceholderSnapshot } from '../../src/server/sim/placeholder.ts';
import { GameStore, entityPos } from '../../src/client/state.ts';
import {
  animalHitBox,
  animalTopLeft,
  animationFor,
  isAerial,
  pickAnimalColumn,
  placeholderAnimalSheet,
  resolveEntry,
  sheetInfo,
  type AnimalIndex,
} from '../../src/client/render/animals.ts';
import { Camera, containZoom } from '../../src/client/render/camera.ts';
import { hitTest } from '../../src/client/render/hit.ts';
import { OVERVIEW_SCENE_ID, findScene } from '../../src/client/render/scenes.ts';
import { CHUNK_TILES, chunksInView } from '../../src/client/render/tiles.ts';
import {
  FARM_SPECIES,
  FOREST_SPECIES,
  ZOO_SPECIES,
  type AnimalSpecies,
  type AnimalState,
} from '../../src/shared/types.ts';

const ALL_SPECIES: AnimalSpecies[] = [...FARM_SPECIES, ...ZOO_SPECIES, ...FOREST_SPECIES, 'crow'];

function animal(id: string, species: AnimalSpecies, x: number, y: number, extra: Partial<AnimalState> = {}) {
  return {
    id,
    species,
    group: 'zoo',
    homeId: 'pen',
    pos: { x, y },
    facing: 'left',
    status: 'idle',
    ...extra,
  } as AnimalState;
}

function hello(): HelloMessage {
  const snapshot = createPlaceholderSnapshot(600, 1);
  snapshot.animals = [
    animal('a1', 'cow', 5, 5, { group: 'farm', stage: 'adult' }),
    animal('a2', 'crow', 8, 2),
  ];
  snapshot.train = { status: 'away', arrivesAt: 960, departsAt: 985, arriving: [], departing: [] };
  snapshot.rides = [{ locationId: 'carousel', status: 'idle', riders: [], queue: [], cycleEndsAt: null }];
  snapshot.letters = [
    { id: 'l1', from: 'player', to: 'ada', text: 'hi', postedAt: 500, status: 'delivered' },
    { id: 'l2', from: 'ada', to: 'player', text: 'yo', postedAt: 550, status: 'posted' },
  ];
  snapshot.keepSize = 3;
  return {
    type: 'hello',
    protocolVersion: 2,
    map: createPlaceholderMap(128, 60),
    villagers: [
      {
        id: 'ada',
        name: 'Ada',
        age: 30,
        occupation: 'baker',
        bio: '',
        traits: [],
        homeId: 'h1',
        sprite: 'x',
      },
      {
        id: 'vis',
        name: 'Vi',
        age: 30,
        occupation: 'tourist',
        bio: '',
        traits: [],
        homeId: 'hotel',
        sprite: 'x',
        transient: true,
        visitor: true,
      },
    ],
    snapshot,
    llm: { provider: 'mock', model: 'm', embeddings: null },
    debug: false,
  } as HelloMessage;
}

describe('v2 store', () => {
  it('loads v2 snapshot fields and interpolates animal frames', () => {
    const s = new GameStore();
    s.apply(hello(), 1000);
    expect(s.animals.size).toBe(2);
    expect(s.train?.status).toBe('away');
    expect(s.rides.get('carousel')?.status).toBe('idle');
    expect(s.keepSize).toBe(3);
    expect(s.animals.get('a1')!.side).toBe('left');
    s.apply(
      {
        type: 'tick',
        time: 601,
        speed: 1,
        villagers: [],
        animals: [{ id: 'a1', x: 6, y: 5, facing: 'right', status: 'walking' }],
      },
      1200,
    );
    const a = s.animals.get('a1')!;
    expect(a.state.status).toBe('walking');
    expect(a.side).toBe('right');
    const mid = entityPos(a.e, 1300);
    expect(mid.x).toBeGreaterThan(5);
    expect(mid.x).toBeLessThan(6);
    // Vertical moves keep the last horizontal side.
    s.apply(
      {
        type: 'tick',
        time: 602,
        speed: 1,
        villagers: [],
        animals: [{ id: 'a1', x: 6, y: 6, facing: 'down', status: 'walking' }],
      },
      1600,
    );
    expect(s.animals.get('a1')!.side).toBe('right');
    // Frames for unknown animals are ignored.
    s.apply(
      {
        type: 'tick',
        time: 603,
        speed: 1,
        villagers: [],
        animals: [{ id: 'zz', x: 1, y: 1, facing: 'down', status: 'idle' }],
      },
      1700,
    );
    expect(s.animals.has('zz')).toBe(false);
  });

  it('applies animals.changed, emotes and the other v2 messages', () => {
    const s = new GameStore();
    s.apply(hello(), 1000);
    s.apply(
      {
        type: 'animals.changed',
        added: [animal('c2', 'cow', 3, 3, { group: 'farm', stage: 'baby' })],
        removed: [{ id: 'a1', species: 'cow', reason: 'butcher' }],
        updated: [animal('a2', 'crow', 9, 2, { status: 'flying' })],
      },
      1100,
    );
    expect([...s.animals.keys()].sort()).toEqual(['a2', 'c2']);
    expect(s.animals.get('a2')!.state.status).toBe('flying');
    s.apply({ type: 'animal.emote', animalId: 'a2', emote: 'Caw!' }, 1200);
    expect(s.activeBubbles(1300).map((b) => b.text)).toEqual(['Caw!']);
    expect(s.activeBubbles(1200 + 3000)).toEqual([]);
    s.apply(
      {
        type: 'train.updated',
        train: { status: 'boarding', arrivesAt: 960, departsAt: 985, arriving: ['vis'], departing: [] },
      },
      1300,
    );
    s.apply(
      {
        type: 'hotel.updated',
        hotel: { locationId: 'hotel', rooms: [{ id: 'r1', guestId: 'vis', since: 960 }] },
      },
      1300,
    );
    s.apply({ type: 'stock.updated', stock: { burger_joint: { burger: 4 } } }, 1300);
    s.apply(
      { type: 'notice.updated', notice: { id: 'n1', authorId: 'ada', text: 'x', postedAt: 1, expiresAt: 9 } },
      1300,
    );
    s.apply(
      {
        type: 'notice.updated',
        notice: { id: 'n1', authorId: 'ada', text: 'x', postedAt: 1, expiresAt: 9 },
        removed: true,
      },
      1300,
    );
    s.apply(
      {
        type: 'keep.data',
        entries: [{ id: 'k1', kind: 'note', at: 1, refId: 'n', authorId: 'ada', text: 'a' }],
        total: 3,
        offset: 0,
      },
      1300,
    );
    s.apply(
      {
        type: 'keep.added',
        entry: { id: 'k2', kind: 'letter', at: 2, refId: 'l', authorId: 'ada', text: 'b' },
      },
      1300,
    );
    expect(s.train?.status).toBe('boarding');
    expect(s.hotel?.rooms[0]?.guestId).toBe('vis');
    expect(s.stock.burger_joint?.burger).toBe(4);
    expect(s.notices.size).toBe(0);
    expect(s.keep?.entries.map((k) => k.id)).toEqual(['k2', 'k1']);
    expect(s.keepSize).toBe(4);
  });

  it('routes letters to mailboxes: visitors at the hotel, the player at home', () => {
    const s = new GameStore();
    s.apply(hello(), 1000);
    s.apply(
      {
        type: 'letter.updated',
        letter: { id: 'l3', from: 'ada', to: 'vis', text: 'x', postedAt: 1, status: 'delivered' },
      },
      1000,
    );
    const boxes = s.lettersByMailbox();
    expect(boxes.get('h1')?.map((l) => l.id)).toEqual(['l1']);
    expect(boxes.get('hotel')?.map((l) => l.id)).toEqual(['l3']);
    expect(s.undeliveredLetters().map((l) => l.id)).toEqual(['l2']);
  });
});

describe('chunked tile layers', () => {
  it('splits a 128×60 map into 4×2 chunks and only returns the visible ones', () => {
    const all = chunksInView(128, 60, 16, { x: 0, y: 0, w: 128 * 16, h: 60 * 16 });
    expect(all).toHaveLength(8);
    expect(all.at(-1)).toMatchObject({ cx: 3, cy: 1, x: 96, y: 32, w: 32, h: 28 });
    // The v1 town (48×30 tiles) touches only the first two chunk columns of row 0.
    const town = chunksInView(128, 60, 16, { x: 0, y: 0, w: 48 * 16, h: 30 * 16 });
    expect(town.map((c) => `${c.cx},${c.cy}`)).toEqual(['0,0', '1,0']);
    // Off-map views (overview with margins) are clamped.
    expect(chunksInView(128, 60, 16, { x: -500, y: -500, w: 4000, h: 2000 })).toHaveLength(8);
    expect(CHUNK_TILES).toBe(32);
  });
});

describe('camera on the 128×60 map', () => {
  it('fits the overview below 1× and never zooms out past it', () => {
    const c = new Camera();
    c.setWorld(2048, 960);
    c.setViewport(1440, 900);
    c.frame({ x: 0, y: 0, w: 2048, h: 960 }, true, true);
    expect(c.zoom).toBeCloseTo(1440 / 2048);
    const tl = c.screenToWorld({ x: 0, y: 0 });
    const br = c.screenToWorld({ x: 1440, y: 900 });
    expect(tl.x).toBeLessThanOrEqual(0.5);
    expect(br.x).toBeGreaterThanOrEqual(2047.5);
    expect(tl.y).toBeLessThanOrEqual(0.5);
    expect(br.y).toBeGreaterThanOrEqual(959.5);
    c.zoomBy(-1);
    expect(c.zoom).toBeCloseTo(1440 / 2048);
    c.zoomBy(1);
    expect(c.zoom).toBe(1);
    expect(containZoom(768, 480, 1440, 900)).toBeCloseTo(1440 / 768);
  });

  it('falls back to a whole-map overview scene', () => {
    const map = createPlaceholderMap(128, 60);
    expect(findScene(map, OVERVIEW_SCENE_ID)?.rect).toEqual({ x: 0, y: 0, w: 128, h: 60 });
  });
});

const INDEX: AnimalIndex = {
  rows: ['left', 'right'],
  frames: { idle: [0, 1], walk: [2, 3, 4, 5] },
  fps: { idle: 2, walk: 6 },
  animals: [
    {
      key: 'cow',
      group: 'farm',
      species: 'cow',
      age: 'adult',
      sprite: 'animals/cow.png',
      frameWidth: 32,
      frameHeight: 24,
      anchor: { x: 16, y: 22 },
    },
    {
      key: 'cow-calf',
      group: 'farm',
      species: 'cow',
      age: 'young',
      sprite: 'animals/cow-calf.png',
      frameWidth: 32,
      frameHeight: 24,
      anchor: { x: 16, y: 22 },
    },
    {
      key: 'sheep',
      group: 'farm',
      species: 'sheep',
      age: 'adult',
      sprite: 'animals/sheep.png',
      frameWidth: 24,
      frameHeight: 24,
      anchor: { x: 12, y: 22 },
    },
    {
      key: 'bird',
      group: 'forest',
      species: 'bird',
      sprite: 'animals/bird.png',
      frameWidth: 16,
      frameHeight: 16,
      anchor: { x: 8, y: 14 },
    },
    {
      key: 'bluebird',
      group: 'forest',
      species: 'bird',
      sprite: 'animals/bluebird.png',
      frameWidth: 16,
      frameHeight: 16,
      anchor: { x: 8, y: 14 },
    },
    {
      key: 'crow',
      group: 'forest',
      species: 'crow',
      sprite: 'animals/crow.png',
      frameWidth: 16,
      frameHeight: 16,
      anchor: { x: 8, y: 14 },
    },
  ],
};

describe('animal sprites', () => {
  it('resolves species and age to the art index, shrinking babies without a young sheet', () => {
    expect(resolveEntry(INDEX, 'cow', 'baby', 0)).toMatchObject({ entry: { key: 'cow-calf' }, scale: 1 });
    expect(resolveEntry(INDEX, 'cow', 'elder', 0)).toMatchObject({ entry: { key: 'cow' }, scale: 1 });
    expect(resolveEntry(INDEX, 'sheep', 'baby', 0)).toMatchObject({ entry: { key: 'sheep' }, scale: 0.75 });
    expect(resolveEntry(INDEX, 'bird', undefined, 0)?.entry.key).toBe('bird');
    expect(resolveEntry(INDEX, 'bird', undefined, 1)?.entry.key).toBe('bluebird');
    expect(resolveEntry(INDEX, 'lion', undefined, 0)).toBeNull();
    expect(resolveEntry(null, 'cow', 'adult', 0)).toBeNull();
  });

  it('picks walk, idle, caw and fallback columns', () => {
    const cow = sheetInfo(INDEX, INDEX.animals[0]!, 1);
    expect(cow.rows).toEqual({ left: 0, right: 1 });
    expect(pickAnimalColumn(cow, 'walk', 0)).toBe(2);
    expect(pickAnimalColumn(cow, 'walk', 1000 / 6)).toBe(3);
    expect(pickAnimalColumn(cow, 'idle', 600)).toBe(1);
    // No sleep or fly columns yet: sleep holds idle frame 0, fly plays the walk cycle.
    expect(pickAnimalColumn(cow, 'sleep', 600)).toBe(0);
    expect([2, 3, 4, 5]).toContain(pickAnimalColumn(cow, 'fly', 300));
    const crow = sheetInfo(INDEX, INDEX.animals[5]!, 1);
    expect(crow.frames.caw).toEqual([5, 6]);
    expect(crow.frames.walk).toEqual([2, 3, 4]);
    expect(animationFor('idle', false, true)).toBe('caw');
    expect(animationFor('flying', true, false)).toBe('fly');
    expect(animationFor('leaving', false, false)).toBe('walk');
  });

  it('anchors feet to the tile bottom and draws birds and the crow above the overhead layer', () => {
    const cow = sheetInfo(INDEX, INDEX.animals[0]!, 1);
    expect(animalTopLeft({ x: 10, y: 5 }, 16, cow)).toEqual({ x: 160 + 8 - 16, y: 80 + 14 - 22 });
    expect(isAerial('bird') && isAerial('crow')).toBe(true);
    expect(isAerial('duck') || isAerial('cow')).toBe(false);
  });

  it('has a placeholder sheet for every species in the art layout', () => {
    for (const sp of ALL_SPECIES) {
      const ph = placeholderAnimalSheet(sp);
      expect(ph.w).toBe(ph.info.w * 8);
      expect(ph.h).toBe(ph.info.h * 2);
      let opaque = 0;
      for (let i = 3; i < ph.px.length; i += 4) if (ph.px[i]! > 0) opaque++;
      expect(opaque, sp).toBeGreaterThan(10);
      const young = placeholderAnimalSheet(sp, true);
      expect(young.info.w).toBeLessThan(ph.info.w);
    }
  });

  it('uses the finalized art index: shared sleep column and the crow frame list', () => {
    const idx: AnimalIndex = {
      rows: ['left', 'right'],
      frames: { idle: [0, 1], walk: [2, 3, 4, 5], sleep: [6] },
      fps: { idle: 2, walk: 6, fly: 8, sleep: 1 },
      animals: [
        { ...INDEX.animals[0]! },
        {
          key: 'crow',
          group: 'crow',
          species: 'crow',
          sprite: 'animals/crow.png',
          frameWidth: 16,
          frameHeight: 16,
          anchor: { x: 8, y: 14 },
          frames: { idle: [0, 1], hop: [2, 3, 4], caw: [5, 6], fly: [7, 8, 9, 10], sleep: [11] },
        },
      ],
    };
    const cow = sheetInfo(idx, idx.animals[0]!, 1);
    expect(pickAnimalColumn(cow, 'sleep', 5000)).toBe(6);
    const crow = sheetInfo(idx, idx.animals[1]!, 1);
    expect(crow.frames.walk).toEqual([2, 3, 4]);
    expect(pickAnimalColumn(crow, 'sleep', 0)).toBe(11);
    expect(pickAnimalColumn(crow, 'fly', 1000 / 8)).toBe(8);
  });

  it('hit-tests animals between villagers and doors', () => {
    const map = createPlaceholderMap();
    const cow = sheetInfo(INDEX, INDEX.animals[0]!, 1);
    const box = animalHitBox({ x: 10, y: 10 }, 16, cow);
    const p = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    expect(hitTest(map, p, [], null, [{ id: 'cow1', box, y: 10 }])).toEqual({ kind: 'animal', id: 'cow1' });
    expect(
      hitTest(map, p, [{ id: 'ada', pos: { x: 10, y: 10 } }], null, [{ id: 'cow1', box, y: 10 }]),
    ).toEqual({
      kind: 'villager',
      id: 'ada',
    });
  });
});
