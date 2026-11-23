import { itemDef } from '../catalog.ts';
import type { UiContext } from '../context.ts';
import { h, replaceChildren } from '../dom.ts';
import type { ModalView } from './modal.ts';

export function backpackModal(ctx: UiContext): ModalView {
  const { store, host } = ctx;
  return {
    title: '🎒 Backpack',
    footer: 'Walk onto flowers, apples and other finds to pick them up. Gifts make friends.',
    className: 'modal-backpack',
    key: () => {
      const p = store.player;
      return `${p?.gold}|${store.selectedId}|${(p?.inventory ?? []).map((e) => `${e.itemId}:${e.count}`).join()}`;
    },
    render(body) {
      const p = store.player;
      const target = store.selectedId;
      const entries = (p?.inventory ?? []).filter((e) => e.count > 0);
      replaceChildren(
        body,
        h(
          'div',
          { class: 'label' },
          `🪙 ${p?.gold ?? 0} gold · `,
          target ? `gift to ${store.name(target)}` : 'select a villager to give gifts',
        ),
        entries.length === 0
          ? h('p', { class: 'empty' }, 'Your backpack is empty.')
          : h(
              'ul',
              { class: 'item-list' },
              entries.map((e) => {
                const def = itemDef(store.catalog, e.itemId);
                return h(
                  'li',
                  { class: 'item-row', 'data-item': e.itemId },
                  h('span', { class: 'item-icon' }, def.emoji),
                  h('span', { class: 'item-name' }, def.name),
                  h('span', { class: 'item-count' }, `×${e.count}`),
                  h(
                    'button',
                    {
                      class: 'btn',
                      disabled: !target,
                      onclick: () => {
                        if (!target) return;
                        host.send({ type: 'player.gift', villagerId: target, itemId: e.itemId });
                        store.startChat(
                          target,
                          `(gives ${def.emoji} ${def.name})`,
                          `${store.name(target)} is thinking…`,
                        );
                      },
                    },
                    '🎁 Gift',
                  ),
                );
              }),
            ),
      );
    },
  };
}
