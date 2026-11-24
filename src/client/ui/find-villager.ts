import type { VillagerId } from '../../shared/types.ts';
import type { UiStore } from './store.ts';
import type { UiHost } from './types.ts';

/** "Find them": follow the villager with the camera, or pan to its last known tile. Never throws. */
export function findVillager(host: UiHost, store: UiStore, id: VillagerId): void {
  const camera = host.camera;
  // The renderer returns false when it has no position for the villager yet.
  const followed = camera?.followVillager ? (camera.followVillager(id) as unknown) !== false : false;
  if (!followed) {
    const f = store.frames.get(id);
    if (f) camera?.focusTile?.({ x: f.x, y: f.y });
  }
  store.setScene(null);
}
