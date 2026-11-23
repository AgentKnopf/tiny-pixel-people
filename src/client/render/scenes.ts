import type { Rect, Scene, WorldMap } from '../../shared/types.ts';

export const DEFAULT_SCENE_ID = 'plaza';
export const HOME_SCENE_ID = 'home';
/** v2: the whole 128×60 map. */
export const OVERVIEW_SCENE_ID = 'overview';

/** Scene rect in art px. */
export function sceneRectPx(scene: Scene, tileSize: number): Rect {
  return {
    x: scene.rect.x * tileSize,
    y: scene.rect.y * tileSize,
    w: scene.rect.w * tileSize,
    h: scene.rect.h * tileSize,
  };
}

/** Whole-map scene used when the map ships no presets. */
export function wholeMapScene(map: WorldMap): Scene {
  return {
    id: DEFAULT_SCENE_ID,
    name: 'Plaza',
    subtitle: 'The whole town',
    rect: { x: 0, y: 0, w: map.width, h: map.height },
  };
}

export function listScenes(map: WorldMap): Scene[] {
  return map.scenes.length > 0 ? map.scenes : [wholeMapScene(map)];
}

/** Find a scene by id; `plaza` falls back to the whole map, `home` to the player's home location. */
export function findScene(map: WorldMap, id: string): Scene | null {
  const s = map.scenes.find((sc) => sc.id === id);
  if (s) return s;
  if (id === DEFAULT_SCENE_ID) return wholeMapScene(map);
  if (id === OVERVIEW_SCENE_ID) {
    return { ...wholeMapScene(map), id: OVERVIEW_SCENE_ID, name: 'Overview', subtitle: 'The whole map' };
  }
  if (id === HOME_SCENE_ID) {
    const home = map.locations.find((l) => l.id === 'player_home');
    if (home) {
      const pad = 4;
      const x = Math.max(0, home.area.x - pad);
      const y = Math.max(0, home.area.y - pad);
      return {
        id: HOME_SCENE_ID,
        name: 'Your home',
        subtitle: home.name,
        rect: {
          x,
          y,
          w: Math.min(map.width - x, home.area.w + pad * 2),
          h: Math.min(map.height - y, home.area.h + pad * 2),
        },
      };
    }
  }
  return null;
}
