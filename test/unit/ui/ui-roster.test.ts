// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, VillagerFrame, VillagerProfilePublic } from '../../../src/shared/protocol.ts';
import type { VillagerStatus } from '../../../src/shared/types.ts';
import { mountUi, UiStore, type CameraControls, type UiController } from '../../../src/client/ui/index.ts';
import { makeHello, makeInspect } from './fixtures.ts';

let root: HTMLElement;
let sent: ClientMessage[];
let camera: Required<CameraControls>;
let ui: UiController;
let store: UiStore;

const $ = <T extends Element = HTMLElement>(sel: string) => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const byTestId = <T extends Element = HTMLElement>(id: string) => $<T>(`[data-testid="${id}"]`);
const rows = () => [...root.querySelectorAll<HTMLElement>('[data-testid="roster-row"]')];
const row = (id: string) => $(`[data-testid="roster-row"][data-id="${id}"]`);
const cell = (id: string, part: string) => row(id).querySelector(`.roster-${part}`)!.textContent;

const frame = (
  id: string,
  x: number,
  y: number,
  status: VillagerStatus = 'idle',
  activity = 'waking up',
  emoji = '🌅',
): VillagerFrame => ({ id, x, y, facing: 'down', status, activity, emoji });
const profile = (id: string, name: string, extra: Partial<VillagerProfilePublic> = {}) => ({
  ...makeHello().villagers[0]!,
  id,
  name,
  ...extra,
});
const tick = (...villagers: VillagerFrame[]) =>
  ui.handleMessage({ type: 'tick', time: 500, speed: 1, villagers });

function mount(withCamera = true) {
  store = new UiStore();
  ui = mountUi(
    root,
    { send: (m) => sent.push(m), camera: withCamera ? camera : undefined, download: vi.fn() },
    store,
  );
  ui.setConnectionStatus('connected');
  ui.handleMessage(makeHello());
  tick(frame('ada', 2, 3), frame('bo', 5, 6), frame('cy', 9, 6));
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  );
  document.body.innerHTML = '<div id="ui"></div>';
  root = document.querySelector<HTMLElement>('#ui')!;
  sent = [];
  camera = {
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    fit: vi.fn(),
    showScene: vi.fn(),
    followVillager: vi.fn(),
    focusTile: vi.fn(),
  };
  mount();
});

afterEach(() => {
  ui.destroy();
  vi.unstubAllGlobals();
});

const openRoster = () => byTestId('dock-villagers').click();

