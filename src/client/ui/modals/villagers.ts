import type { VillagerProfilePublic } from '../../../shared/protocol.ts';
import type { Needs, Rect, VillagerId, VillagerStatus, WorldMap } from '../../../shared/types.ts';
import type { UiContext } from '../context.ts';
import { h, replaceChildren, setText } from '../dom.ts';
import { findVillager } from '../find-villager.ts';
import type { UiStore } from '../store.ts';
import type { ModalView } from './modal.ts';

/** One roster line, derived only from data the client already has. */
export interface RosterRow {
  id: VillagerId;
  name: string;
  role: string;
  kind: 'resident' | 'visitor' | 'stranger';
  where: string;
  doing: string;
  /** Only for the inspected villager (live `inspect.data`); other villagers have no fresh needs. */
  mood: string;
}

const KIND_EMOJI: Record<RosterRow['kind'], string> = { resident: '🙂', visitor: '🧳', stranger: '🎩' };

/** Code-unit order (like `compareIds`), so the list doesn't depend on the browser's locale. */
const byName = (a: VillagerProfilePublic, b: VillagerProfilePublic) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Same words as the observer API's mood. */
export function moodFromNeeds(status: VillagerStatus, n: Needs): string {
  if (status === 'sleeping') return 'asleep';
  const low: [keyof Needs, string][] = [
    ['energy', 'tired'],
    ['hunger', 'hungry'],
    ['social', 'lonely'],
    ['fun', 'bored'],
  ];
  const worst = low.reduce((a, b) => (n[b[0]] < n[a[0]] ? b : a));
  if (n[worst[0]] < 25) return worst[1];
  const avg = (n.hunger + n.energy + n.social + n.fun) / 4;
  if (avg >= 75) return 'happy';
  if (avg >= 50) return 'content';
  return 'meh';
}

const inRect = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

const tileKey = (x: number, y: number) => y * 100000 + x;

/**
 * Tile -> place name: the first location (map order) whose area contains the tile; else, unless the
 * villager is walking, the first location with a spot, entry or door on that tile (villagers "inside"
 * a house or shop stand on its spots in front of it); else "outside". Cached per map.
 */
function placeLookup(): (map: WorldMap | null, tx: number, ty: number, walking: boolean) => string {
  let forMap: WorldMap | null = null;
  let cache = new Map<number, string>();
  let standing = new Map<number, string>();
  return (map, tx, ty, walking) => {
    if (!map) return '';
    if (map !== forMap) {
      forMap = map;
      cache = new Map();
      standing = new Map();
      for (const l of map.locations) {
        for (const p of [...(l.spots ?? []), l.entry, l.door]) {
          if (p && !standing.has(tileKey(p.x, p.y))) standing.set(tileKey(p.x, p.y), l.name);
        }
      }
    }
    const k = tileKey(tx, ty);
    let area = cache.get(k);
    if (area === undefined) {
      area = map.locations.find((l) => inRect(l.area, tx, ty))?.name ?? '';
      cache.set(k, area);
    }
    return area || (walking ? undefined : standing.get(k)) || 'outside';
  };
}

const sortedProfiles = (store: UiStore) => [...store.profiles.values()].sort(byName);

function inspectedMood(store: UiStore, id: VillagerId): string {
  const live = store.inspect?.villagerId === id ? store.inspect.state : undefined;
  if (!live) return '';
  return moodFromNeeds(store.frames.get(id)?.status ?? live.status, live.needs);
}

function roleOf(store: UiStore, p: VillagerProfilePublic): [RosterRow['kind'], string] {
  if (p.visitor) {
    const room = (store.hotel?.rooms ?? []).findIndex((r) => r.guestId === p.id);
    return ['visitor', `visitor${room >= 0 ? ` · room ${room + 1}` : ''}`];
  }
  if (p.transient) return ['stranger', 'stranger · passing through'];
  return ['resident', p.occupation];
}

export function rosterRows(store: UiStore, place = placeLookup()): RosterRow[] {
  return sortedProfiles(store).map((p) => {
    const f = store.frames.get(p.id);
    const [kind, role] = roleOf(store, p);
    let doing = '';
    if (f?.status === 'sleeping') doing = '😴 asleep';
    else if (f?.status === 'talking') {
      const partner = store.talkPartner(p.id);
      doing = partner ? `💬 talking with ${store.name(partner)}` : '💬 talking';
    } else if (f) doing = `${f.emoji ? `${f.emoji} ` : ''}${f.activity}`.trim();
    return {
      id: p.id,
      name: p.name,
      role,
      kind,
      where: f ? place(store.map, Math.round(f.x), Math.round(f.y), f.status === 'walking') : '',
      doing,
      mood: inspectedMood(store, p.id),
    };
  });
}

