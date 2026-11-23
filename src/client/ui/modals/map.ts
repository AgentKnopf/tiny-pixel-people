import type { UiContext } from '../context.ts';
import { h, replaceChildren } from '../dom.ts';
import type { ModalView } from './modal.ts';

const SCENE_EMOJI: Record<string, string> = {
  plaza: '⛲',
  overview: '🗺️',
  home: '🏡',
  farm: '🌾',
  post_row: '📮',
  zoo: '🦁',
  rides: '🎢',
  forest: '🌲',
  farmstead: '🐄',
  station: '🚂',
  market: '🧺',
};

export function mapModal(ctx: UiContext): ModalView {
  const { store, host } = ctx;
  return {
    title: 'Map',
    icon: ['map', '🗺️'],
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
              { class: `grid ${scenes.length > 6 ? 'grid-3' : 'grid-2'}`, 'data-testid': 'map-scenes' },
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
                  h(
                    'span',
                    { class: 'scene-name' },
                    SCENE_EMOJI[s.id] ? `${SCENE_EMOJI[s.id]} ` : '',
                    s.name,
                  ),
                  h('span', { class: 'label' }, s.subtitle),
                ),
              ),
            ),
      );
    },
  };
}
