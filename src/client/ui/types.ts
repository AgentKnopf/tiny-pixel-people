/**
 * Contract between the UI panels (src/client/ui, DOM overlay) and the world renderer
 * (src/client/render + main.ts, canvas). The renderer owns the canvas, camera and hit-testing;
 * the UI owns every HTML panel. main.ts wires them together:
 *
 *   const ui = mountUi(document.querySelector('#ui')!, { send: conn.send, camera });
 *   connect((msg) => { renderer.handle(msg); ui.handleMessage(msg); }, ui.setConnectionStatus);
 *   renderer.onVillagerClick = (id) => ui.selectVillager(id);
 *   renderer.onDoorClick = (houseId) => ui.openDoorNote(houseId);
 *   ui.onSelectionChange((id) => renderer.setSelected(id));
 */
import type { ClientMessage, ServerMessage } from '../../shared/protocol.ts';
import type { AnimalId, DecorationItem, ItemDef, LocationId, Point, VillagerId } from '../../shared/types.ts';

/** Camera actions the renderer exposes to the toolbar, dock, map modal and inspector. All optional. */
export interface CameraControls {
  zoomIn?(): void;
  zoomOut?(): void;
  /** Fit the whole map (the "plaza" overview). */
  fit?(): void;
  /** Ease to a named scene from `map.scenes` and follow it. */
  showScene?(sceneId: string): void;
  /** Pan to a villager and keep following it ("Find them"); false when its position is unknown. */
  followVillager?(villagerId: VillagerId): boolean | void;
  /** Pan to a tile. */
  focusTile?(tile: Point): void;
}

export interface UiHost {
  send(msg: ClientMessage): void;
  camera?: CameraControls;
  /** Download hook for "Save replay"; defaults to navigating an <a download> to /api/replay. */
  download?(url: string, filename: string): void;
  /** Base URL for HTTP calls (default ""). */
  apiBase?: string;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface Catalog {
  items: ItemDef[];
  decorations: DecorationItem[];
}

export interface UiController {
  /** Feed every server message here (after the renderer, order does not matter). */
  handleMessage(msg: ServerMessage): void;
  /** Accepts the free-text status from net.ts connect() as well as a ConnectionState. */
  setConnectionStatus(status: string): void;
  /** Open (or close with null) the inspector, e.g. when a villager is clicked on the canvas. */
  selectVillager(id: VillagerId | null): void;
  /** Open (or close with null) the animal card for a clicked animal (closes the villager inspector). */
  selectAnimal(id: AnimalId | null): void;
  /**
   * Open the door modal for a clicked door: "Go inside" (player.enter) when the building has an
   * interior, the note form and the player's notes and letters for a house, or the post office and
   * hotel services for public buildings. `player_home` opens the mailbox.
   */
  openDoorNote(houseId: LocationId): void;
  /** Open the notice board modal (clicked board in front of the post office). */
  openNoticeBoard(): void;
  /** Open the Keep (clicked `keep_cupboard` inside the post office). */
  openKeep(): void;
  /** Called by the renderer when the user pans away from a scene (null) or a scene is entered. */
  setActiveScene(sceneId: string | null): void;
  /** Replace the decoration/item catalog (otherwise fetched from /api/catalog or built-in defaults). */
  setCatalog(catalog: Partial<Catalog>): void;
  /** Subscribe to selection changes (renderer draws the selection outline). Returns an unsubscribe fn. */
  onSelectionChange(cb: (id: VillagerId | null) => void): () => void;
  /** True while a modal or text field has focus; the renderer should ignore keyboard shortcuts. */
  capturesKeyboard(): boolean;
  destroy(): void;
}
