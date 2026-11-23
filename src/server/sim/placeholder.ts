import {
  PLAYER_HOME_ID,
  PLAYER_ID,
  type GameMinutes,
  type WorldMap,
  type WorldSnapshot,
} from '../../shared/types.ts';

/**
 * Tiny generated map used until WP2 ships data/map/village.json.
 * Grass everywhere, blocked border, a square in the middle and the player's home.
 */
export function createPlaceholderMap(width = 40, height = 30): WorldMap {
  const size = width * height;
  const collision: (0 | 1)[] = Array.from({ length: size }, (_, i) => {
    const x = i % width;
    const y = Math.floor(i / width);
    return x === 0 || y === 0 || x === width - 1 || y === height - 1 ? 1 : 0;
  });
  return {
    width,
    height,
    tileSize: 16,
    tilesets: [],
    layers: {
      ground: new Array<number>(size).fill(0),
      decor: new Array<number>(size).fill(-1),
      overhead: new Array<number>(size).fill(-1),
    },
    collision,
    locations: [
      {
        id: 'square',
        name: 'Village Square',
        kind: 'public',
        area: { x: 16, y: 11, w: 8, h: 8 },
        entry: { x: 20, y: 15 },
      },
      {
        id: PLAYER_HOME_ID,
        name: 'Your cottage',
        kind: 'house',
        area: { x: 2, y: 23, w: 5, h: 4 },
        entry: { x: 4, y: 27 },
        door: { x: 4, y: 26 },
        ownerIds: [PLAYER_ID],
        decorSlots: [
          { x: 3, y: 27 },
          { x: 5, y: 27 },
        ],
      },
    ],
    scenes: [
      { id: 'plaza', name: 'Plaza', subtitle: 'The whole town', rect: { x: 0, y: 0, w: width, h: height } },
      { id: 'home', name: 'Your home', subtitle: 'Your cottage', rect: { x: 0, y: 20, w: 12, h: 10 } },
    ],
    itemSpawns: [],
  };
}

export function createPlaceholderSnapshot(
  time: GameMinutes,
  speed: number,
  playerName = 'You',
): WorldSnapshot {
  return {
    time,
    speed,
    villagers: [],
    events: [],
    notes: [],
    activeConversations: [],
    player: {
      id: PLAYER_ID,
      name: playerName,
      pos: { x: 4, y: 27 },
      facing: 'down',
      path: [],
      homeId: PLAYER_HOME_ID,
      gold: 50,
      inventory: [],
      ownedDecorations: [],
      placedDecorations: [],
      pet: { name: 'Pip', species: 'dog', pos: { x: 5, y: 27 }, facing: 'down', mode: 'follow' },
    },
    rumors: [],
    weather: { state: 'clear', since: time, until: null },
    items: [],
    worldEvents: [],
  };
}
