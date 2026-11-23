import { SPEEDS, type Speed } from '../../shared/protocol.ts';
import type { WorldEventKind } from '../../shared/types.ts';
import type { UiContext } from './context.ts';
import { h, replaceChildren } from './dom.ts';
import { icon } from './icons.ts';

const EVENT_BUTTONS: { kind: WorldEventKind; sprite: string; emoji: string; label: string }[] = [
  { kind: 'rain', sprite: 'rain', emoji: '🌧️', label: 'Rain' },
  { kind: 'party', sprite: 'party', emoji: '🎉', label: 'Party' },
  { kind: 'stranger', sprite: 'stranger', emoji: '🕵️', label: 'Stranger' },
  { kind: 'birthday', sprite: 'birthday', emoji: '🎂', label: 'Birthday' },
  { kind: 'townEvent', sprite: 'town_event', emoji: '🗓️', label: 'Town event' },
  { kind: 'train', sprite: 'train', emoji: '🚂', label: 'Train' },
];

/** Bottom toolbar: pause, zoom, speed segmented control, world-event triggers, save replay. */
export function createToolbar(ctx: UiContext): HTMLElement {
  const { store, host } = ctx;

  const setSpeed = (speed: Speed) => {
    host.send({ type: 'speed', speed });
    store.speed = speed;
    if (speed > 0) store.lastSpeed = speed;
    store.emit('speed');
  };

  const pause = h('button', {
    class: 'btn btn-pause',
    'data-testid': 'btn-pause',
    title: 'Pause / resume (Space)',
    onclick: () => setSpeed(store.speed === 0 ? (store.lastSpeed as Speed) : 0),
  });

  const speedButtons = SPEEDS.filter((s) => s > 0).map((s) =>
    h(
      'button',
      {
        class: 'seg',
        'data-speed': s,
        'data-testid': `speed-${s}`,
        title: `Speed ${s}×`,
        'aria-label': `Speed ${s}×`,
        onclick: () => setSpeed(s),
      },
      `${s}×`,
    ),
  );

  const zoom = (fn: 'zoomOut' | 'fit' | 'zoomIn', sprite: string, label: string, title: string) =>
    h(
      'button',
      {
        class: 'btn btn-icon',
        title,
        'aria-label': title,
        onclick: () => {
          host.camera?.[fn]?.();
          if (fn === 'fit') store.setScene('plaza');
        },
      },
      icon(sprite, label),
    );

  const events = EVENT_BUTTONS.map((b) =>
    h(
      'button',
      {
        class: 'btn',
        'data-testid': `event-${b.kind}`,
        title: b.label,
        'aria-label': b.label,
        onclick: () => {
          const villagerId = b.kind === 'birthday' && store.selectedId ? store.selectedId : undefined;
          host.send({ type: 'world.trigger', kind: b.kind, ...(villagerId ? { villagerId } : {}) });
        },
      },
      icon(b.sprite, b.emoji),
      h('span', { class: 'btn-label' }, b.label),
    ),
  );

  const save = h(
    'button',
    {
      class: 'btn',
      'data-testid': 'btn-save',
      title: 'Save replay',
      'aria-label': 'Save replay',
      onclick: () => ctx.saveReplay(),
    },
    icon('save', '💾'),
    h('span', { class: 'btn-label' }, 'Save replay'),
  );

  const el = h(
    'div',
    { class: 'panel toolbar', id: 'toolbar' },
    pause,
    h(
      'div',
      { class: 'group' },
      zoom('zoomOut', 'zoom_out', '−', 'Zoom out'),
      zoom('fit', 'fit', '⤢', 'Fit the whole town'),
      zoom('zoomIn', 'zoom_in', '+', 'Zoom in'),
    ),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Speed' }, speedButtons),
    h('div', { class: 'group' }, events, save),
  );

  let pauseShown: boolean | null = null;
  const render = () => {
    const paused = store.speed === 0;
    if (paused !== pauseShown) {
      pauseShown = paused;
      replaceChildren(
        pause,
        paused ? icon('play', '▶') : icon('pause', '❚❚'),
        h('span', { class: 'btn-label-keep' }, paused ? 'PLAY' : 'PAUSE'),
      );
    }
    pause.classList.toggle('active', paused);
    for (const b of speedButtons) {
      const active = !paused && Number(b.dataset.speed) === store.speed;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    }
  };
  store.subscribe(['speed', 'hello'], render);
  render();
  return el;
}