/** Everything a row displays: the list is touched only when one of these strings changes. */
const rowKey = (r: RosterRow) =>
  `${r.id}\u0001${r.name}\u0001${r.role}\u0001${r.where}\u0001${r.doing}\u0001${r.mood}`;

interface RowEls {
  li: HTMLLIElement;
  name: HTMLElement;
  role: HTMLElement;
  where: HTMLElement;
  doing: HTMLElement;
  mood: HTMLElement;
}

const matches = (r: RosterRow, q: string) =>
  !q || [r.name, r.role, r.where, r.doing].some((s) => s.toLowerCase().includes(q));

/** The "Villagers" window: everyone in town, where they are and what they're doing; click to follow. */
export function villagersModal(ctx: UiContext): ModalView {
  const { store } = ctx;
  const place = placeLookup();
  const filter = h('input', {
    type: 'search',
    class: 'roster-search',
    placeholder: 'Filter by name, job, place or activity…',
    'aria-label': 'Filter villagers',
    'data-testid': 'roster-search',
  });
  const count = h('span', { class: 'label', 'data-testid': 'roster-count' });
  const list = h('ul', { class: 'roster', 'data-testid': 'roster' });
  const empty = h('li', { class: 'empty' });
  const els = new Map<VillagerId, RowEls>();
  let rows: RosterRow[] = [];
  let shown: RosterRow[] = [];

  const pick = (id: VillagerId) => {
    ctx.closeModal();
    ctx.select(id);
    findVillager(ctx.host, store, id);
  };
  const rowEls = (r: RosterRow): RowEls => {
    let e = els.get(r.id);
    if (!e) {
      const span = (part: string) => h('span', { class: `roster-${part}` });
      const parts = {
        name: span('name'),
        role: span('role'),
        where: span('where'),
        doing: span('doing'),
        mood: span('mood'),
      };
      const li = h(
        'li',
        null,
        h(
          'button',
          {
            type: 'button',
            class: `roster-row roster-${r.kind}`,
            'data-testid': 'roster-row',
            'data-id': r.id,
            title: `Follow ${r.name}`,
            onclick: () => pick(r.id),
          },
          parts.name,
          parts.role,
          parts.where,
          parts.doing,
          parts.mood,
        ),
      );
      e = { li, ...parts };
      els.set(r.id, e);
    }
    setText(e.name, `${KIND_EMOJI[r.kind]} ${r.name}`);
    setText(e.role, r.role);
    e.role.classList.toggle('badge', r.kind !== 'resident');
    setText(e.where, r.where ? `📍 ${r.where}` : '');
    setText(e.doing, r.doing);
    setText(e.mood, r.mood);
    return e;
  };

  filter.addEventListener('input', () => ctx.refreshModal());
  filter.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && shown[0]) {
      ev.preventDefault();
      pick(shown[0].id);
    }
    // Escape still has to reach the window handler that closes the modal.
    if (ev.key !== 'Escape') ev.stopPropagation();
  });

  return {
    title: 'Villagers',
    icon: ['people', '👥'],
    subtitle: 'Everyone in town right now',
    footer: 'Click a villager to open the inspector and follow them.',
    className: 'modal-villagers',
    key: () => {
      rows = rosterRows(store, place);
      return `${filter.value.trim().toLowerCase()}\u0002${rows.map(rowKey).join('\u0002')}`;
    },
    render(body) {
      const q = filter.value.trim().toLowerCase();
      shown = rows.filter((r) => matches(r, q));
      setText(
        count,
        q ? `${shown.length} of ${rows.length}` : `${rows.length} villager${rows.length === 1 ? '' : 's'}`,
      );
      const ids = new Set(rows.map((r) => r.id));
      for (const id of els.keys()) if (!ids.has(id)) els.delete(id);
      // Rows are patched in place; the list's children change only when who is shown, or the order, does.
      const lis = shown.map((r) => rowEls(r).li);
      if (lis.length === 0) {
        setText(empty, rows.length ? 'Nobody matches.' : 'Nobody in town yet.');
        lis.push(empty);
      }
      const same = lis.length === list.children.length && lis.every((li, i) => list.children[i] === li);
      if (!same) replaceChildren(list, lis);
      // Built once per open: replacing the input would drop focus and the caret while typing.
      if (!body.contains(filter)) {
        replaceChildren(body, h('div', { class: 'row roster-controls' }, filter, count), list);
        filter.focus();
      }
    },
  };
}
