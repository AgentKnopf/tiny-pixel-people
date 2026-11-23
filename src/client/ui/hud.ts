import { h, replaceChildren, setText } from './dom.ts';
import { icon } from './icons.ts';
import { formatClock, formatDay, isNight } from './format.ts';
import type { UiStore } from './store.ts';

/** Top-left pill: title · LIVE · weather · Day N · HH:MM · day/night dot. */
export function createHud(store: UiStore): HTMLElement {
  const live = h('span', { class: 'badge badge-live', 'data-testid': 'hud-live' }, 'LIVE');
  const weather = h('span', { class: 'hud-weather', 'aria-label': 'weather' });
  let weatherShown = '';
  const day = h('span', { class: 'hud-day' }, 'Day 1');
  const clock = h('span', { class: 'hud-clock', 'data-testid': 'hud-clock' }, '--:--');
  const dot = h('span', { class: 'hud-dot', 'aria-label': 'day' });
  const el = h(
    'div',
    { class: 'panel hud', id: 'hud' },
    h('span', { class: 'hud-title' }, 'Tiny Pixel People'),
    live,
    weather,
    day,
    clock,
    dot,
  );

  const render = () => {
    const t = store.time;
    setText(clock, store.map ? formatClock(t) : '--:--');
    setText(day, formatDay(t));
    const night = isNight(t);
    dot.classList.toggle('night', night);
    dot.setAttribute('aria-label', night ? 'night' : 'day');
    const w = store.weather.state === 'rain' ? 'rain' : night ? 'moon' : 'sun';
    if (w !== weatherShown) {
      weatherShown = w;
      weather.setAttribute(
        'aria-label',
        w === 'rain' ? 'raining' : w === 'moon' ? 'clear night' : 'clear day',
      );
      replaceChildren(weather, icon(w, w === 'rain' ? '🌧️' : w === 'moon' ? '🌙' : '🌷'));
    }
    let label = 'LIVE';
    let state = 'live';
    if (store.connection !== 'connected') {
      label = store.connection === 'connecting' ? 'CONNECTING' : 'OFFLINE';
      state = 'down';
    } else if (store.speed === 0) {
      label = 'PAUSED';
      state = 'paused';
    }
    setText(live, label);
    live.dataset.state = state;
  };
  store.subscribe(['time', 'speed', 'weather', 'connection', 'hello'], render);
  render();
  return el;
}
