import { PLAYER_ID } from '../../shared/types.ts';
import { h, replaceChildren } from './dom.ts';
import type { UiStore } from './store.ts';

const AUTO_CLOSE_MS = 12_000;

/** Bottom-centre dialog for player ↔ villager exchanges ("You ask Gilda: …" / "Gilda is deciding…"). */
export function createChatDialog(store: UiStore): HTMLElement {
  const body = h('div', { class: 'chat-lines' });
  const el = h(
    'div',
    { class: 'panel chat-dialog', id: 'chat-dialog', hidden: true, 'data-testid': 'chat-dialog' },
    h('button', { class: 'close', 'aria-label': 'Close', onclick: () => store.closeChat() }, '×'),
    body,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;

  store.subscribe(['chat'], () => {
    clearTimeout(timer);
    el.hidden = store.chat.length === 0;
    replaceChildren(
      body,
      store.chat.map((l) =>
        l.pending
          ? h('div', { class: 'chat-line pending' }, l.text)
          : h(
              'div',
              { class: 'chat-line' },
              h(
                'span',
                { class: 'chat-who' },
                l.from === PLAYER_ID ? `You → ${store.name(l.to)}:` : `${store.name(l.from)}:`,
              ),
              ' ',
              h('span', { class: l.from === PLAYER_ID ? 'chat-you' : 'chat-them' }, l.text),
            ),
      ),
    );
    if (store.chat.length && !store.chat.some((l) => l.pending)) {
      timer = setTimeout(() => store.closeChat(), AUTO_CLOSE_MS);
    }
  });
  return el;
}
