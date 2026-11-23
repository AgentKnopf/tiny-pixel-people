import { describe, expect, it } from 'vitest';
import type { AnimalChange } from '../../../src/server/sim/types.ts';
import { FOOD_PRICES, STOCK_CAP } from '../../../src/server/player/farm-economy.ts';
import { at } from '../../../src/shared/time.ts';
import type { PlayerState } from '../../../src/shared/types.ts';
import { advance, setup, type FakeHost } from './fake-host.ts';
import { addV2Locations } from './v2-fixtures.ts';

function change(over: Partial<AnimalChange> = {}): AnimalChange {
  return { added: [], removed: [], updated: [], produced: [], emotes: [], ...over };
}

function world(time = at(0, '12:00')) {
  const { host, pw } = setup();
  addV2Locations(host);
  host.time = time;
  const player = pw.state as PlayerState;
  player.gold = 100;
  return { host, pw, player };
}

function goTo(host: FakeHost, player: PlayerState, id: string): void {
  const loc = host.map.locations.find((l) => l.id === id)!;
  player.pos = { ...loc.entry };
}

const GRAPHIC = /\b(kill|killed|slaughter|blood|dead|meat|knife|chop)\b/i;

describe('FarmEconomy', () => {
  it('turns farm products into shop stock and butcher removals into burgers', () => {
    const { host, pw } = world();
    pw.onAnimalChange(
      change({
        produced: [
          { animalId: 'cow_1', itemId: 'milk', count: 1 },
          { animalId: 'hen_1', itemId: 'egg', count: 1 },
          { animalId: 'sheep_1', itemId: 'wool', count: 1 },
        ],
      }),
    );
    expect(pw.farm.stock().shop).toEqual({ milk: 1, egg: 1, wool: 1 });
    pw.onAnimalChange(
      change({
        removed: [
          { id: 'cow_2', species: 'cow', reason: 'butcher' },
          { id: 'sheep_2', species: 'sheep', reason: 'butcher' },
          { id: 'hen_2', species: 'chicken', reason: 'butcher' },
          { id: 'cow_3', species: 'cow', reason: 'oldAge' },
        ],
      }),
    );
    expect(pw.farm.stock().burger_joint).toEqual({ burger: 8 });
    const toasts = host.of('toast').filter((t) => t.icon === '🍔');
    expect(toasts).toHaveLength(3);
    for (const t of toasts) {
      expect(t.text).toContain('Fresh burgers at the Burger Joint!');
      expect(t.text).not.toMatch(GRAPHIC);
    }
    expect(host.of('stock.updated').at(-1)?.stock.burger_joint).toEqual({ burger: 8 });
  });

  it('names the farmer in the butcher toast', () => {
    const { host, pw } = world();
    host.profiles.get('ben')!.occupation = 'Farmer';
    pw.onAnimalChange(change({ removed: [{ id: 'c', species: 'cow', reason: 'butcher' }] }));
    expect(host.of('toast').at(-1)?.text).toBe(
      'Ben took a cow to the butcher. Fresh burgers at the Burger Joint!',
    );
  });

  it('caps stock at 30 per item', () => {
    const { pw } = world();
    pw.onAnimalChange(change({ produced: [{ animalId: 'c', itemId: 'milk', count: 50 }] }));
    expect(pw.farm.stock().shop?.milk).toBe(STOCK_CAP);
    for (let i = 0; i < 10; i++)
      pw.onAnimalChange(change({ removed: [{ id: `c${i}`, species: 'cow', reason: 'butcher' }] }));
    expect(pw.farm.stock().burger_joint?.burger).toBe(STOCK_CAP);
  });

  it('makes one cheese from 2 milk at 18:00, once a day', () => {
    const { host, pw } = world(at(0, '17:00'));
    pw.onAnimalChange(change({ produced: [{ animalId: 'c', itemId: 'milk', count: 5 }] }));
    advance(host, pw, 59);
    expect(pw.farm.stock().shop).toEqual({ milk: 5 });
    advance(host, pw, 1);
    expect(pw.farm.stock().shop).toEqual({ milk: 3, cheese: 1 });
    advance(host, pw, 300);
    expect(pw.farm.stock().shop).toEqual({ milk: 3, cheese: 1 });
    advance(host, pw, 24 * 60);
    expect(pw.farm.stock().shop).toEqual({ milk: 1, cheese: 2 });
  });

  it('villagers eat from stock and get a veggie burger when it is sold out', () => {
    const { pw } = world();
    pw.onAnimalChange(change({ removed: [{ id: 's', species: 'sheep', reason: 'butcher' }] }));
    expect(pw.consumeFood('burger_joint', 'burger')).toBe(true);
    expect(pw.consumeFood('burger_joint', 'burger')).toBe(true);
    expect(pw.consumeFood('burger_joint', 'burger')).toBe(false);
    expect(pw.farm.stock().burger_joint).toEqual({});
    expect(pw.consumeFood('ice_cream_truck_1', 'ice_cream')).toBe(true);
  });

  it('player.buy charges the price, fills the backpack and uses up stock', () => {
    const { host, pw, player } = world();
    pw.onAnimalChange(change({ removed: [{ id: 'c', species: 'cow', reason: 'butcher' }] }));
    goTo(host, player, 'burger_joint');
    expect(pw.handleCommand({ type: 'player.buy', locationId: 'burger_joint', itemId: 'burger' })).toEqual(
      [],
    );
    expect(player.gold).toBe(100 - FOOD_PRICES.burger!);
    expect(player.inventory).toContainEqual({ itemId: 'burger', count: 1 });
    expect(pw.farm.stock().burger_joint?.burger).toBe(3);

    goTo(host, player, 'ice_cream_truck_1');
    for (let i = 0; i < 3; i++)
      expect(
        pw.handleCommand({ type: 'player.buy', locationId: 'ice_cream_truck_1', itemId: 'ice_cream' }),
      ).toEqual([]);
    expect(player.gold).toBe(100 - 5 - 3 * 3);

    // Bought food can be gifted like any item.
    player.pos = { x: 15, y: 11 };
    expect(pw.handleCommand({ type: 'player.gift', villagerId: 'ada', itemId: 'ice_cream' })).toEqual([]);
    expect(host.memoriesOf('ada').at(-1)?.text).toContain('ice cream');
  });

  it('player.buy at the farm shop sells shop stock', () => {
    const { host, pw, player } = world();
    pw.onAnimalChange(change({ produced: [{ animalId: 'h', itemId: 'egg', count: 2 }] }));
    goTo(host, player, 'farmhouse');
    expect(pw.handleCommand({ type: 'player.buy', locationId: 'farmhouse', itemId: 'egg' })).toEqual([]);
    expect(pw.farm.stock().shop?.egg).toBe(1);
    expect(player.gold).toBe(99);
  });

  it('player.buy rejects closed, far away, sold out, unaffordable and unknown items', () => {
    const { host, pw, player } = world(at(0, '09:00'));
    const buy = (locationId: string, itemId: string) =>
      pw.handleCommand({ type: 'player.buy', locationId, itemId })?.[0];
    pw.onAnimalChange(change({ removed: [{ id: 'c', species: 'cow', reason: 'butcher' }] }));
    goTo(host, player, 'burger_joint');
    expect(buy('burger_joint', 'burger')).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/closed/),
    });
    host.time = at(0, '12:00');
    expect(buy('burger_joint', 'milk')).toMatchObject({ message: expect.stringMatching(/doesn't sell/) });
    expect(buy('nowhere', 'milk')).toMatchObject({ message: expect.stringMatching(/Unknown place/) });
    player.pos = { x: 3, y: 10 };
    expect(buy('burger_joint', 'burger')).toMatchObject({ message: expect.stringMatching(/Walk to/) });
    goTo(host, player, 'shop');
    expect(buy('shop', 'cheese')).toMatchObject({ message: expect.stringMatching(/sold out/) });
    goTo(host, player, 'burger_joint');
    player.gold = 2;
    expect(buy('burger_joint', 'burger')).toMatchObject({ message: expect.stringMatching(/5 gold/) });
    expect(player.inventory).toEqual([]);
    expect(pw.farm.stock().burger_joint?.burger).toBe(4);
  });

  it('round-trips stock through the save', () => {
    const { host, pw } = world();
    pw.onAnimalChange(change({ produced: [{ animalId: 'c', itemId: 'milk', count: 3 }] }));
    const save = pw.serialize();
    const again = setup({ restore: save });
    addV2Locations(again.host);
    expect(again.pw.farm.stock()).toEqual(save.stock);
    expect(host.of('stock.updated').length).toBeGreaterThan(0);
  });
});

