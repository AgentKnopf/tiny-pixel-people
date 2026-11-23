import { h } from './dom.ts';
import type { UiStore } from './store.ts';

const TOAST_MS = 3000;
const MAX_TOASTS = 3;

/** Bottom-centre stack of short-lived pills. */
export function createToasts(store: UiStore): HTMLElement {
  const el = h('div', { class: 'toasts', id: 'toasts', role: 'status', 'aria-live': 'polite' });
  store.onToast(({ icon, text }) => {
    const t = h('div', { class: 'toast' }, h('span', { class: 'icon' }, icon), h('span', null, text));
    el.append(t);
    while (el.children.length > MAX_TOASTS) el.firstElementChild?.remove();
    setTimeout(() => {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 300);
    }, TOAST_MS);
  });
  return el;
}
