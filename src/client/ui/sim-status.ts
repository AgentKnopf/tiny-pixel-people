import { h, setText } from './dom.ts';
import { icon } from './icons.ts';
import type { UiStore } from './store.ts';

/**
 * The server repeats `sim.status` every 2 s while waking up or planning; if the final `running`
 * message is lost (e.g. a reconnect), the banner hides itself once updates stop arriving.
 */
export const SIM_STATUS_STALE_MS = 8000;

/**
 * Top-centre pill for the villagers' day plans: while the clock holds at 06:00 ('wakingUp'), or
 * while it runs and some plans are still on the way ('planning').
 */
export function createSimStatusBanner(store: UiStore): HTMLElement {
  const text = h('span', { class: 'sim-status-text', 'data-testid': 'sim-status-text' });
  const fill = h('div', { class: 'sim-status-fill' });
  const el = h(
    'div',
    {
      class: 'sim-status',
      id: 'sim-status',
      'data-testid': 'sim-status',
      role: 'status',
      'aria-live': 'polite',
      hidden: true,
    },
    icon('sun', '🌅'),
    text,
    h('div', { class: 'sim-status-track', 'aria-hidden': 'true' }, fill),
  );

  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  const render = () => {
    clearTimeout(staleTimer);
    const s = store.simStatus;
    const total = Math.max(0, s?.villagers ?? 0);
    const ready = Math.min(Math.max(0, s?.plansReady ?? 0), total);
    const pending = total - ready;
    const show =
      !!s &&
      (s.phase === 'wakingUp' || (s.phase === 'planning' && pending > 0)) &&
      store.connection !== 'disconnected';
    el.hidden = !show;
    if (!s || !show) return;
    el.dataset.phase = s.phase;
    setText(
      text,
      s.phase === 'planning'
        ? `${pending} villager${pending === 1 ? '' : 's'} still planning`
        : `Villagers are waking up… (${ready}/${total} plans ready)`,
    );
    fill.style.width = `${total ? Math.round((ready / total) * 100) : 0}%`;
    staleTimer = setTimeout(() => {
      el.hidden = true;
    }, SIM_STATUS_STALE_MS);
  };
  store.subscribe(['sim', 'connection'], render);
  render();
  return el;
}
