import { h } from './dom.ts';

/** Indices in assets/ui/icons.png (mirrors assets/ui/icons.json; refreshed from it at runtime). */
const DEFAULT_ICONS = {
  pause: 0,
  play: 1,
  fast: 2,
  zoom_in: 3,
  zoom_out: 4,
  fit: 5,
  close: 6,
  rain: 7,
  party: 8,
  stranger: 9,
  birthday: 10,
  town_event: 11,
  save: 12,
  map: 13,
  home: 14,
  rumor: 15,
  note: 16,
  reply: 17,
  pin: 18,
  heart: 19,
  heart_empty: 20,
  zzz: 21,
  chat: 22,
  thinking: 23,
  star: 24,
  moon: 25,
  sun: 26,
  coin: 27,
  silver: 28,
  backpack: 29,
  paw: 30,
  decorate: 31,
  seed: 32,
  bread: 33,
  honey: 34,
  flower: 35,
  gem: 36,
  apple: 37,
  hunger: 38,
  energy: 39,
  social: 40,
  fun: 41,
  clock: 42,
  offline: 43,
  model: 44,
  agents: 45,
  cake: 46,
  music: 47,
  picnic: 48,
};

export type IconName = keyof typeof DEFAULT_ICONS;

interface IconSheet {
  image: string;
  size: number;
  columns: number;
  icons: Record<string, number>;
}

let sheet: IconSheet = { image: 'ui/icons.png', size: 16, columns: 8, icons: DEFAULT_ICONS };

function place(el: HTMLElement): void {
  const index = sheet.icons[el.dataset.icon ?? ''];
  if (index === undefined) {
    el.classList.add('no-sprite');
    return;
  }
  el.classList.remove('no-sprite');
  el.style.setProperty('--ix', String(index % sheet.columns));
  el.style.setProperty('--iy', String(Math.floor(index / sheet.columns)));
}

/**
 * A UI icon: the pixel sprite once the sheet has loaded (`.has-pixel-icons` on the UI root),
 * the emoji fallback before that or when the assets are missing. `scale` is an integer zoom.
 */
export function icon(name: string, fallback: string, scale = 1): HTMLSpanElement {
  const el = h('span', { class: 'ui-icon', 'data-icon': name, 'aria-hidden': 'true' }, fallback);
  el.style.setProperty('--s', String(scale));
  place(el);
  return el;
}

/** Icon for an item/decoration sprite key such as "ui/icons.json#flower". */
export function spriteIcon(sprite: string | undefined, fallback: string, scale = 1): HTMLSpanElement {
  const name = sprite?.includes('#') ? sprite.slice(sprite.indexOf('#') + 1) : (sprite ?? '');
  return icon(name, fallback, scale);
}

/**
 * Load assets/ui/icons.json + icons.png (served at the web root) and switch the UI to pixel icons.
 * Resolves false and leaves the emoji fallbacks when the art is not available.
 */
export async function loadIconSheet(root: HTMLElement, base = ''): Promise<boolean> {
  try {
    const res = await fetch(`${base}/ui/icons.json`);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return false;
    const data = (await res.json()) as Partial<IconSheet>;
    if (!data.icons || typeof data.columns !== 'number') return false;
    const next: IconSheet = {
      image: data.image ?? sheet.image,
      size: data.size ?? 16,
      columns: data.columns,
      icons: data.icons,
    };
    const url = `${base}/${next.image.replace(/^\//, '')}`;
    const ok = await new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
    if (!ok) return false;
    sheet = next;
    root.style.setProperty('--icons-url', `url("${url}")`);
    root.style.setProperty('--icon-size', `${sheet.size}px`);
    root.style.setProperty('--icons-columns', String(sheet.columns));
    root.querySelectorAll<HTMLElement>('.ui-icon').forEach(place);
    root.classList.add('has-pixel-icons');
    return true;
  } catch {
    return false;
  }
}
