import { NOTE_MAX_LENGTH } from '../../../shared/protocol.ts';
import {
  PLAYER_HOME_ID,
  PLAYER_ID,
  type DoorNote,
  type Letter,
  type Location,
  type LocationId,
} from '../../../shared/types.ts';
import type { UiContext } from '../context.ts';
import { h, replaceChildren, setText } from '../dom.ts';
import { formatClock, formatDay } from '../format.ts';
import { canEnter, POST_OFFICE_ID } from '../places.ts';
import type { ModalView } from './modal.ts';

const STATUS_LABEL: Record<DoorNote['status'], string> = {
  unread: '📄 pinned, not read yet',
  read: '👀 read',
  replied: '✉️ replied',
};

/** Door-note compose + history for a villager's house, or the player's mailbox for `player_home`. */
export function doorNoteModal(ctx: UiContext, houseId: LocationId): ModalView {
  if (houseId === PLAYER_HOME_ID) return mailboxView(ctx);
  const loc = ctx.store.location(houseId);
  if (loc && loc.kind !== 'house') return publicView(ctx, loc);
  return composeView(ctx, houseId);
}
function goInsideButton(ctx: UiContext, locationId: LocationId): HTMLButtonElement {
  return h(
    'button',
    {
      class: 'btn btn-accent',
      'data-testid': 'door-enter',
      onclick: () => {
        const loc = ctx.store.location(locationId);
        if (loc) ctx.walkIn.enter(loc);
        ctx.closeModal();
      },
    },
    '🚪 Go inside',
  );
}

/** Door of a public building (hotel, post office): go inside, and the post office's services. */
function publicView(ctx: UiContext, loc: Location): ModalView {
  const isPost = loc.id === POST_OFFICE_ID;
  return {
    title: loc.name,
    icon: isPost ? ['note', '📮'] : ['home', '🏨'],
    subtitle: loc.hours ? `Open ${loc.hours.open}–${loc.hours.close}` : undefined,
    footer: isPost ? 'Inside: the counter, and the Keep in the cupboard.' : 'Anyone may walk in.',
    className: 'modal-note',
    render(body) {
      replaceChildren(
        body,
        loc.description ? h('p', { class: 'hint' }, loc.description) : null,
        h(
          'div',
          { class: 'row door-actions' },
          canEnter(loc) ? goInsideButton(ctx, loc.id) : null,
          isPost
            ? [
                h(
                  'button',
                  {
                    class: 'btn',
                    'data-testid': 'door-letter',
                    onclick: () => ctx.openModal('letters', 'write'),
                  },
                  '✉️ Write a letter',
                ),
                h(
                  'button',
                  { class: 'btn', 'data-testid': 'door-board', onclick: () => ctx.openModal('notice-board') },
                  '📌 Notice board',
                ),
              ]
            : null,
        ),
      );
    },
  };
}

const LETTER_STATUS: Record<Letter['status'], string> = {
  posted: '📮 posted',
  delivered: '📬 in their mailbox',
  read: '👀 read',
  replied: '✉️ replied',
  returned: '↩️ returned',
};

function when(t: number): string {
  return `${formatDay(t)} ${formatClock(t)}`;
}

