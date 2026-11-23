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

/** Chunk edge in tiles: 32×32 tiles = 512×512 art px per canvas. */
export const CHUNK_TILES = 32;

export interface ChunkRef {
  cx: number;
  cy: number;
  /** Chunk rect in tiles (the last row/column may be smaller). */
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TileBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function chunkKey(which: 'below' | 'above', lit: boolean, ref: ChunkRef): string {
  return `${which}:${lit ? 'n' : 'd'}:${ref.cx},${ref.cy}`;
}

/** Chunks (in tiles) of a `width`×`height` map that intersect the art-px rect `view`. */
export function chunksInView(
  width: number,
  height: number,
  tileSize: number,
  view: { x: number; y: number; w: number; h: number },
  chunk = CHUNK_TILES,
): ChunkRef[] {
  const span = chunk * tileSize;
  const cols = Math.ceil(width / chunk);
  const rows = Math.ceil(height / chunk);
  const c0 = Math.max(0, Math.floor(view.x / span));
  const r0 = Math.max(0, Math.floor(view.y / span));
  const c1 = Math.min(cols - 1, Math.floor((view.x + view.w - 1e-6) / span));
  const r1 = Math.min(rows - 1, Math.floor((view.y + view.h - 1e-6) / span));
  const out: ChunkRef[] = [];
  for (let cy = r0; cy <= r1; cy++) {
    for (let cx = c0; cx <= c1; cx++) {
      const x = cx * chunk;
      const y = cy * chunk;
      out.push({ cx, cy, x, y, w: Math.min(chunk, width - x), h: Math.min(chunk, height - y) });
    }
  }
  return out;
}

/**
 * Pre-renders the static map layers at 1 art px per pixel, in day and lit (night) variants, as
 * 32×32-tile chunks built on first sight. `below` = ground + decor (under characters), `above` =
 * overhead (roofs, canopies, lamp heads).
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

  /** Number of chunk canvases built so far (all layers and variants). */
  get builtChunks(): number {
    return this.cache.size;
  }

  visible(view: { x: number; y: number; w: number; h: number }): ChunkRef[] {
    return chunksInView(this.map.width, this.map.height, this.map.tileSize, view);
  }

  /**
   * Like `chunk`, but once `budget.builds` is used up it returns the other (day/night) variant when
   * that one is already built, so a dusk switch spreads chunk builds over several frames.
   */
  chunkBudgeted(
    which: 'below' | 'above',
    lit: boolean,
    ref: ChunkRef,
    budget: { builds: number },
  ): HTMLCanvasElement {
    const hit = this.cache.get(chunkKey(which, lit, ref));
    if (hit) return hit;
    const other = this.cache.get(chunkKey(which, !lit, ref));
    if (other && budget.builds <= 0) return other;
    budget.builds--;
    return this.chunk(which, lit, ref);
  }

  chunk(which: 'below' | 'above', lit: boolean, ref: ChunkRef): HTMLCanvasElement {
    const key = chunkKey(which, lit, ref);
    let c = this.cache.get(key);
    if (!c) {
      c = this.build(which, lit, ref);
      this.cache.set(key, c);
    }
    return c;
  }

  private build(which: 'below' | 'above', lit: boolean, ref: ChunkRef): HTMLCanvasElement {
    const { map } = this;
    const tsz = map.tileSize;
    const c = makeCanvas(ref.w * tsz, ref.h * tsz);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.translate(-ref.x * tsz, -ref.y * tsz);
    const bounds = { x0: ref.x, y0: ref.y, x1: ref.x + ref.w, y1: ref.y + ref.h };
    if (!this.hasArt) {
      if (which === 'below') drawPlaceholderBelow(ctx, map, lit, bounds);
      else drawPlaceholderAbove(ctx, map);
      return c;
    }
    const layers: LayerName[] = which === 'below' ? ['ground', 'decor'] : ['overhead'];
    for (const name of layers) {
      const layer = map.layers[name];
      for (let y = bounds.y0; y < bounds.y1; y++) {
        for (let x = bounds.x0; x < bounds.x1; x++) {
          const src = tileSource(this.tilesets, layer[y * map.width + x] ?? -1, lit);
          if (!src) continue;
          ctx.drawImage(src.ts.image, src.sx, src.sy, src.size, src.size, x * tsz, y * tsz, tsz, tsz);
        }
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

function drawPlaceholderBelow(
  ctx: CanvasRenderingContext2D,
  map: WorldMap,
  lit: boolean,
  b: TileBounds = { x0: 0, y0: 0, x1: map.width, y1: map.height },
): void {
  const t = map.tileSize;
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
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
    if (x < b.x0 - 1 || x > b.x1 || y < b.y0 - 1 || y > b.y1) continue;
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
