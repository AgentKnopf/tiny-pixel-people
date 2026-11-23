import { NOTE_MAX_LENGTH } from '../../../shared/protocol.ts';
import { PLAYER_ID, type Letter, type VillagerId } from '../../../shared/types.ts';
import type { UiContext } from '../context.ts';
import { h, replaceChildren, setText } from '../dom.ts';
import { formatWhen } from '../format.ts';
import { canSendLetters } from '../places.ts';
import type { ModalView } from './modal.ts';

export type LettersTab = 'inbox' | 'sent' | 'write';

const SENT_STATUS: Record<Letter['status'], string> = {
  posted: '📮 posted, waiting for the next delivery round',
  delivered: '📬 delivered',
  read: '👀 read',
  replied: '✉️ replied',
  returned: '↩️ returned: moved away',
};

/** Letters modal (spec v2 §8.1, opened from the dock): inbox, sent, and "Write a letter". */
export function lettersModal(ctx: UiContext, initial: LettersTab = 'inbox'): ModalView {
  const { store, host } = ctx;
  let tab: LettersTab = initial;
  let status = '';
  const select = h('select', { class: 'letter-to', 'data-testid': 'letter-to', 'aria-label': 'Recipient' });
  const textarea = h('textarea', {
    class: 'note-text',
    maxlength: NOTE_MAX_LENGTH,
    rows: 5,
    placeholder: 'Dear …',
    'aria-label': 'Letter text',
    'data-testid': 'letter-text',
  });
  const counter = h('span', { class: 'label note-counter' }, `0 / ${NOTE_MAX_LENGTH}`);
  textarea.addEventListener('input', () => setText(counter, `${textarea.value.length} / ${NOTE_MAX_LENGTH}`));
  textarea.addEventListener('keydown', (ev) => ev.stopPropagation());

  const send = () => {
    const to = select.value as VillagerId;
    const text = textarea.value.trim();
    if (!to || !text || !canSendLetters(store)) {
      textarea.focus();
      return;
    }
    host.send({ type: 'letter.send', to, text });
    textarea.value = '';
    setText(counter, `0 / ${NOTE_MAX_LENGTH}`);
    status = `✓ Posted to ${store.name(to)}. Laude will deliver it on the next round.`;
    tab = 'sent';
    ctx.refreshModal();
  };

  const letterItem = (l: Letter, incoming: boolean) =>
    h(
      'li',
      {
        class: `note letter letter-${l.status}${incoming && l.status === 'delivered' ? ' unread' : ''}`,
        'data-letter': l.id,
      },
      h(
        'div',
        { class: 'label' },
        `${formatWhen(l.deliveredAt ?? l.postedAt, store.time)} · ${
          incoming ? `from ${store.name(l.from)}` : `to ${store.name(l.to)} · ${SENT_STATUS[l.status]}`
        }`,
      ),
      h('div', { class: 'note-body' }, `“${l.text}”`),
      incoming && l.status === 'delivered'
        ? h(
            'button',
            {
              class: 'btn',
              'data-testid': `letter-read-${l.id}`,
              onclick: () => host.send({ type: 'letter.read', letterId: l.id }),
            },
            '👀 Mark as read',
          )
        : null,
    );

  return {
    title: 'Letters',
    icon: ['note', '✉️'],
    subtitle: 'Post office',
    footer: 'Letters go out at the post office and are delivered twice a day.',
    className: 'modal-note modal-letters',
    key: () =>
      `${tab}|${status}|${canSendLetters(store)}|${store.profiles.size}|` +
      store
        .playerLetters()
        .map((l) => `${l.id}:${l.status}`)
        .join(','),
    render(body) {
      const all = store.playerLetters();
      const inbox = all.filter((l) => l.to === PLAYER_ID && l.status !== 'posted');
      const sent = all.filter((l) => l.from === PLAYER_ID);
      const unread = inbox.filter((l) => l.status === 'delivered').length;
      const tabBtn = (id: LettersTab, label: string) =>
        h(
          'button',
          {
            class: `seg${tab === id ? ' active' : ''}`,
            'data-testid': `letters-tab-${id}`,
            'aria-pressed': String(tab === id),
            onclick: () => {
              tab = id;
              ctx.refreshModal();
            },
          },
          label,
        );
      const tabs = h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Letters' },
        tabBtn('inbox', unread ? `Inbox (${unread})` : 'Inbox'),
        tabBtn('sent', 'Sent'),
        tabBtn('write', 'Write a letter'),
      );

      let content: HTMLElement;
      if (tab === 'write') {
        const prev = select.value;
        replaceChildren(
          select,
          store.villagerIds().map((id) => {
            const p = store.profiles.get(id)!;
            return h(
              'option',
              { value: id, selected: id === prev },
              `${p.name} · ${p.visitor ? 'visitor at the hotel' : p.occupation}`,
            );
          }),
        );
        const allowed = canSendLetters(store);
        content = h(
          'div',
          { class: 'note-form', 'data-testid': 'letter-form' },
          h('label', { class: 'label' }, 'To ', select),
          textarea,
          h(
            'div',
            { class: 'row' },
            counter,
            h(
              'span',
              { class: 'note-status', role: 'status', 'data-testid': 'letter-hint' },
              allowed ? '' : 'Walk to the post office (or its post box) to send letters.',
            ),
            h(
              'button',
              { class: 'btn btn-accent', 'data-testid': 'letter-send', disabled: !allowed, onclick: send },
              '📮 Send',
            ),
          ),
        );
      } else {
        const list = tab === 'inbox' ? inbox : sent;
        content = h(
          'ul',
          { class: 'note-history', 'data-testid': `letters-${tab}` },
          list.length === 0
            ? h(
                'li',
                { class: 'empty' },
                tab === 'inbox' ? 'No letters yet.' : 'You have not sent any letters.',
              )
            : list.map((l) => letterItem(l, tab === 'inbox')),
        );
      }
      replaceChildren(body, tabs, status ? h('p', { class: 'hint', role: 'status' }, status) : null, content);
      if (tab === 'write') textarea.focus();
    },
  };
}
