import type { UiContext } from '../context.ts';
import { h, replaceChildren } from '../dom.ts';
import type { ModalView } from './modal.ts';

export function petModal(ctx: UiContext): ModalView {
  const { store, host } = ctx;
  return {
    title: '🐾 Pet',
    className: 'modal-pet',
    key: () => {
      const pet = store.player?.pet;
      return `${pet?.name}|${pet?.mode}|${pet?.species}`;
    },
    render(body) {
      const pet = store.player?.pet;
      const name = pet?.name ?? 'Pip';
      const input = h('input', {
        type: 'text',
        maxlength: 20,
        value: name,
        'aria-label': 'Pet name',
        onkeydown: (ev: Event) => ev.stopPropagation(),
      });
      replaceChildren(
        body,
        h(
          'p',
          { class: 'pet-line' },
          h('b', null, name),
          ` the ${pet?.species ?? 'cat'} · ${pet?.mode === 'stay' ? 'staying put' : 'following you'}`,
        ),
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            { class: 'btn', onclick: () => host.send({ type: 'pet.command', action: 'pet' }) },
            `❤ Pet ${name}`,
          ),
          h(
            'button',
            {
              class: 'btn',
              onclick: () =>
                host.send({ type: 'pet.command', action: pet?.mode === 'stay' ? 'follow' : 'stay' }),
            },
            pet?.mode === 'stay' ? '🐾 Follow me' : '✋ Stay',
          ),
        ),
        h(
          'div',
          { class: 'row' },
          input,
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                const n = input.value.trim();
                if (n && n !== name) host.send({ type: 'pet.command', action: 'rename', name: n });
              },
            },
            'Rename',
          ),
        ),
      );
    },
  };
}
