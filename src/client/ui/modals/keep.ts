import { KEEP_PAGE_MAX } from '../../../shared/protocol.ts';
import type { KeepEntryKind } from '../../../shared/types.ts';
import type { UiContext } from '../context.ts';
import { h, replaceChildren, setText } from '../dom.ts';
import { formatWhen } from '../format.ts';
import { insidePostOffice } from '../places.ts';
import type { ModalView } from './modal.ts';

export const KEEP_PAGE_SIZE = Math.min(20, KEEP_PAGE_MAX);

const KIND_LABEL: Record<KeepEntryKind, string> = {
  note: '📮 note',
  letter: '✉️ letter',
  notice: '📌 notice',
  rumor: '🗣️ rumor',
  reply: '↩️ reply',
};

/**
 * The Keep (spec v2 §8.4): Laude's archive of every note, letter, notice and rumor, read in the
 * post office. Search box, kind filter and paging; new `keep.added` entries appear on page one.
 */
export function keepModal(ctx: UiContext): ModalView {
  const { store, host } = ctx;
  const search = h('input', {
    type: 'search',
    class: 'keep-search',
    placeholder: 'Search the Keep…',
    'aria-label': 'Search the Keep',
    'data-testid': 'keep-search',
  });
  const kind = h(
    'select',
    { class: 'keep-kind', 'aria-label': 'Kind', 'data-testid': 'keep-kind' },
    h('option', { value: '' }, 'Everything'),
    (Object.keys(KIND_LABEL) as KeepEntryKind[]).map((k) => h('option', { value: k }, KIND_LABEL[k])),
  );
  const list = h('ul', { class: 'keep-entries', 'data-testid': 'keep-entries' });
  const pageInfo = h('span', { class: 'label', 'data-testid': 'keep-page' });
  const prev = h(
    'button',
    { class: 'btn', 'data-testid': 'keep-prev', onclick: () => load(offset - KEEP_PAGE_SIZE) },
    '‹ Newer',
  );
  const next = h(
    'button',
    { class: 'btn', 'data-testid': 'keep-next', onclick: () => load(offset + KEEP_PAGE_SIZE) },
    'Older ›',
  );
  let offset = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const load = (at: number) => {
    offset = Math.max(0, at);
    const query = search.value.trim();
    const k = kind.value as KeepEntryKind | '';
    store.setKeepFilter({ query, kind: k || undefined, offset, limit: KEEP_PAGE_SIZE });
    if (!insidePostOffice(store)) return;
    host.send({
      type: 'keep.open',
      ...(query ? { query } : {}),
      ...(k ? { kind: k } : {}),
      offset,
      limit: KEEP_PAGE_SIZE,
    });
  };
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => load(0), 250);
  });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      clearTimeout(debounce);
      load(0);
    }
    // Escape still has to reach the window handler that closes the modal.
    if (ev.key !== 'Escape') ev.stopPropagation();
  });
  kind.addEventListener('change', () => load(0));
  store.keep = null;
  let requested = false;
  const ensureLoaded = () => {
    if (requested || !insidePostOffice(store)) return;
    requested = true;
    load(0);
  };

  return {
    title: 'The Keep',
    icon: ['note', '📒'],
    subtitle: "Laude's archive",
    footer: 'Every note, letter, notice and rumor in the village, newest first.',
    className: 'modal-keep',
    key: () => {
      const k = store.keep;
      return `${insidePostOffice(store)}|${k ? `${k.offset}:${k.total}:${k.entries.map((e) => e.id).join(',')}` : 'none'}`;
    },
    render(body) {
      ensureLoaded();
      if (!insidePostOffice(store)) {
        replaceChildren(
          body,
          h(
            'p',
            { class: 'hint', 'data-testid': 'keep-hint' },
            '📒 The Keep lives in the cupboard at the post office. Go inside to read it.',
          ),
        );
        return;
      }
      const page = store.keep;
      replaceChildren(
        list,
        !page
          ? h('li', { class: 'empty' }, 'Opening the cupboard…')
          : page.entries.length === 0
            ? h('li', { class: 'empty' }, 'Nothing in the Keep matches.')
            : page.entries.map((e) =>
                h(
                  'li',
                  { class: `keep-entry keep-${e.kind}`, 'data-keep': e.id },
                  h(
                    'div',
                    { class: 'label' },
                    `${formatWhen(e.at, store.time)} · ${KIND_LABEL[e.kind]} · ${store.name(e.authorId)}${
                      e.recipientId ? ` → ${store.name(e.recipientId)}` : ''
                    }`,
                  ),
                  h('div', { class: 'keep-text' }, e.text),
                ),
              ),
      );
      const total = page?.total ?? 0;
      const start = page && total ? page.offset + 1 : 0;
      const end = page ? page.offset + page.entries.length : 0;
      setText(pageInfo, total ? `${start}–${end} of ${total}` : '');
      prev.disabled = !page || page.offset === 0;
      next.disabled = !page || end >= total;
      if (!body.contains(search)) {
        replaceChildren(
          body,
          h('div', { class: 'row keep-controls' }, search, kind),
          list,
          h('div', { class: 'row keep-paging' }, prev, pageInfo, next),
        );
        search.focus();
      }
    },
  };
}