function composeView(ctx: UiContext, houseId: LocationId): ModalView {
  const { store, host } = ctx;
  const loc = store.location(houseId);
  const ownerIds = loc?.ownerIds?.length
    ? loc.ownerIds
    : [...store.profiles.values()].filter((p) => p.homeId === houseId).map((p) => p.id);
  const owners = ownerIds.map((id) => store.name(id));
  const ownerLabel = owners.length ? owners.join(' & ') : (loc?.name ?? houseId);
  const textarea = h('textarea', {
    class: 'note-text',
    maxlength: NOTE_MAX_LENGTH,
    rows: 4,
    placeholder: `Write a note for ${ownerLabel}…`,
    'aria-label': 'Note text',
    'data-testid': 'note-text',
  });
  const counter = h('span', { class: 'label note-counter' }, `0 / ${NOTE_MAX_LENGTH}`);
  const status = h('span', { class: 'note-status', role: 'status' });
  const history = h('ul', { class: 'note-history', 'data-testid': 'note-history' });
  let pendingSince: number | null = null;

  const pin = () => {
    const text = textarea.value.trim();
    if (!text) {
      textarea.focus();
      return;
    }
    host.send({ type: 'note.post', houseId, text });
    textarea.value = '';
    setText(counter, `0 / ${NOTE_MAX_LENGTH}`);
    pendingSince = store.notesFor(houseId).length;
    setText(status, 'Pinning…');
  };
  textarea.addEventListener('input', () => setText(counter, `${textarea.value.length} / ${NOTE_MAX_LENGTH}`));
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) pin();
    if (ev.key !== 'Escape') ev.stopPropagation();
  });

  const form = h(
    'div',
    { class: 'note-form' },
    textarea,
    h(
      'div',
      { class: 'row' },
      counter,
      status,
      canEnter(loc) ? goInsideButton(ctx, houseId) : null,
      h('button', { class: 'btn btn-accent', 'data-testid': 'note-pin', onclick: pin }, '📌 Leave a note'),
    ),
  );
  const letterList = h('ul', { class: 'note-history', 'data-testid': 'door-letters' });
  const lettersHere = () =>
    store.playerLetters().filter((l) => l.from === PLAYER_ID && ownerIds.includes(l.to));

  return {
    title: `Note for ${ownerLabel}'s door`,
    icon: ['note', '📮'],
    subtitle: loc?.name,
    footer: 'They read it the next time they come home, and pin a reply on the door.',
    className: 'modal-note',
    key: () => [...store.notesFor(houseId), ...lettersHere()].map((n) => `${n.id}:${n.status}`).join(','),
    render(body) {
      const notes = store.notesFor(houseId).filter((n) => n.authorId === PLAYER_ID);
      const letters = lettersHere();
      replaceChildren(
        letterList,
        letters.map((l) =>
          h(
            'li',
            { class: `note letter letter-${l.status}` },
            h(
              'div',
              { class: 'label' },
              `${when(l.postedAt)} · ✉️ letter to ${store.name(l.to)} · ${LETTER_STATUS[l.status]}`,
            ),
            h('div', { class: 'note-body' }, `“${l.text}”`),
          ),
        ),
      );
      letterList.hidden = letters.length === 0;
      if (pendingSince !== null && store.notesFor(houseId).length > pendingSince) {
        pendingSince = null;
        setText(status, '✓ Pinned');
      }
      replaceChildren(
        history,
        notes.length === 0
          ? h('li', { class: 'empty' }, 'No notes on this door yet.')
          : notes.map((n) =>
              h(
                'li',
                { class: `note note-${n.status}` },
                h('div', { class: 'label' }, `${when(n.postedAt)} · ${STATUS_LABEL[n.status]}`),
                h('div', { class: 'note-body' }, `“${n.text}”`),
                n.reply
                  ? h(
                      'div',
                      { class: 'note-reply' },
                      h('b', null, `${store.name(n.ownerId)}: `),
                      n.reply,
                      n.repliedAt != null ? h('span', { class: 'label' }, ` · ${when(n.repliedAt)}`) : null,
                    )
                  : null,
              ),
            ),
      );
      if (!body.contains(form)) {
        replaceChildren(body, form, h('div', { class: 'label' }, 'Previous notes'), history, letterList);
        textarea.focus();
      }
    },
  };
}

function mailboxView(ctx: UiContext): ModalView {
  const { store } = ctx;
  const inbox = () => store.playerLetters().filter((l) => l.to === PLAYER_ID && l.status !== 'posted');
  return {
    title: 'Your mailbox',
    icon: ['note', '📬'],
    footer: 'Villagers who know you may leave a note once a mailbox is placed at your cottage.',
    className: 'modal-note',
    key: () =>
      `${store.player?.placedDecorations.includes('mailbox')}|` +
      [...store.notesFor(PLAYER_HOME_ID), ...inbox()].map((n) => `${n.id}:${n.status}`).join(','),
    render(body) {
      const notes = store.notesFor(PLAYER_HOME_ID).filter((n) => n.authorId !== PLAYER_ID);
      const letters = inbox();
      const hasMailbox = store.player?.placedDecorations.includes('mailbox') ?? false;
      const items = [
        ...notes.map((n) => ({
          at: n.postedAt,
          el: h(
            'li',
            { class: `note note-${n.status}` },
            h('div', { class: 'label' }, `${when(n.postedAt)} · from ${store.name(n.authorId)}`),
            h('div', { class: 'note-body' }, `“${n.text}”`),
          ),
        })),
        ...letters.map((l) => ({
          at: l.deliveredAt ?? l.postedAt,
          el: h(
            'li',
            { class: `note letter letter-${l.status}${l.status === 'delivered' ? ' unread' : ''}` },
            h(
              'div',
              { class: 'label' },
              `${when(l.deliveredAt ?? l.postedAt)} · ✉️ letter from ${store.name(l.from)}${l.status === 'delivered' ? ' · new' : ''}`,
            ),
            h('div', { class: 'note-body' }, `“${l.text}”`),
          ),
        })),
      ].sort((a, b) => b.at - a.at);
      replaceChildren(
        body,
        hasMailbox
          ? null
          : h('p', { class: 'hint' }, 'Tip: place a 📮 Mailbox (Decorate) so villagers can write to you.'),
        h(
          'ul',
          { class: 'note-history', 'data-testid': 'mailbox' },
          items.length === 0 ? h('li', { class: 'empty' }, 'No letters yet.') : items.map((i) => i.el),
        ),
        letters.length
          ? h(
              'button',
              {
                class: 'btn',
                'data-testid': 'mailbox-letters',
                onclick: () => ctx.openModal('letters', 'inbox'),
              },
              '✉️ Open Letters',
            )
          : null,
      );
    },
  };
}
