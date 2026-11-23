import { PLAYER_ID, type Rumor } from '../../shared/types.ts';
import { h, replaceChildren } from './dom.ts';
import { icon } from './icons.ts';
import type { UiStore } from './store.ts';

const MAX_HOPS = 6;

/** Top-left rumor tracker (style guide §8.7): who knows, what was said, and how it spread. */
export function createRumorPanel(store: UiStore): HTMLElement {
  const title = h('div', { class: 'rumor-title', 'data-testid': 'rumor-title' });
  const picker = h('select', { class: 'rumor-picker', 'aria-label': 'Older rumors', hidden: true });
  const origin = h('div', { class: 'rumor-origin', 'data-testid': 'rumor-origin' });
  const hops = h('ul', { class: 'rumor-hops', 'data-testid': 'rumor-hops' });
  let pinned: string | null = null;
  let dismissedKey: string | null = null;
  let shownKey = '';

  const el = h(
    'section',
    { class: 'panel rumor-panel', id: 'rumor-panel', hidden: true, 'data-testid': 'rumor-panel' },
    h(
      'div',
      { class: 'rumor-head' },
      title,
      picker,
      h(
        'button',
        {
          class: 'close',
          'aria-label': 'Dismiss rumor tracker',
          onclick: () => {
            dismissedKey = shownKey;
            el.hidden = true;
          },
        },
        '×',
      ),
    ),
    origin,
    hops,
  );

  picker.addEventListener('change', () => {
    pinned = picker.value || null;
    render();
  });

  const keyOf = (r: Rumor) => `${r.id}:${r.hops.length}`;

  const render = () => {
    const rumors = store.sortedRumors();
    if (rumors.length === 0) {
      el.hidden = true;
      return;
    }
    const rumor = rumors.find((r) => r.id === pinned) ?? rumors[0]!;
    shownKey = keyOf(rumor);
    el.hidden =
      dismissedKey !== null && dismissedKey === keyOf(rumors[0]!) && (!pinned || pinned === rumors[0]!.id);
    if (dismissedKey && dismissedKey !== keyOf(rumors[0]!)) dismissedKey = null;

    const total = store.profiles.size;
    const known = rumor.knownBy.filter((id) => id !== PLAYER_ID && store.profiles.has(id)).length;
    const titleText = ` Rumor · ${known} of ${total} villagers know`;
    if (title.lastChild?.textContent !== titleText) replaceChildren(title, icon('rumor', '🗣️'), titleText);

    picker.hidden = rumors.length < 2;
    replaceChildren(
      picker,
      rumors.map((r) => h('option', { value: r.id, selected: r.id === rumor.id }, truncateText(r.text, 32))),
    );

    replaceChildren(
      origin,
      rumor.startedBy === PLAYER_ID
        ? h('span', { class: 'you-said' }, `You said: “${rumor.text}”`)
        : h('span', null, h('b', null, store.name(rumor.startedBy)), ` started: “${rumor.text}”`),
    );
    const recent = rumor.hops.slice(-MAX_HOPS);
    replaceChildren(
      hops,
      rumor.hops.length > MAX_HOPS
        ? h('li', { class: 'more' }, `… ${rumor.hops.length - MAX_HOPS} earlier`)
        : null,
      recent.map((hop) =>
        h('li', null, h('b', null, `${store.name(hop.from)} → ${store.name(hop.to)}`), ` “${hop.text}”`),
      ),
      rumor.hops.length === 0 ? h('li', { class: 'empty' }, 'nobody has passed it on yet') : null,
    );
  };

  store.subscribe(['rumors', 'villagers', 'hello'], () => {
    const rumors = store.rumors;
    if (rumors.length === 0) return render();
    render();
  });
  return el;
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
