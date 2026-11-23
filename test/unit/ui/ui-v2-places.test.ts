// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, HelloMessage } from '../../../src/shared/protocol.ts';
import { PLAYER_ID, type KeepEntry, type Letter, type Location } from '../../../src/shared/types.ts';
import { mountUi, UiStore, type UiController } from '../../../src/client/ui/index.ts';
import { makeHello } from './fixtures.ts';

let root: HTMLElement;
let sent: ClientMessage[];
let ui: UiController;
let hello: HelloMessage;

const q = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`[data-testid="${id}"]`);
const byTestId = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = q<T>(id);
  if (!el) throw new Error(`missing ${id}`);
  return el;
};
const last = () => sent.at(-1);
const sentOf = (type: string) => sent.filter((m) => m.type === type);

const V2_LOCATIONS: Location[] = [
  {
    id: 'post_office',
    name: 'Post office',
    kind: 'post',
    area: { x: 4, y: 5, w: 2, h: 2 },
    door: { x: 5, y: 6 },
    entry: { x: 5, y: 7 },
    hours: { open: '08:00', close: '18:00' },
    interiorId: 'post_office',
  },
  {
    id: 'notice_board',
    name: 'Notice board',
    kind: 'public',
    area: { x: 7, y: 5, w: 1, h: 1 },
    entry: { x: 7, y: 6 },
  },
  {
    id: 'burger_joint',
    name: 'Burger Joint',
    kind: 'food',
    area: { x: 7, y: 3, w: 2, h: 1 },
    entry: { x: 7, y: 4 },
    hours: { open: '11:00', close: '21:00' },
  },
  {
    id: 'ice_cream_truck_1',
    name: 'Ice cream truck',
    kind: 'food',
    area: { x: 0, y: 3, w: 1, h: 1 },
    entry: { x: 0, y: 4 },
    hours: { open: '10:00', close: '19:00' },
  },
  {
    id: 'rollercoaster',
    name: 'Rollercoaster',
    kind: 'ride',
    area: { x: 3, y: 3, w: 1, h: 1 },
    entry: { x: 3, y: 4 },
    hours: { open: '08:00', close: '21:00' },
    ride: { capacity: 8, durationMin: 10, playerCost: 4, funGain: 35 },
  },
  { id: 'hotel', name: 'Hotel', kind: 'hotel', area: { x: 9, y: 7, w: 1, h: 1 }, entry: { x: 9, y: 6 } },
];

/** Move the player (tick frame) and set the clock. */
function at(x: number, y: number, time = 12 * 60) {
  ui.handleMessage({
    type: 'tick',
    time,
    speed: 1,
    villagers: [{ id: PLAYER_ID, x, y, facing: 'down', status: 'idle', activity: '', emoji: '' }],
  });
}

function setPlayer(extra: Partial<HelloMessage['snapshot']['player']>) {
  ui.handleMessage({ type: 'player.updated', player: { ...hello.snapshot.player, ...extra } });
}

const letter = (extra: Partial<Letter>): Letter => ({
  id: 'l1',
  from: PLAYER_ID,
  to: 'ada',
  text: 'Thank you for the bread!',
  postedAt: 9 * 60,
  status: 'posted',
  ...extra,
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  );
  document.body.innerHTML = '<div id="ui"></div>';
  root = document.querySelector<HTMLElement>('#ui')!;
  sent = [];
  ui = mountUi(root, { send: (m) => sent.push(m) }, new UiStore());
  ui.setConnectionStatus('connected');
  hello = makeHello();
  hello.map.locations.find((l) => l.id === 'house_01')!.interiorId = 'house_small';
  hello.map.locations.push(...V2_LOCATIONS);
  hello.snapshot.stock = { burger_joint: { burger: 0 }, shop: { milk: 2 } };
  hello.snapshot.rides = [
    { locationId: 'rollercoaster', status: 'idle', riders: [], queue: ['bo'], cycleEndsAt: null },
  ];
  ui.handleMessage(hello);
});