describe('villager roster', () => {
  it('lists every resident, visitor and stranger once, sorted, and nobody else', () => {
    ui.handleMessage({
      type: 'villagers.changed',
      added: [
        profile('vi', 'Vera', { occupation: 'tourist', visitor: true }),
        profile('zz', 'Ace', { occupation: 'wanderer', transient: true }),
      ],
      removed: [],
    });
    openRoster();
    expect($('.modal-title').textContent).toBe('👥 Villagers');
    expect(rows().map((r) => r.dataset.id)).toEqual(['zz', 'ada', 'bo', 'cy', 'vi']);
    expect(cell('vi', 'role')).toBe('visitor');
    expect(row('vi').querySelector('.roster-role')!.classList.contains('badge')).toBe(true);
    expect(cell('zz', 'role')).toBe('stranger · passing through');
    expect(cell('ada', 'role')).toBe('baker');
    const text = byTestId('roster').textContent!;
    expect(text).not.toContain('Kim');
    expect(text).not.toContain('Pip');
    expect(byTestId('roster-count').textContent).toBe('5 villagers');

    // A departing visitor disappears.
    ui.handleMessage({ type: 'villagers.changed', added: [], removed: ['vi'] });
    tick(frame('ada', 2, 3, 'walking'));
    expect(rows().map((r) => r.dataset.id)).toEqual(['zz', 'ada', 'bo', 'cy']);
  });

  it('names the hotel room of a checked-in visitor', () => {
    ui.handleMessage({
      type: 'villagers.changed',
      added: [profile('vi', 'Vera', { occupation: 'tourist', visitor: true })],
      removed: [],
    });
    store.hotel = {
      locationId: 'bakery',
      rooms: [
        { id: 'r1', guestId: null, since: null },
        { id: 'r2', guestId: 'vi', since: 400 },
      ],
    };
    openRoster();
    expect(cell('vi', 'role')).toBe('visitor · room 2');
  });

  it('shows where each villager is from its frame tile', () => {
    openRoster();
    expect(cell('ada', 'where')).toBe('📍 outside');
    tick(frame('ada', 1, 1), frame('bo', 8.4, 1.2));
    expect(cell('ada', 'where')).toBe('📍 Brown house');
    expect(cell('bo', 'where')).toBe('📍 Bakery & Café');
    expect(cell('cy', 'where')).toBe('📍 outside');

    // Indoors, villagers stand on the house's spots/entry in front of it; walking past doesn't count.
    tick(frame('cy', 1, 3, 'acting', 'reading', '📖'));
    expect(cell('cy', 'where')).toBe('📍 Brown house');
    tick(frame('cy', 1, 3, 'walking', 'walking home', '🚶'));
    expect(cell('cy', 'where')).toBe('📍 outside');
  });

  it('shows activity, asleep, and talking with or without a known partner', () => {
    openRoster();
    tick(
      frame('ada', 2, 3, 'acting', 'baking bread', '🍞'),
      frame('bo', 5, 6, 'sleeping', 'sleeping', '💤'),
      frame('cy', 9, 6, 'talking', 'chatting', '💬'),
    );
    expect(cell('ada', 'doing')).toBe('🍞 baking bread');
    expect(cell('bo', 'doing')).toBe('😴 asleep');
    expect(cell('cy', 'doing')).toBe('💬 talking');

    ui.handleMessage({
      type: 'conversation.message',
      conversationId: 'c1',
      speakerId: 'cy',
      listenerId: 'ada',
      text: 'Hi!',
      time: 500,
    });
    tick(frame('ada', 2, 3, 'talking', 'chatting', '💬'));
    expect(cell('cy', 'doing')).toBe('💬 talking with Ada');
    expect(cell('ada', 'doing')).toBe('💬 talking with Cy');

    ui.handleMessage({ type: 'conversation.ended', conversationId: 'c1', participants: ['cy', 'ada'] });
    tick(frame('ada', 2, 3, 'idle', 'resting', '🪑'));
    expect(cell('cy', 'doing')).toBe('💬 talking');
    expect(cell('ada', 'doing')).toBe('🪑 resting');
  });

  it('shows a mood only for the inspected villager', () => {
    openRoster();
    // hello carried needs for everyone, but they are not live, so no mood yet.
    expect(cell('ada', 'mood')).toBe('');
    ui.selectVillager('ada');
    ui.handleMessage(makeInspect());
    tick(frame('bo', 5, 5));
    expect(cell('ada', 'mood')).toBe('content');
    expect(cell('bo', 'mood')).toBe('');
  });

  it('leaves the DOM alone unless a displayed field changes, and patches rows in place', async () => {
    openRoster();
    const list = byTestId('roster');
    const before = row('ada');
    let mutations = 0;
    const mo = new MutationObserver((records) => (mutations += records.length));
    mo.observe(list, { childList: true, subtree: true, characterData: true });
    const settle = () => new Promise((r) => setTimeout(r, 0));

    tick(frame('ada', 2.2, 3.1)); // sub-tile step
    tick(frame('ada', 2.2, 3.1)); // unchanged frame
    tick(frame('ada', 3, 3)); // new tile, still outside
    await settle();
    expect(mutations).toBe(0);

    tick(frame('ada', 1, 1)); // into the Brown house
    await settle();
    expect(mutations).toBeGreaterThan(0);
    expect(cell('ada', 'where')).toBe('📍 Brown house');
    expect(row('ada')).toBe(before);
    mo.disconnect();
  });

  it('filters by name, job, place or activity and keeps the input focused', () => {
    openRoster();
    const input = byTestId<HTMLInputElement>('roster-search');
    expect(document.activeElement).toBe(input);
    input.value = 'BAK';
    input.dispatchEvent(new Event('input'));
    expect(rows().map((r) => r.dataset.id)).toEqual(['ada']);
    expect(byTestId('roster-count').textContent).toBe('1 of 3');

    input.value = 'outside';
    input.dispatchEvent(new Event('input'));
    expect(rows()).toHaveLength(3);
    tick(frame('ada', 1, 1));
    expect(rows().map((r) => r.dataset.id)).toEqual(['bo', 'cy']);
    expect(byTestId('roster-search')).toBe(input);
    expect(document.activeElement).toBe(input);

    input.value = 'nobody here';
    input.dispatchEvent(new Event('input'));
    expect(byTestId('roster').textContent).toBe('Nobody matches.');
  });

  it('click selects, closes and follows the villager', () => {
    openRoster();
    row('bo').click();
    expect($('#modal').hidden).toBe(true);
    expect(store.selectedId).toBe('bo');
    expect(sent).toContainEqual({ type: 'inspect', villagerId: 'bo' });
    expect(camera.followVillager).toHaveBeenCalledWith('bo');
    expect(camera.focusTile).not.toHaveBeenCalled();
    expect(byTestId('inspector').hidden).toBe(false);
  });

  it('Enter in the filter picks the first match', () => {
    openRoster();
    const input = byTestId<HTMLInputElement>('roster-search');
    input.value = 'cy';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(store.selectedId).toBe('cy');
    expect(camera.followVillager).toHaveBeenCalledWith('cy');
  });

  it('falls back to the last tile when following fails, and works without a camera', () => {
    vi.mocked(camera.followVillager).mockReturnValue(false);
    openRoster();
    row('bo').click();
    expect(camera.focusTile).toHaveBeenCalledWith({ x: 5, y: 6 });
    expect(store.selectedId).toBe('bo');

    ui.destroy();
    mount(false);
    openRoster();
    expect(() => row('cy').click()).not.toThrow();
    expect(store.selectedId).toBe('cy');
  });

  it('opens from the stats-card count, a real button', () => {
    const agents = byTestId<HTMLButtonElement>('stats-agents');
    expect(agents.tagName).toBe('BUTTON');
    expect(agents.type).toBe('button');
    expect(agents.getAttribute('aria-label')).toBe('Show all villagers');
    expect(agents.textContent).toBe('👤 1 online · 👥 3 agents');
    agents.click();
    expect($('.modal-title').textContent).toBe('👥 Villagers');
  });

  it('Escape closes the roster', () => {
    openRoster();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect($('#modal').hidden).toBe(true);
  });

  it('dock tile shows the head count', () => {
    const tile = byTestId('dock-villagers');
    expect(tile.querySelector('.dock-label-full')?.textContent).toBe('Villagers');
    expect(tile.querySelector('.dock-label-compact')?.textContent).toBe('People');
    expect(byTestId('dock-villagers').textContent).toContain('3 in town');
    ui.handleMessage({
      type: 'villagers.changed',
      added: [profile('vi', 'Vera', { visitor: true })],
      removed: [],
    });
    expect(byTestId('dock-villagers').textContent).toContain('4 in town');
    ui.handleMessage({ type: 'villagers.changed', added: [], removed: ['vi'] });
    expect(byTestId('dock-villagers').textContent).toContain('3 in town');
  });

  it('does no roster work while closed', () => {
    const spy = vi.spyOn(store, 'talkPartner');
    tick(frame('ada', 1, 1, 'talking'));
    expect(spy).not.toHaveBeenCalled();
    openRoster();
    expect(spy).toHaveBeenCalled();
  });
});
