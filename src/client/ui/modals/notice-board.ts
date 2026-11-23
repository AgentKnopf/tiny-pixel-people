import { NOTICE_MAX_LENGTH } from '../../../shared/protocol.ts';
import { PLAYER_ID } from '../../../shared/types.ts';
import type { UiContext } from '../context.ts';
import { h, replaceChildren, setText } from '../dom.ts';
import { formatWhen } from '../format.ts';
import { nearNoticeBoard } from '../places.ts';
import type { ModalView } from './modal.ts';

/** Notice board modal (spec v2 §8.2): active notices, and "Post a notice" near the board. */
export function noticeBoardModal(ctx: UiContext): ModalView {
  const { store, host } = ctx;
  const textarea = h('textarea', {
    class: 'note-text',
    maxlength: NOTICE_MAX_LENGTH,
    rows: 3,
    placeholder: 'Lost: one striped scarf, near the fountain…',
    'aria-label': 'Notice text',
    'data-testid': 'notice-text',
  });
  const counter = h('span', { class: 'label note-counter' }, `0 / ${NOTICE_MAX_LENGTH}`);
  const status = h('span', { class: 'note-status', role: 'status', 'data-testid': 'notice-status' });
  textarea.addEventListener('input', () =>
    setText(counter, `${textarea.value.length} / ${NOTICE_MAX_LENGTH}`),
  );
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') ev.stopPropagation();
  });
  const postBtn = h(
    'button',
    {
      class: 'btn btn-accent',
      'data-testid': 'notice-post',
      onclick: () => {
        const text = textarea.value.trim();
        if (!text || !nearNoticeBoard(store)) {
          textarea.focus();
          return;
        }
        host.send({ type: 'notice.post', text });
        textarea.value = '';
        setText(counter, `0 / ${NOTICE_MAX_LENGTH}`);
        setText(status, '📌 Pinning…');
      },
    },
    '📌 Post a notice',
  );
  const form = h(
    'div',
    { class: 'note-form', 'data-testid': 'notice-form' },
    textarea,
    h('div', { class: 'row' }, counter, status, postBtn),
  );
  const list = h('ul', { class: 'note-history notices', 'data-testid': 'notices' });

  return {
    title: 'Notice board',
    icon: ['pin', '📌'],
    subtitle: 'In front of the post office',
    footer: 'Villagers who pass the board read every notice and talk about them.',
    className: 'modal-note modal-notices',
    key: () =>
      `${nearNoticeBoard(store)}|` +
      store
        .sortedNotices()
        .map((n) => n.id)
        .join(','),
    render(body) {
      const notices = store.sortedNotices();
      if (status.textContent === '📌 Pinning…' && notices.some((n) => n.authorId === PLAYER_ID)) {
        setText(status, '✓ Posted');
      }
      replaceChildren(
        list,
        notices.length === 0
          ? h('li', { class: 'empty' }, 'The board is empty.')
          : notices.map((n) =>
              h(
                'li',
                { class: `note notice${n.authorId === PLAYER_ID ? ' mine' : ''}`, 'data-notice': n.id },
                h(
                  'div',
                  { class: 'label' },
                  `${formatWhen(n.postedAt, store.time)} · ${n.authorId === PLAYER_ID ? 'you' : store.name(n.authorId)} · until ${formatWhen(n.expiresAt, store.time)}`,
                ),
                h('div', { class: 'note-body' }, n.text),
              ),
            ),
      );
      const near = nearNoticeBoard(store);
      replaceChildren(
        body,
        list,
        near
          ? form
          : h('p', { class: 'hint', 'data-testid': 'notice-hint' }, 'Walk up to the board to post a notice.'),
      );
    },
  };
}