afterEach(() => {
  ui.destroy();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AC19 interior view: Exit', () => {
  it('shows Exit while inside and sends player.exit', () => {
    at(9, 0);
    expect(byTestId('place-bar').hidden).toBe(true);
    setPlayer({ inside: { locationId: 'house_01', pos: { x: 3, y: 4 } } });
    expect(byTestId('place-bar').hidden).toBe(false);
    expect(byTestId('inside-name').textContent).toBe('🏠 Inside Brown house');
    expect(q('open-keep')).toBeNull();
    byTestId('btn-exit').click();
    expect(last()).toEqual({ type: 'player.exit' });
    setPlayer({ inside: null });
    expect(q('btn-exit')).toBeNull();
  });

  it('offers the Keep and letters inside the post office', () => {
    setPlayer({ inside: { locationId: 'post_office', pos: { x: 2, y: 2 } } });
    expect(byTestId('inside-name').textContent).toBe('🏠 Inside Post office');
    byTestId('open-keep').click();
    expect(root.querySelector('.modal-title')!.textContent).toContain('The Keep');
  });
});

describe('door modal: Go inside', () => {
  it('sends player.enter for a house with an interior and closes', () => {
    ui.openDoorNote('house_01');
    expect(byTestId('note-pin').textContent).toContain('Leave a note');
    byTestId('door-enter').click();
    expect(last()).toEqual({ type: 'player.enter', locationId: 'house_01' });
    expect(byTestId('inspector').hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#modal')!.hidden).toBe(true);
  });

  it('walks to the door first when the player is too far away, then goes in on arrival', () => {
    at(9, 0);
    ui.openDoorNote('house_01');
    byTestId('door-enter').click();
    expect(last()).toEqual({ type: 'player.move', to: { x: 1, y: 3 } });
    expect(sentOf('player.enter')).toHaveLength(0);
    expect(root.querySelector('#toasts')!.textContent).toContain('Walking to Brown house');
    setPlayer({
      path: [
        { x: 5, y: 1 },
        { x: 1, y: 3 },
      ],
    });
    at(4, 2);
    expect(sentOf('player.enter')).toHaveLength(0);
    at(1, 4);
    expect(last()).toEqual({ type: 'player.enter', locationId: 'house_01' });
    at(1, 3);
    expect(sentOf('player.enter')).toHaveLength(1);
  });

  it('drops the pending entry when the player walks somewhere else', () => {
    at(9, 0);
    ui.openDoorNote('house_01');
    byTestId('door-enter').click();
    setPlayer({
      path: [
        { x: 9, y: 1 },
        { x: 9, y: 9 },
      ],
    });
    at(1, 4);
    expect(sentOf('player.enter')).toHaveLength(0);
  });
  it('has no Go inside button without an interior', () => {
    ui.openDoorNote('house_02');
    expect(q('door-enter')).toBeNull();
  });

  it('shows the player letters to the owner at their door', () => {
    ui.handleMessage({
      type: 'letter.updated',
      letter: letter({ status: 'delivered', deliveredAt: 11 * 60 }),
    });
    ui.openDoorNote('house_01');
    expect(byTestId('door-letters').hidden).toBe(false);
    expect(byTestId('door-letters').textContent).toContain('letter to Ada · 📬 in their mailbox');
  });

  it('opens the post office door with its services', () => {
    at(5, 7);
    ui.openDoorNote('post_office');
    expect(root.querySelector('.modal-title')!.textContent).toContain('Post office');
    expect(q('note-pin')).toBeNull();
    byTestId('door-enter').click();
    expect(last()).toEqual({ type: 'player.enter', locationId: 'post_office' });
    ui.openDoorNote('post_office');
    byTestId('door-board').click();
    expect(root.querySelector('.modal-title')!.textContent).toContain('Notice board');
  });
});

describe('buy and ride buttons', () => {
  it('buys an ice cream at an open truck', () => {
    at(1, 3, 10 * 60 + 30);
    const btn = byTestId<HTMLButtonElement>('buy-ice_cream_truck_1-ice_cream');
    expect(btn.textContent).toContain('Ice cream · 3🪙');
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(last()).toEqual({ type: 'player.buy', locationId: 'ice_cream_truck_1', itemId: 'ice_cream' });
  });

  it('disables buying when closed, sold out or too expensive', () => {
    at(1, 3, 7 * 60);
    expect(byTestId<HTMLButtonElement>('buy-ice_cream_truck_1-ice_cream').disabled).toBe(true);
    at(7, 4, 12 * 60);
    const burger = () => byTestId<HTMLButtonElement>('buy-burger_joint-burger');
    expect(burger().disabled).toBe(true);
    expect(burger().title).toBe('Sold out');
    ui.handleMessage({ type: 'stock.updated', stock: { burger_joint: { burger: 3 } } });
    expect(burger().disabled).toBe(false);
    expect(burger().textContent).toContain('(3)');
    setPlayer({ gold: 2 });
    expect(burger().disabled).toBe(true);
    expect(burger().title).toBe('Not enough gold');
  });

  it('rides the rollercoaster for its cost', () => {
    at(3, 4, 12 * 60);
    const ride = byTestId<HTMLButtonElement>('ride-rollercoaster');
    expect(ride.textContent).toBe('Ride (4 gold)');
    expect(byTestId('place-bar').textContent).toContain('1 waiting');
    ride.click();
    expect(last()).toEqual({ type: 'player.ride', locationId: 'rollercoaster' });
    ui.handleMessage({
      type: 'ride.updated',
      ride: {
        locationId: 'rollercoaster',
        status: 'idle',
        riders: [],
        queue: ['bo', PLAYER_ID],
        cycleEndsAt: null,
      },
    });
    expect(q('ride-rollercoaster')).toBeNull();
    expect(byTestId('place-bar').textContent).toContain('in the queue');
    ui.handleMessage({
      type: 'ride.updated',
      ride: { locationId: 'rollercoaster', status: 'closed', riders: [], queue: [], cycleEndsAt: null },
    });
    expect(byTestId<HTMLButtonElement>('ride-rollercoaster').disabled).toBe(true);
  });

  it('shows nothing far from venues', () => {
    at(9, 0, 12 * 60);
    expect(byTestId('place-bar').hidden).toBe(true);
  });
});

describe('AC19 Letters modal', () => {
  it('writes a letter only at the post office', () => {
    at(1, 0);
    byTestId('dock-letters').click();
    byTestId('letters-tab-write').click();
    expect(byTestId<HTMLButtonElement>('letter-send').disabled).toBe(true);
    expect(byTestId('letter-hint').textContent).toContain('Walk to the post office');

    at(5, 7);
    expect(byTestId<HTMLButtonElement>('letter-send').disabled).toBe(false);
    byTestId<HTMLSelectElement>('letter-to').value = 'bo';
    byTestId<HTMLTextAreaElement>('letter-text').value = 'Shall we go to the zoo?';
    byTestId('letter-send').click();
    expect(last()).toEqual({ type: 'letter.send', to: 'bo', text: 'Shall we go to the zoo?' });
    ui.handleMessage({
      type: 'letter.updated',
      letter: letter({ to: 'bo', text: 'Shall we go to the zoo?' }),
    });
    expect(byTestId('letters-sent').textContent).toContain('to Bo · 📮 posted');
  });

  it('shows the inbox with an unread badge and marks letters read', () => {
    ui.handleMessage({
      type: 'letter.updated',
      letter: letter({
        id: 'l2',
        from: 'ada',
        to: PLAYER_ID,
        text: 'Come by for tea!',
        status: 'delivered',
        deliveredAt: 11 * 60,
      }),
    });
    expect(byTestId('dock-letters').querySelector('.dock-badge')!.textContent).toBe('1');
    byTestId('dock-letters').click();
    expect(byTestId('letters-tab-inbox').textContent).toBe('Inbox (1)');
    expect(byTestId('letters-inbox').textContent).toContain('from Ada');
    byTestId('letter-read-l2').click();
    expect(last()).toEqual({ type: 'letter.read', letterId: 'l2' });
    ui.handleMessage({
      type: 'letter.updated',
      letter: letter({ id: 'l2', from: 'ada', to: PLAYER_ID, text: 'Come by for tea!', status: 'read' }),
    });
    expect(q('letter-read-l2')).toBeNull();
    expect((byTestId('dock-letters').querySelector('.dock-badge') as HTMLElement).hidden).toBe(true);
  });

  it('lists delivered letters in the mailbox too', () => {
    ui.handleMessage({
      type: 'letter.updated',
      letter: letter({
        id: 'l3',
        from: 'bo',
        to: PLAYER_ID,
        text: 'Turnips!',
        status: 'delivered',
        deliveredAt: 600,
      }),
    });
    ui.openDoorNote('player_home');
    expect(byTestId('mailbox').textContent).toContain('letter from Bo · new');
  });
});

describe('AC19 Notice board modal', () => {
  it('lists notices and posts only near the board', () => {
    ui.handleMessage({
      type: 'notice.updated',
      notice: {
        id: 'n1',
        authorId: 'ada',
        text: '📌 Bake-off at the square, 15:00. All welcome! (Ada)',
        postedAt: 500,
        expiresAt: 500 + 3 * 1440,
      },
    });
    ui.handleMessage({
      type: 'notice.updated',
      notice: { id: 'n2', authorId: 'bo', text: 'Turnips for sale', postedAt: 600, expiresAt: 600 + 1440 },
    });
    at(0, 0);
    ui.openNoticeBoard();
    const items = [...byTestId('notices').querySelectorAll('[data-notice]')].map(
      (e) => (e as HTMLElement).dataset.notice,
    );
    expect(items).toEqual(['n2', 'n1']);
    expect(q('notice-form')).toBeNull();
    expect(byTestId('notice-hint').textContent).toContain('Walk up to the board');

    at(7, 6);
    byTestId<HTMLTextAreaElement>('notice-text').value = 'Lost: a striped scarf';
    byTestId('notice-post').click();
    expect(last()).toEqual({ type: 'notice.post', text: 'Lost: a striped scarf' });

    ui.handleMessage({
      type: 'notice.updated',
      notice: { id: 'n1', authorId: 'ada', text: '', postedAt: 500, expiresAt: 0 },
      removed: true,
    });
    expect(byTestId('notices').querySelector('[data-notice="n1"]')).toBeNull();
  });
});

describe('AC19 Keep modal', () => {
  const entry = (i: number, extra: Partial<KeepEntry> = {}): KeepEntry => ({
    id: `k${i}`,
    kind: 'letter',
    at: 500 + i,
    refId: `l${i}`,
    authorId: PLAYER_ID,
    recipientId: 'ada',
    text: `entry ${i}`,
    ...extra,
  });

  it('is only readable inside the post office', () => {
    ui.openKeep();
    expect(byTestId('keep-hint').textContent).toContain('Go inside');
    expect(sentOf('keep.open')).toHaveLength(0);
    setPlayer({ inside: { locationId: 'post_office', pos: { x: 1, y: 1 } } });
    expect(sentOf('keep.open')).toEqual([{ type: 'keep.open', offset: 0, limit: 20 }]);
  });

  it('shows entries, searches, filters, pages and appends live entries', () => {
    vi.useFakeTimers();
    setPlayer({ inside: { locationId: 'post_office', pos: { x: 1, y: 1 } } });
    ui.openKeep();
    ui.handleMessage({
      type: 'keep.data',
      entries: Array.from({ length: 20 }, (_, i) => entry(30 - i)),
      total: 30,
      offset: 0,
    });
    const rows = () => [...byTestId('keep-entries').querySelectorAll<HTMLElement>('[data-keep]')];
    expect(rows()).toHaveLength(20);
    expect(rows()[0]!.textContent).toContain('✉️ letter · Kim → Ada');
    expect(rows()[0]!.textContent).toContain('entry 30');
    expect(byTestId('keep-page').textContent).toBe('1–20 of 30');
    expect(byTestId<HTMLButtonElement>('keep-prev').disabled).toBe(true);

    byTestId('keep-next').click();
    expect(last()).toEqual({ type: 'keep.open', offset: 20, limit: 20 });
    ui.handleMessage({
      type: 'keep.data',
      entries: Array.from({ length: 10 }, (_, i) => entry(10 - i)),
      total: 30,
      offset: 20,
    });
    expect(byTestId('keep-page').textContent).toBe('21–30 of 30');
    expect(byTestId<HTMLButtonElement>('keep-next').disabled).toBe(true);

    const search = byTestId<HTMLInputElement>('keep-search');
    search.value = 'cake';
    search.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(300);
    expect(last()).toEqual({ type: 'keep.open', query: 'cake', offset: 0, limit: 20 });

    const kind = byTestId<HTMLSelectElement>('keep-kind');
    kind.value = 'rumor';
    kind.dispatchEvent(new Event('change'));
    expect(last()).toEqual({ type: 'keep.open', query: 'cake', kind: 'rumor', offset: 0, limit: 20 });
    ui.handleMessage({
      type: 'keep.data',
      entries: [entry(1, { kind: 'rumor', text: 'the cake is a lie' })],
      total: 1,
      offset: 0,
    });

    ui.handleMessage({
      type: 'keep.added',
      entry: entry(40, { kind: 'rumor', text: 'more cake', recipientId: undefined }),
    });
    ui.handleMessage({ type: 'keep.added', entry: entry(41, { kind: 'note', text: 'cake note' }) });
    expect(rows().map((r) => r.dataset.keep)).toEqual(['k40', 'k1']);
    expect(byTestId('keep-page').textContent).toBe('1–2 of 2');
  });
});

describe('Escape in modal inputs', () => {
  it('closes the Keep from its search box and the letters form from its textarea', () => {
    setPlayer({ inside: { locationId: 'post_office', pos: { x: 2, y: 2 } } });
    byTestId('open-keep').click();
    const modal = root.querySelector<HTMLElement>('#modal')!;
    expect(modal.hidden).toBe(false);
    byTestId('keep-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal.hidden).toBe(true);
    byTestId('inside-letter').click();
    expect(modal.hidden).toBe(false);
    const ta = byTestId('letter-text');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(modal.hidden).toBe(false);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal.hidden).toBe(true);
  });
});

describe('walking up to a venue first', () => {
  it('walks to a big ride entry before riding when the player stands at its far edge', () => {
    hello.map.locations.push({
      id: 'ferris_wheel',
      name: 'Ferris wheel',
      kind: 'ride',
      area: { x: 10, y: 10, w: 8, h: 8 },
      entry: { x: 10, y: 9 },
      hours: { open: '08:00', close: '21:00' },
      ride: { capacity: 6, durationMin: 10, playerCost: 4, funGain: 30 },
    });
    ui.handleMessage(hello);
    at(18, 17);
    byTestId('ride-ferris_wheel').click();
    expect(last()).toEqual({ type: 'player.move', to: { x: 10, y: 9 } });
    setPlayer({
      path: [
        { x: 17, y: 9 },
        { x: 10, y: 9 },
      ],
    });
    at(14, 9);
    expect(sentOf('player.ride')).toHaveLength(0);
    at(12, 9);
    expect(last()).toEqual({ type: 'player.ride', locationId: 'ferris_wheel' });
  });

  it('hides the post box diagonally out of the server reach', () => {
    at(7, 8, 10 * 60);
    expect(q('postbox-letter')).toBeNull();
    at(5, 8, 10 * 60);
    expect(q('postbox-letter')).not.toBeNull();
  });
});
