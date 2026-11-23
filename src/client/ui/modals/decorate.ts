import type { UiContext } from '../context.ts';
import { h, replaceChildren } from '../dom.ts';
import { icon } from '../icons.ts';
import type { ModalView } from './modal.ts';

export function decorateModal(ctx: UiContext): ModalView {
  const { store, host } = ctx;
  return {
    title: 'Decorate your cottage',
    icon: ['decorate', '🛋️'],
    footer: 'Earn gold by joining community events (+10) and finishing tasks (+12).',
    className: 'modal-decorate',
    key: () => {
      const p = store.player;
      return `${p?.gold}|${p?.ownedDecorations.join()}|${p?.placedDecorations.join()}|${store.catalog.decorations.length}`;
    },
    render(body) {
      const p = store.player;
      const gold = p?.gold ?? 0;
      replaceChildren(
        body,
        h(
          'div',
          { class: 'label' },
          icon('coin', '🪙'),
          ` ${gold} gold · click to buy, click again to put away`,
        ),
        h(
          'div',
          { class: 'grid grid-4' },
          store.catalog.decorations.map((d) => {
            const placed = p?.placedDecorations.includes(d.id) ?? false;
            const owned = p?.ownedDecorations.includes(d.id) ?? false;
            const affordable = owned || gold >= d.cost;
            const status = placed ? 'Placed ✓' : owned ? 'Owned · place' : `🪙 ${d.cost}`;
            return h(
              'button',
              {
                class: `deco-card${placed ? ' placed' : ''}${owned ? ' owned' : ''}${affordable ? '' : ' too-expensive'}`,
                'data-deco': d.id,
                title: affordable ? d.name : `${d.name}: needs ${d.cost} gold`,
                onclick: () => host.send({ type: 'decor.toggle', itemId: d.id }),
              },
              h('span', { class: 'deco-icon' }, d.emoji),
              h('span', { class: 'deco-name' }, d.name),
              h('span', { class: 'label deco-status' }, status),
            );
          }),
        ),
      );
    },
  };
}
