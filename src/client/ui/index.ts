import type { ServerMessage } from '../../shared/protocol.ts';
import type { LocationId, VillagerId } from '../../shared/types.ts';
import { createAnimalCard } from './animal-card.ts';
import { createChatDialog } from './chat-dialog.ts';
import type { ModalKind, UiContext } from './context.ts';
import { h } from './dom.ts';
import { createDock } from './dock.ts';
import { createHud } from './hud.ts';
import { createInspector } from './inspector.ts';
import { loadIconSheet } from './icons.ts';
import { createLlmCard } from './llm-card.ts';
import { backpackModal } from './modals/backpack.ts';
import { decorateModal } from './modals/decorate.ts';
import { doorNoteModal } from './modals/door-note.ts';
import { mapModal } from './modals/map.ts';
import { ModalHost, type ModalView } from './modals/modal.ts';
import { petModal } from './modals/pet.ts';
import { createRumorPanel } from './rumor-panel.ts';
import { createSimStatusBanner } from './sim-status.ts';
import { createStatsCard } from './stats.ts';
import { UiStore, type Topic } from './store.ts';
import { createToasts } from './toasts.ts';
import { createToolbar } from './toolbar.ts';
import type { Catalog, ConnectionState, UiController, UiHost } from './types.ts';

export type { CameraControls, Catalog, ConnectionState, UiController, UiHost } from './types.ts';
export { UiStore } from './store.ts';

const ALL_TOPICS: Topic[] = [
  'hello',
  'player',
  'notes',
  'scene',
  'selection',
  'catalog',
  'villagers',
  'rumors',
  'events',
];

/** Interprets the free-text status strings from net.ts as well as plain ConnectionState values. */
export function parseConnectionStatus(status: string): ConnectionState {
  const s = status.toLowerCase();
  if (s.includes('disconnect') || s.includes('retry') || s.includes('closed') || s.includes('offline')) {
    return 'disconnected';
  }
  if (s.startsWith('connected')) return 'connected';
  return 'connecting';
}

function defaultDownload(url: string, filename: string): void {
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
}

/** Build every HTML panel inside `root` and return the controller main.ts talks to. */
export function mountUi(root: HTMLElement, host: UiHost, store: UiStore = new UiStore()): UiController {
  const apiBase = host.apiBase ?? '';
  const selectionListeners = new Set<(id: VillagerId | null) => void>();

  const modals: ModalHost = new ModalHost(() => ctx.closeModal());
  const ctx: UiContext = {
    store,
    host,
    select(id) {
      if (id) store.selectAnimal(null);
      if (id === store.selectedId) return;
      if (store.selectedId) host.send({ type: 'inspect', villagerId: null });
      store.select(id);
      if (id) host.send({ type: 'inspect', villagerId: id });
      for (const cb of selectionListeners) cb(id);
    },
    openModal(kind: ModalKind, houseId?: LocationId) {
      const views: Record<ModalKind, () => ModalView> = {
        map: () => mapModal(ctx),
        decorate: () => decorateModal(ctx),
        backpack: () => backpackModal(ctx),
        pet: () => petModal(ctx),
        'door-note': () => doorNoteModal(ctx, houseId ?? 'player_home'),
      };
      modals.open(views[kind]());
    },
    closeModal() {
      modals.close();
    },
    saveReplay() {
      host.send({ type: 'save' });
      store.toast('💾', 'Saving replay…');
      setTimeout(() => (host.download ?? defaultDownload)(`${apiBase}/api/replay`, 'replay.jsonl'), 1000);
    },
  };

  root.classList.add('ui-root');
  root.append(
    h('div', { class: 'ui-top-left' }, createHud(store), createRumorPanel(store)),
    h('div', { class: 'ui-top-right' }, createStatsCard(store)),
    h('div', { class: 'ui-bottom-left' }, createLlmCard(store), createToolbar(ctx)),
    h('div', { class: 'ui-bottom-right' }, createDock(ctx)),
    createSimStatusBanner(store),
    createInspector(ctx),
    createAnimalCard(store, () => store.selectAnimal(null)),
    createChatDialog(store),
    createToasts(store),
    modals.el,
  );

  // The inspector and animal card sit below the stats card, whose height varies (train line, items).
  const topRight = root.querySelector<HTMLElement>('.ui-top-right')!;
  const syncTopRight = () =>
    root.style.setProperty('--top-right-bottom', `${Math.round(topRight.getBoundingClientRect().bottom)}px`);
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(syncTopRight) : null;
  resizeObserver?.observe(topRight);
  const unsubs = [
    store.subscribe(ALL_TOPICS, () => modals.refresh()),
    // Re-subscribe the inspector after a reconnect (the server forgets subscriptions).
    store.subscribe(['hello'], () => {
      if (store.selectedId) host.send({ type: 'inspect', villagerId: store.selectedId });
    }),
  ];

  const isTyping = () => {
    const a = document.activeElement;
    return !!a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      if (modals.isOpen) ctx.closeModal();
      else if (store.chat.length) store.closeChat();
      else if (store.selectedId) ctx.select(null);
      else if (store.selectedAnimalId) store.selectAnimal(null);
      else return;
      ev.preventDefault();
      return;
    }
    if (ev.key === ' ' && !isTyping() && !modals.isOpen && !ev.repeat) {
      root.querySelector<HTMLButtonElement>('[data-testid="btn-pause"]')?.click();
      ev.preventDefault();
    }
  };
  window.addEventListener('keydown', onKey);

  void loadIconSheet(root, apiBase);

  void fetch(`${apiBase}/api/catalog`)
    .then((r) => (r.ok ? (r.json() as Promise<Partial<Catalog>>) : null))
    .then((c) => {
      if (c && (Array.isArray(c.items) || Array.isArray(c.decorations))) store.setCatalog(c);
    })
    .catch(() => undefined);

  return {
    handleMessage: (msg: ServerMessage) => store.apply(msg),
    setConnectionStatus: (status: string) => store.setConnection(parseConnectionStatus(status)),
    selectVillager: (id) => ctx.select(id),
    selectAnimal(id) {
      if (id) ctx.select(null);
      store.selectAnimal(id);
    },
    openDoorNote: (houseId) => ctx.openModal('door-note', houseId),
    setActiveScene: (id) => store.setScene(id),
    setCatalog: (c) => store.setCatalog(c),
    onSelectionChange(cb) {
      selectionListeners.add(cb);
      return () => selectionListeners.delete(cb);
    },
    capturesKeyboard: () => modals.isOpen || isTyping(),
    destroy() {
      window.removeEventListener('keydown', onKey);
      resizeObserver?.disconnect();
      unsubs.forEach((u) => u());
      root.replaceChildren();
    },
  };
}
