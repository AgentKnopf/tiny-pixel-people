import { SPEEDS, type Speed } from '../../shared/protocol.ts';
import type { WorldEventKind } from '../../shared/types.ts';
import type { UiContext } from './context.ts';
import { h, setText } from './dom.ts';

const EVENT_BUTTONS: { kind: WorldEventKind; icon: string; label: string }[] = [
  { kind: 'rain', icon: '🌧️', label: 'Rain' },
  { kind: 'party', icon: '🎉', label: 'Party' },
  { kind: 'stranger', icon: '🕵️', label: 'Stranger' },
  { kind: 'birthday', icon: '🎂', label: 'Birthday' },
  { kind: 'townEvent', icon: '🗓️', label: 'Town event' },
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
      { class: 'seg', 'data-speed': s, 'data-testid': `speed-${s}`, onclick: () => setSpeed(s) },
      `${s}×`,
    ),
  );

  const zoom = (fn: 'zoomOut' | 'fit' | 'zoomIn', label: string, title: string) =>
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
      label,
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
      h('span', { class: 'icon' }, b.icon),
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
    h('span', { class: 'icon' }, '💾'),
    h('span', { class: 'btn-label' }, 'Save replay'),
  );

  const el = h(
    'div',
    { class: 'panel toolbar', id: 'toolbar' },
    pause,
    h(
      'div',
      { class: 'group' },
      zoom('zoomOut', '−', 'Zoom out'),
      zoom('fit', '⤢', 'Fit the whole town'),
      zoom('zoomIn', '+', 'Zoom in'),
    ),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Speed' }, speedButtons),
    h('div', { class: 'group' }, events, save),
  );

  const render = () => {
    const paused = store.speed === 0;
    setText(pause, paused ? '▶ PLAY' : '❚❚ PAUSE');
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
