import { PLAYER_HOME_ID } from '../../shared/types.ts';
import type { UiContext } from './context.ts';
import { h, setText } from './dom.ts';
import { icon } from './icons.ts';

interface Tile {
  el: HTMLButtonElement;
  sub: HTMLElement;
  badge: HTMLElement;
}

function tile(sprite: string, emoji: string, label: string, testid: string, onclick: () => void): Tile {
  const sub = h('span', { class: 'dock-sub' });
  const badge = h('span', { class: 'dock-badge', hidden: true });
  const el = h(
    'button',
    { class: 'dock-tile', 'data-testid': testid, onclick },
    badge,
    h('span', { class: 'dock-icon' }, icon(sprite, emoji)),
    h('span', { class: 'dock-label' }, label),
    sub,
  );
  return { el, sub, badge };
}

/** Bottom-right dock: Backpack, Map, Pet, Decorate, Home, Mail, Gold. */
export function createDock(ctx: UiContext): HTMLElement {
  const { store, host } = ctx;
  const backpack = tile('backpack', '🎒', 'Backpack', 'dock-backpack', () => ctx.openModal('backpack'));
  const map = tile('map', '🗺️', 'Map', 'dock-map', () => ctx.openModal('map'));
  const pet = tile('paw', '🐾', 'Pet', 'dock-pet', () => ctx.openModal('pet'));
  const decorate = tile('decorate', '🛋️', 'Decorate', 'dock-decorate', () => ctx.openModal('decorate'));
  const home = tile('home', '🏠', 'Home', 'dock-home', () => {
    host.camera?.showScene?.('home');
    store.setScene('home');
  });
  const mail = tile('note', '📬', 'Mail', 'dock-mail', () => ctx.openModal('door-note', PLAYER_HOME_ID));
  const gold = tile('coin', '🪙', 'Gold', 'dock-gold', () => ctx.openModal('backpack'));
  setText(decorate.sub, 'Your cottage');
  setText(home.sub, 'Your cottage');

  const el = h(
    'nav',
    { class: 'dock', id: 'dock', 'aria-label': 'Dock' },
    [backpack, map, pet, decorate, home, mail, gold].map((t) => t.el),
  );

  const render = () => {
    const p = store.player;
    const items = (p?.inventory ?? []).reduce((n, e) => n + e.count, 0);
    setText(backpack.sub, `${items} item${items === 1 ? '' : 's'}`);
    setText(gold.sub, `${p?.gold ?? 0} gold`);
    setText(pet.sub, p?.pet.name ?? 'Pip');
    const scene = store.map?.scenes.find((s) => s.id === store.activeScene);
    setText(map.sub, `Scene: ${scene?.name ?? (store.activeScene ? store.activeScene : 'free')}`);
    const unread = store.unreadMail();
    setText(mail.sub, unread ? `${unread} new` : 'Mailbox');
    setText(mail.badge, String(unread));
    mail.badge.hidden = unread === 0;
  };
  store.subscribe(['player', 'scene', 'notes', 'hello', 'catalog'], render);
  render();
  return el;
}
