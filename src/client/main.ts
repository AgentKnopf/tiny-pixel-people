import { connect } from './net.ts';
import { loadFonts } from './render/fonts.ts';
import { WorldRenderer } from './render/renderer.ts';
import { HOME_SCENE_ID } from './render/scenes.ts';
import { GameStore, type ClientApp } from './state.ts';
import { mountUi } from './ui/index.ts';

declare global {
  interface Window {
    tpp?: ClientApp;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const store = new GameStore();
const renderer = new WorldRenderer(canvas, store);

let net: ReturnType<typeof connect> | null = null;
const ui = mountUi(document.querySelector<HTMLElement>('#ui')!, {
  send: (m) => net?.send(m),
  camera: {
    zoomIn: () => renderer.zoomIn(),
    zoomOut: () => renderer.zoomOut(),
    fit: () => renderer.fit(),
    showScene: (id) => renderer.showScene(id),
    followVillager: (id) => renderer.followVillager(id),
    focusTile: (tile) => renderer.focusTile(tile),
  },
});

net = connect(
  (msg) => {
    store.apply(msg, performance.now());
    ui.handleMessage(msg);
  },
  (status, text) => {
    store.setConnection(status, text);
    ui.setConnectionStatus(status);
  },
);
window.tpp = { store, net, renderer };

renderer.on('villager', (id) => ui.selectVillager(id));
// selectAnimal / openNoticeBoard / openKeep join UiController with WP4b's v2 panels.
const uiV2 = ui as typeof ui & {
  selectAnimal?(id: string | null): void;
  openNoticeBoard?(): void;
  openKeep?(): void;
};
renderer.on('animal', (id) => uiV2.selectAnimal?.(id));
renderer.on('door', ({ houseId }) => ui.openDoorNote(houseId));
renderer.on('ground', ({ tile, blocked }) => {
  if (!blocked) net?.send({ type: 'player.move', to: tile });
});
renderer.on('scene', (id) => ui.setActiveScene(id));
renderer.on('userPan', () => ui.setActiveScene(null));
ui.onSelectionChange((id) => store.select(id));

window.addEventListener('keydown', (ev) => {
  if (ui.capturesKeyboard() || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  switch (ev.key) {
    case '+':
    case '=':
      renderer.zoomIn();
      break;
    case '-':
    case '_':
      renderer.zoomOut();
      break;
    case '0':
      renderer.fit();
      break;
    case 'h':
      renderer.showScene(HOME_SCENE_ID);
      break;
    default:
      return;
  }
  ev.preventDefault();
});

void loadFonts().finally(() => renderer.start());
