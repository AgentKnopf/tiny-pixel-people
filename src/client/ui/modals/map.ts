import type { UiContext } from '../context.ts';
import { h, replaceChildren } from '../dom.ts';
import type { ModalView } from './modal.ts';

export function mapModal(ctx: UiContext): ModalView {
  const { store, host } = ctx;
  return {
    title: '🗺️ Map',
    subtitle: 'Switch scenes',
    footer: 'Click empty ground to walk. The camera follows the scene you pick.',
    className: 'modal-map',
    key: () => `${store.activeScene}|${store.map?.scenes.length ?? 0}`,
    render(body) {
      const scenes = store.map?.scenes ?? [];
      replaceChildren(
        body,
        scenes.length === 0
          ? h('p', { class: 'empty' }, 'This map has no scenes.')
          : h(
              'div',
              { class: 'grid grid-2' },
              scenes.map((s) =>
                h(
                  'button',
                  {
                    class: `scene-btn${s.id === store.activeScene ? ' active' : ''}`,
                    'data-scene': s.id,
                    onclick: () => {
                      if (s.id === 'plaza' && !host.camera?.showScene) host.camera?.fit?.();
                      else host.camera?.showScene?.(s.id);
                      store.setScene(s.id);
                      ctx.closeModal();
                    },
                  },
                  h('span', { class: 'scene-name' }, s.name),
                  h('span', { class: 'label' }, s.subtitle),
                ),
              ),
            ),
      );
    },
  };
}