describe('player.ride and world.trigger train', () => {
  it('charges the ride cost only when the ride takes the player', () => {
    const { host, pw, player } = world();
    goTo(host, player, 'rollercoaster');
    expect(pw.handleCommand({ type: 'player.ride', locationId: 'rollercoaster' })?.[0]).toMatchObject({
      message: expect.stringMatching(/not running/),
    });
    const joined: string[] = [];
    host.joinRide = (id: string) => {
      joined.push(id);
      return { ok: true };
    };
    expect(pw.handleCommand({ type: 'player.ride', locationId: 'rollercoaster' })).toEqual([]);
    expect(joined).toEqual(['rollercoaster']);
    expect(player.gold).toBe(96);
    host.joinRide = () => ({ ok: false, reason: 'You are already in the queue' });
    expect(pw.handleCommand({ type: 'player.ride', locationId: 'rollercoaster' })?.[0]).toMatchObject({
      message: 'You are already in the queue',
    });
    expect(player.gold).toBe(96);
  });

  it('rejects rides that are closed, far away, unaffordable or not rides', () => {
    const { host, pw, player } = world(at(0, '22:00'));
    host.joinRide = () => ({ ok: true });
    const ride = (locationId: string) => pw.handleCommand({ type: 'player.ride', locationId })?.[0];
    goTo(host, player, 'rollercoaster');
    expect(ride('rollercoaster')).toMatchObject({ message: expect.stringMatching(/closed/) });
    host.time = at(1, '12:00');
    expect(ride('shop')).toMatchObject({ message: expect.stringMatching(/not a ride/) });
    player.gold = 3;
    expect(ride('rollercoaster')).toMatchObject({ message: expect.stringMatching(/4 gold/) });
    player.gold = 50;
    player.pos = { x: 3, y: 10 };
    expect(ride('rollercoaster')).toMatchObject({ message: expect.stringMatching(/Walk to/) });
  });

  it('world.trigger train calls the train service', () => {
    const { host, pw } = world();
    expect(pw.handleCommand({ type: 'world.trigger', kind: 'train' })?.[0]).toMatchObject({ type: 'error' });
    let calls = 0;
    host.triggerTrain = () => {
      calls++;
      return { ok: true };
    };
    expect(pw.handleCommand({ type: 'world.trigger', kind: 'train' })).toEqual([]);
    expect(calls).toBe(1);
    expect(host.of('toast').at(-1)?.icon).toBe('🚂');
  });
});
