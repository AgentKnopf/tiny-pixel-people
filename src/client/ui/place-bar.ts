import type { Location } from '../../shared/types.ts';
import { itemDef } from './catalog.ts';
import type { UiContext } from './context.ts';
import { h, replaceChildren } from './dom.ts';
import { spriteIcon } from './icons.ts';
import { nearVenue } from './walk-in.ts';
import {
  canSendLetters,
  distanceToArea,
  FOOD_PRICES,
  insidePostOffice,
  isOpen,
  nearNoticeBoard,
  stockOf,
  venueItems,
} from './places.ts';

/** Venue buttons show this close to the area, and anywhere the server accepts buy/ride. */
const VENUE_RANGE = 1;

/**
 * Bottom-centre bar with what the player can do where they stand (spec v2 §13): Exit while inside
 * an interior (plus the Keep and letters in the post office), buy buttons at food venues and the
 * farm shop, "Ride (4 gold)" at rides, and the post box / notice board outside the post office.
 */
export function createPlaceBar(ctx: UiContext): HTMLElement {
  const { store, host } = ctx;
  const el = h('div', {
    class: 'panel place-bar',
    id: 'place-bar',
    hidden: true,
    role: 'region',
    'aria-label': 'Here',
    'data-testid': 'place-bar',
  });

  const btn = (
    label: string,
    testid: string,
    onclick: () => void,
    opts: { disabled?: boolean; title?: string; accent?: boolean } = {},
  ) =>
    h(
      'button',
      {
        class: `btn${opts.accent ? ' btn-accent' : ''}`,
        'data-testid': testid,
        disabled: !!opts.disabled,
        title: opts.title ?? null,
        onclick,
      },
      label,
    );

  const rideClosed = (loc: Location) =>
    !isOpen(loc, store.time) || store.rides.get(loc.id)?.status === 'closed';
  const onRide = (loc: Location) => {
    const ride = store.rides.get(loc.id);
    const id = store.player?.id;
    return !!id && !!ride && (ride.queue.includes(id) || ride.riders.includes(id));
  };
  const canRide = (loc: Location) =>
    !!loc.ride && !rideClosed(loc) && !onRide(loc) && (store.player?.gold ?? 0) >= loc.ride.playerCost;
  const canBuy = (loc: Location, itemId: string) =>
    isOpen(loc, store.time) &&
    stockOf(store, loc, itemId) > 0 &&
    (store.player?.gold ?? 0) >= (FOOD_PRICES[itemId] ?? 0);

  const venueRow = (loc: Location): HTMLElement | null => {
    const gold = store.player?.gold ?? 0;
    const open = isOpen(loc, store.time);
    if (loc.kind === 'ride' && loc.ride) {
      const ride = store.rides.get(loc.id);
      const closed = rideClosed(loc);
      const cost = loc.ride.playerCost;
      const queued = store.player ? (ride?.queue.includes(store.player.id) ?? false) : false;
      const riding = store.player ? (ride?.riders.includes(store.player.id) ?? false) : false;
      const info = closed
        ? 'closed'
        : ride?.status === 'running'
          ? `running · ${ride.queue.length} waiting`
          : `${ride?.queue.length ?? 0} waiting`;
      return h(
        'div',
        { class: 'place-row', 'data-location': loc.id },
        h('span', { class: 'place-name' }, `🎢 ${loc.name}`),
        h('span', { class: 'label-note' }, info),
        riding
          ? h('span', { class: 'place-tag' }, 'riding!')
          : queued
            ? h('span', { class: 'place-tag' }, 'in the queue')
            : btn(
                `Ride (${cost} gold)`,
                `ride-${loc.id}`,
                () => ctx.walkIn.use(loc, { type: 'player.ride', locationId: loc.id }, () => canRide(loc)),
                {
                  disabled: closed || gold < cost,
                  title: closed ? 'The rides are closed now' : gold < cost ? 'Not enough gold' : undefined,
                  accent: true,
                },
              ),
      );
    }
    const items = venueItems(loc);
    if (items.length === 0) return null;
    return h(
      'div',
      { class: 'place-row', 'data-location': loc.id },
      h('span', { class: 'place-name' }, loc.name),
      open ? null : h('span', { class: 'label-note' }, loc.hours ? `opens ${loc.hours.open}` : 'closed'),
      items.map((itemId) => {
        const def = itemDef(store.catalog, itemId);
        const price = FOOD_PRICES[itemId] ?? 0;
        const stock = stockOf(store, loc, itemId);
        const disabled = !open || stock <= 0 || gold < price;
        return h(
          'button',
          {
            class: 'btn btn-buy',
            'data-testid': `buy-${loc.id}-${itemId}`,
            disabled,
            title: !open
              ? 'Closed'
              : stock <= 0
                ? 'Sold out'
                : gold < price
                  ? 'Not enough gold'
                  : `Buy ${def.name}`,
            onclick: () =>
              ctx.walkIn.use(loc, { type: 'player.buy', locationId: loc.id, itemId }, () =>
                canBuy(loc, itemId),
              ),
          },
          spriteIcon(def.sprite, def.emoji),
          ` ${def.name} · ${price}🪙`,
          Number.isFinite(stock) ? h('span', { class: 'label-note' }, ` (${stock})`) : null,
        );
      }),
    );
  };

  let lastKey = '';
  const render = () => {
    const p = store.player;
    const map = store.map;
    if (!p || !map) {
      el.hidden = true;
      lastKey = '';
      return;
    }
    const tile = store.playerTile();
    const inside = p.inside ?? null;
    const near =
      inside || !tile
        ? []
        : map.locations.filter((l) => distanceToArea(l, tile) <= VENUE_RANGE || nearVenue(l, tile));
    const venues = near.filter((l) => l.kind === 'ride' || venueItems(l).length > 0);
    const letters = !inside && canSendLetters(store);
    const board = nearNoticeBoard(store);
    const key = JSON.stringify([
      inside?.locationId,
      venues.map((v) => v.id),
      letters,
      board,
      p.gold,
      venues.map((v) => [isOpen(v, store.time), store.rides.get(v.id), store.stock[v.id], store.stock.shop]),
      store.catalog.items.length,
    ]);
    if (key === lastKey) return;
    lastKey = key;

    const rows: (HTMLElement | null)[] = [];
    if (inside) {
      const loc = store.location(inside.locationId);
      rows.push(
        h(
          'div',
          { class: 'place-row' },
          h(
            'span',
            { class: 'place-name', 'data-testid': 'inside-name' },
            `🏠 Inside ${loc?.name ?? inside.locationId}`,
          ),
          insidePostOffice(store)
            ? [
                btn('📒 Open the Keep', 'open-keep', () => ctx.openModal('keep')),
                btn('✉️ Write a letter', 'inside-letter', () => ctx.openModal('letters', 'write')),
              ]
            : null,
          btn('🚪 Exit', 'btn-exit', () => host.send({ type: 'player.exit' }), { accent: true }),
        ),
      );
    } else {
      rows.push(...venues.map(venueRow));
      if (letters || board) {
        rows.push(
          h(
            'div',
            { class: 'place-row' },
            h('span', { class: 'place-name' }, '📮 Post office'),
            letters
              ? btn('✉️ Write a letter', 'postbox-letter', () => ctx.openModal('letters', 'write'))
              : null,
            board ? btn('📌 Notice board', 'open-board', () => ctx.openModal('notice-board')) : null,
          ),
        );
      }
    }
    const shown = rows.filter((r): r is HTMLElement => !!r);
    replaceChildren(el, shown);
    el.hidden = shown.length === 0;
  };
  store.subscribe(['player', 'villagers', 'time', 'hello', 'rides', 'stock', 'catalog'], render);
  render();
  return el;
}
