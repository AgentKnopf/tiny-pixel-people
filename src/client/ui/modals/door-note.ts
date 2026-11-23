import { NOTE_MAX_LENGTH } from '../../../shared/protocol.ts';
import { PLAYER_HOME_ID, PLAYER_ID, type DoorNote, type LocationId } from '../../../shared/types.ts';
import type { UiContext } from '../context.ts';
import { h, replaceChildren, setText } from '../dom.ts';
import { formatClock, formatDay } from '../format.ts';
import type { ModalView } from './modal.ts';

const STATUS_LABEL: Record<DoorNote['status'], string> = {
  unread: '📄 pinned, not read yet',
  read: '👀 read',
  replied: '✉️ replied',
};

/** Door-note compose + history for a villager's house, or the player's mailbox for `player_home`. */
export function doorNoteModal(ctx: UiContext, houseId: LocationId): ModalView {
  return houseId === PLAYER_HOME_ID ? mailboxView(ctx) : composeView(ctx, houseId);
}

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
    ev.stopPropagation();
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
      h('button', { class: 'btn btn-accent', 'data-testid': 'note-pin', onclick: pin }, '📌 Pin note'),
    ),
  );

  return {
    title: `📮 Note for ${ownerLabel}'s door`,
    subtitle: loc?.name,
    footer: 'They read it the next time they come home, and pin a reply on the door.',
    className: 'modal-note',
    key: () =>
      store
        .notesFor(houseId)
        .map((n) => `${n.id}:${n.status}`)
        .join(','),
    render(body) {
      const notes = store.notesFor(houseId).filter((n) => n.authorId === PLAYER_ID);
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
        replaceChildren(body, form, h('div', { class: 'label' }, 'Previous notes'), history);
        textarea.focus();
      }
    },
  };
}

function mailboxView(ctx: UiContext): ModalView {
  const { store } = ctx;
  return {
    title: '📬 Your mailbox',
    footer: 'Villagers who know you may leave a note once a mailbox is placed at your cottage.',
    className: 'modal-note',
    key: () =>
      `${store.player?.placedDecorations.includes('mailbox')}|` +
      store
        .notesFor(PLAYER_HOME_ID)
        .map((n) => `${n.id}:${n.status}`)
        .join(','),
    render(body) {
      const notes = store.notesFor(PLAYER_HOME_ID).filter((n) => n.authorId !== PLAYER_ID);
      const hasMailbox = store.player?.placedDecorations.includes('mailbox') ?? false;
      replaceChildren(
        body,
        hasMailbox
          ? null
          : h('p', { class: 'hint' }, 'Tip: place a 📮 Mailbox (Decorate) so villagers can write to you.'),
        h(
          'ul',
          { class: 'note-history', 'data-testid': 'mailbox' },
          notes.length === 0
            ? h('li', { class: 'empty' }, 'No letters yet.')
            : notes.map((n) =>
                h(
                  'li',
                  { class: `note note-${n.status}` },
                  h('div', { class: 'label' }, `${when(n.postedAt)} · from ${store.name(n.authorId)}`),
                  h('div', { class: 'note-body' }, `“${n.text}”`),
                ),
              ),
        ),
      );
    },
  };
}
