// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, HelloMessage } from '../../../src/shared/protocol.ts';
import type { AnimalState, Romance } from '../../../src/shared/types.ts';
import { mountUi, UiStore, type UiController } from '../../../src/client/ui/index.ts';
import { makeHello, makeInspect } from './fixtures.ts';

const DAY = 1440;
let root: HTMLElement;
let sent: ClientMessage[];
let ui: UiController;

const byTestId = (id: string) => {
  const el = root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing ${id}`);
  return el;
};

const cow: AnimalState = {
  id: 'cow_1',
  species: 'cow',
  group: 'farm',
  name: 'Bessie',
  sex: 'female',
  bornAt: 7 * 60 - 4 * DAY,
  stage: 'adult',
  homeId: 'house_02',
  pos: { x: 5, y: 1 },
  facing: 'down',
  status: 'eating',
};
const duck: AnimalState = {
  id: 'duck_1',
  species: 'duck',
  group: 'ambient',
  homeId: 'house_02',
  pos: { x: 6, y: 1 },
  facing: 'left',
  status: 'idle',
};

function v2Hello(): HelloMessage {
  const hello = makeHello();
  hello.map.scenes.push(
    { id: 'overview', name: 'Overview', subtitle: 'The whole map', rect: { x: 0, y: 0, w: 10, h: 8 } },
    { id: 'zoo', name: 'Zoo', subtitle: 'Animals and rides', rect: { x: 0, y: 0, w: 5, h: 4 } },
    { id: 'station', name: 'Station', subtitle: 'Train and hotel', rect: { x: 5, y: 4, w: 5, h: 4 } },
    { id: 'forest', name: 'Forest', subtitle: 'Grove and lake', rect: { x: 5, y: 0, w: 5, h: 4 } },
  );
  hello.villagers.push({
    id: 'vi',
    name: 'Vida',
    age: 29,
    occupation: 'travelling botanist',
    bio: 'Collects ferns.',
    traits: ['curious'],
    homeId: 'hotel',
    sprite: 'v',
    transient: true,
    visitor: true,
  });
  Object.assign(hello.snapshot, {
    animals: [cow, duck],
    train: { status: 'away', arrivesAt: 16 * 60, departsAt: 16 * 60 + 20, arriving: [], departing: [] },
    hotel: {
      locationId: 'hotel',
      rooms: Array.from({ length: 6 }, (_, i) => ({
        id: `hotel_room_${i + 1}`,
        guestId: i < 3 ? `g${i}` : null,
        since: i < 3 ? 0 : null,
      })),
    },
    visitors: [
      {
        villagerId: 'vi',
        arrivedAt: 10 * 60,
        departsAt: DAY + 16 * 60,
        roomId: 'hotel_room_1',
        origin: 'Fernbrook',
        reason: 'to see the ferns',
        status: 'checkedIn',
        source: 'fallback',
      },
    ],
    romances: [],
  });
  return hello;
}

const romance = (extra: Partial<Romance> = {}): Romance => ({
  id: 'r_ada_bo',
  pair: ['ada', 'bo'],
  stage: 'crush',
  since: 0,
  crushFrom: ['ada', 'bo'],
  shy: true,
  dates: [],
  updatedAt: 1,
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
  ui.handleMessage(v2Hello());
});

afterEach(() => {
  ui.destroy();
  vi.unstubAllGlobals();
});

describe('AC19 inspector: romance lines and visitor badge', () => {
  it('shows a shy crush, then dating with the last dates, then partner', () => {
    ui.selectVillager('ada');
    expect(byTestId('insp-romance').hidden).toBe(true);
    ui.handleMessage({ type: 'romance.updated', romance: romance() });
    expect(byTestId('insp-romance').hidden).toBe(false);
    expect(byTestId('insp-romance').textContent).toContain('💗 Shy crush on: Bo');

    const dates = [1, 2, 3, 4].map((i) => ({
      eventId: `e${i}`,
      locationId: 'bakery',
      at: 17 * 60 + i,
      askedBy: 'ada',
      status: 'done' as const,
      source: 'llm' as const,
    }));
    ui.handleMessage({
      type: 'romance.updated',
      romance: romance({ stage: 'dating', shy: false, dates, updatedAt: 2 }),
    });
    const text = byTestId('insp-romance').textContent!;
    expect(text).toContain('💞 Dating: Bo');
    expect(text).toContain('💗 Crush on: Bo');
    expect(byTestId('insp-romance').querySelectorAll('.romance-date')).toHaveLength(3);
    expect(text).toContain('Date at Bakery & Café · today 17:04');

    ui.handleMessage({ type: 'romance.updated', romance: romance({ stage: 'couple', updatedAt: 3 }) });
    expect(byTestId('insp-romance').textContent).toContain('💕 Partner: Bo');
    expect(byTestId('insp-romance').textContent).not.toContain('Crush');
  });

  it('prefers inspect.data.romance and hides ended romances', () => {
    ui.selectVillager('ada');
    ui.handleMessage({ ...makeInspect(), romance: romance({ stage: 'couple' }) });
    expect(byTestId('insp-romance').textContent).toContain('💕 Partner: Bo');
    ui.handleMessage({ ...makeInspect(), romance: romance({ stage: 'ended' }) });
    expect(byTestId('insp-romance').hidden).toBe(true);
  });

  it('shows the crush only on the side that has it', () => {
    ui.handleMessage({ type: 'romance.updated', romance: romance({ crushFrom: ['ada'], shy: false }) });
    ui.selectVillager('bo');
    expect(byTestId('insp-romance').hidden).toBe(true);
    ui.selectVillager('ada');
    expect(byTestId('insp-romance').textContent).toBe('💗 Crush on: Bo');
  });

  it('badges visitors with their departure and residents with nothing', () => {
    ui.selectVillager('vi');
    expect(byTestId('insp-badge').hidden).toBe(false);
    expect(byTestId('insp-badge').textContent).toBe('🧳 Visitor · leaves tomorrow 16:00');
    expect(byTestId('insp-badge').title).toContain('Fernbrook');
    ui.selectVillager('ada');
    expect(byTestId('insp-badge').hidden).toBe(true);
  });
});

describe('AC19 animal card', () => {
  it('shows species, name, stage and age for farm animals', () => {
    ui.selectAnimal('cow_1');
    const card = byTestId('animal-card');
    expect(card.hidden).toBe(false);
    expect(byTestId('animal-name').textContent).toBe('Bessie');
    expect(byTestId('animal-species').textContent).toBe('Cow');
    expect(byTestId('animal-details').textContent).toBe('Adult · ♀ female · 4 days old');
    expect(byTestId('animal-status').textContent).toBe('Now eating');
  });

  it('shows only species and name for forest animals', () => {
    ui.selectAnimal('duck_1');
    expect(byTestId('animal-name').textContent).toBe('Duck');
    expect(byTestId('animal-details').hidden).toBe(true);
    expect(byTestId('animal-status').hidden).toBe(true);
  });

  it('closes when a villager is selected, on ×, Escape, and when the animal leaves', () => {
    ui.selectAnimal('cow_1');
    ui.selectVillager('ada');
    expect(byTestId('animal-card').hidden).toBe(true);
    expect(byTestId('inspector').hidden).toBe(false);

    ui.selectAnimal('cow_1');
    expect(byTestId('inspector').hidden).toBe(true);
    byTestId('animal-close').click();
    expect(byTestId('animal-card').hidden).toBe(true);

    ui.selectAnimal('cow_1');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(byTestId('animal-card').hidden).toBe(true);

    ui.selectAnimal('cow_1');
    ui.handleMessage({
      type: 'animals.changed',
      added: [],
      removed: [{ id: 'cow_1', species: 'cow', reason: 'oldAge' }],
      updated: [],
    });
    expect(byTestId('animal-card').hidden).toBe(true);
  });

  it('follows status changes from tick animal frames', () => {
    ui.selectAnimal('cow_1');
    ui.handleMessage({
      type: 'tick',
      time: 8 * 60,
      speed: 1,
      villagers: [],
      animals: [{ id: 'cow_1', x: 6, y: 2, facing: 'up', status: 'sleeping' }],
    });
    expect(byTestId('animal-status').textContent).toBe('Now sleeping 💤');
  });
});

describe('AC19 train and hotel stats line, Train button, Map scenes', () => {
  it('shows the next train and hotel occupancy, and follows train.updated', () => {
    expect(byTestId('stats-train').textContent).toBe('🚂 Next train 16:00 · Hotel 3/6');
    ui.handleMessage({
      type: 'train.updated',
      train: { status: 'boarding', arrivesAt: 16 * 60, departsAt: 16 * 60 + 20, arriving: [], departing: [] },
    });
    expect(byTestId('stats-train').textContent).toBe('🚂 Train boarding · departs 16:20 · Hotel 3/6');
  });

  it('hides the line on a v1 world', () => {
    ui.handleMessage(makeHello());
    expect(byTestId('stats-train').hidden).toBe(true);
  });

  it('brings the next train from the toolbar', () => {
    const btn = byTestId('event-train');
    expect(btn.textContent).toContain('Train');
    btn.click();
    expect(sent.at(-1)).toEqual({ type: 'world.trigger', kind: 'train' });
  });

  it('lists the new scenes in the Map modal', () => {
    byTestId('dock-map').click();
    const ids = [...root.querySelectorAll<HTMLElement>('[data-scene]')].map((b) => b.dataset.scene);
    expect(ids).toEqual(['plaza', 'farm', 'home', 'overview', 'zoo', 'station', 'forest']);
    expect(byTestId('map-scenes').classList.contains('grid-3')).toBe(true);
    expect(root.querySelector('[data-scene="zoo"]')!.textContent).toContain('🦁 Zoo');
  });
});
