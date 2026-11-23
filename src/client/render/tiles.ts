import type { Location, WorldMap } from '../../shared/types.ts';
import type { LoadedTileset } from './assets.ts';
import { hashString } from './sprites.ts';

export type LayerName = 'ground' | 'decor' | 'overhead';

/** Pick the tileset that owns global tile index `index` (largest firstIndex ≤ index). */
export function tilesetFor(tilesets: LoadedTileset[], index: number): LoadedTileset | null {
  let best: LoadedTileset | null = null;
  for (const t of tilesets)
    if (t.ref.firstIndex <= index && (!best || t.ref.firstIndex > best.ref.firstIndex)) best = t;
  return best;
}

/** Source rect of a global tile index, with the night variant swapped in when `lit`. */
export function tileSource(
  tilesets: LoadedTileset[],
  index: number,
  lit: boolean,
): { ts: LoadedTileset; sx: number; sy: number; size: number } | null {
  if (index < 0) return null;
  const ts = tilesetFor(tilesets, index);
  if (!ts) return null;
  let local = index - ts.ref.firstIndex;
  if (lit) {
    const swapped = ts.meta?.lit[String(local)];
    if (swapped !== undefined) local = swapped;
  }
  const size = ts.ref.tileSize;
  return { ts, sx: (local % ts.ref.columns) * size, sy: Math.floor(local / ts.ref.columns) * size, size };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Pre-renders the static map layers at 1 art px per pixel, in day and lit (night) variants.
 * `below` = ground + decor (under characters), `above` = overhead (roofs, canopies, lamp heads).
 */
export class TileLayers {
  private cache = new Map<string, HTMLCanvasElement>();
  constructor(
    private map: WorldMap,
    private tilesets: LoadedTileset[],
  ) {}

  get hasArt(): boolean {
    return this.tilesets.length > 0 && this.map.tilesets.length > 0;
  }

  get(which: 'below' | 'above', lit: boolean): HTMLCanvasElement {
    const key = `${which}:${lit ? 'n' : 'd'}`;
    let c = this.cache.get(key);
    if (!c) {
      c = this.build(which, lit);
      this.cache.set(key, c);
    }
    return c;
  }

  private build(which: 'below' | 'above', lit: boolean): HTMLCanvasElement {
    const { map } = this;
    const c = makeCanvas(map.width * map.tileSize, map.height * map.tileSize);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    if (!this.hasArt) {
      if (which === 'below') drawPlaceholderBelow(ctx, map, lit);
      else drawPlaceholderAbove(ctx, map);
      return c;
    }
    const layers: LayerName[] = which === 'below' ? ['ground', 'decor'] : ['overhead'];
    const tsz = map.tileSize;
    for (const name of layers) {
      const layer = map.layers[name];
      for (let i = 0; i < layer.length; i++) {
        const src = tileSource(this.tilesets, layer[i] ?? -1, lit);
        if (!src) continue;
        const x = (i % map.width) * tsz;
        const y = Math.floor(i / map.width) * tsz;
        ctx.drawImage(src.ts.image, src.sx, src.sy, src.size, src.size, x, y, tsz, tsz);
      }
    }
    return c;
  }
}

// ---------- Placeholder town (maps without a tileset) ----------

const GRASS = '#85aa4e';
const SPECKLE = ['#a3bf6f', '#728f4d', '#57743e'];
const FLOWERS = ['#ffffff', '#f2a0c0', '#f2d064'];
const ROOFS = ['#7a4a32', '#5c7fb0', '#4f8f8a', '#bc503b', '#6a8a4a', '#5a6470'];
const OUTLINE = '#272618';

function roofColor(loc: Location): string {
  if (loc.id === 'player_home') return '#7a5a8c';
  return ROOFS[hashString(loc.id) % ROOFS.length]!;
}

/** Building footprint for a location: the top rows of the area up to the door. */
function buildingRect(loc: Location): { x: number; y: number; w: number; h: number } | null {
  if (loc.kind !== 'house' && loc.kind !== 'shop') return null;
  const bottom = loc.door ? loc.door.y + 1 : loc.area.y + Math.min(loc.area.h, 4);
  return { x: loc.area.x, y: loc.area.y, w: Math.min(loc.area.w, 8), h: Math.max(2, bottom - loc.area.y) };
}

function drawPlaceholderBelow(ctx: CanvasRenderingContext2D, map: WorldMap, lit: boolean): void {
  const t = map.tileSize;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const h = hashString(`${x},${y}`);
      ctx.fillStyle = GRASS;
      ctx.fillRect(x * t, y * t, t, t);
      for (let k = 0; k < 3; k++) {
        const hh = hashString(`${x},${y},${k}`);
        ctx.fillStyle = SPECKLE[hh % SPECKLE.length]!;
        ctx.fillRect(x * t + (hh % t), y * t + ((hh >>> 8) % t), 1, 1);
      }
      if (h % 9 === 0) {
        ctx.fillStyle = FLOWERS[(h >>> 4) % FLOWERS.length]!;
        ctx.fillRect(x * t + ((h >>> 8) % 14) + 1, y * t + ((h >>> 12) % 14) + 1, 1, 1);
      }
    }
  }
  // Paths from every entry to the first public location.
  const hub = map.locations.find((l) => l.kind === 'public') ?? map.locations[0];
  ctx.fillStyle = '#e6be81';
  if (hub) {
    for (const loc of map.locations) {
      if (loc === hub) continue;
      const a = loc.entry;
      const b = hub.entry;
      ctx.fillRect(Math.min(a.x, b.x) * t, a.y * t + 4, (Math.abs(a.x - b.x) + 1) * t, t - 8);
      ctx.fillRect(b.x * t + 4, Math.min(a.y, b.y) * t, t - 8, (Math.abs(a.y - b.y) + 1) * t);
    }
  }
  for (const loc of map.locations) {
    const { x, y, w, h } = loc.area;
    if (loc.kind === 'public') {
      ctx.fillStyle = '#b8a36f';
      ctx.fillRect(x * t, y * t, w * t, h * t);
      ctx.fillStyle = '#e6be81';
      ctx.fillRect(x * t + 2, y * t + 2, w * t - 4, h * t - 4);
      // Fountain.
      const cx = (x + w / 2) * t;
      const cy = (y + h / 2) * t;
      ctx.fillStyle = '#978263';
      ctx.fillRect(cx - 12, cy - 12, 24, 24);
      ctx.fillStyle = '#d8d3c6';
      ctx.fillRect(cx - 11, cy - 11, 22, 22);
      ctx.fillStyle = '#6f9fb3';
      ctx.fillRect(cx - 8, cy - 8, 16, 16);
      ctx.fillStyle = '#abcad1';
      ctx.fillRect(cx - 6, cy - 6, 12, 12);
    } else if (loc.kind === 'nature') {
      ctx.fillStyle = '#6f9fb3';
      ctx.fillRect((x + 1) * t, (y + 1) * t, Math.max(1, w - 2) * t, Math.max(1, h - 2) * t);
    }
  }
  // Building fronts (walls, doors, windows) below characters; roofs go in the overhead layer.
  for (const loc of map.locations) {
    const b = buildingRect(loc);
    if (!b) continue;
    const wallTop = (b.y + b.h - 2) * t;
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(b.x * t, wallTop - 1, b.w * t, 2 * t + 1);
    ctx.fillStyle = loc.kind === 'shop' ? '#e2b77f' : '#ebc58a';
    ctx.fillRect(b.x * t + 1, wallTop, b.w * t - 2, 2 * t - 1);
    const winColor = lit ? '#f2c464' : '#9fb8c8';
    for (const wx of [b.x + 1, b.x + b.w - 2]) {
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(wx * t + 2, wallTop + 5, 12, 11);
      ctx.fillStyle = winColor;
      ctx.fillRect(wx * t + 3, wallTop + 6, 10, 9);
    }
    if (loc.door) {
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(loc.door.x * t + 3, loc.door.y * t - 4, 10, 20);
      ctx.fillStyle = '#80563c';
      ctx.fillRect(loc.door.x * t + 4, loc.door.y * t - 3, 8, 19);
      ctx.fillStyle = '#f2c94c';
      ctx.fillRect(loc.door.x * t + 10, loc.door.y * t + 6, 1, 1);
    }
  }
  // Blocked tiles outside locations become bushes.
  for (let i = 0; i < map.collision.length; i++) {
    if (map.collision[i] !== 1) continue;
    const x = i % map.width;
    const y = Math.floor(i / map.width);
    if (
      map.locations.some(
        (l) => x >= l.area.x && x < l.area.x + l.area.w && y >= l.area.y && y < l.area.y + l.area.h,
      )
    ) {
      continue;
    }
    ctx.fillStyle = '#394829';
    ctx.fillRect(x * t + 1, y * t + 2, t - 2, t - 3);
    ctx.fillStyle = '#668b4f';
    ctx.fillRect(x * t + 2, y * t + 2, t - 4, t - 5);
    ctx.fillStyle = '#7ca149';
    ctx.fillRect(x * t + 4, y * t + 4, 3, 2);
  }
}

function drawPlaceholderAbove(ctx: CanvasRenderingContext2D, map: WorldMap): void {
  const t = map.tileSize;
  for (const loc of map.locations) {
    const b = buildingRect(loc);
    if (!b) continue;
    const roofH = Math.max(1, b.h - 2) * t;
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(b.x * t - 1, b.y * t, b.w * t + 2, roofH);
    ctx.fillStyle = roofColor(loc);
    ctx.fillRect(b.x * t, b.y * t + 1, b.w * t, roofH - 2);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    for (let yy = b.y * t + 4; yy < b.y * t + roofH - 2; yy += 4)
      ctx.fillRect(b.x * t + 1, yy, b.w * t - 2, 1);
  }
}
