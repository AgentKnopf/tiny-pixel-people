import type { Facing, Point } from '../../shared/types.ts';

/** Character sheet layout (docs/art/README.md): 4 walk frames × 4 rows, 16×24 frames. */
export const FRAME_W = 16;
export const FRAME_H = 24;
export const SHEET_COLS = 4;
export const SHEET_W = FRAME_W * SHEET_COLS;
export const SHEET_H = FRAME_H * 4;
/** Feet anchor inside a frame. */
export const FEET_X = 8;
export const FEET_Y = 22;
export const WALK_FPS = 8;
export const BOB_MS = 500;

const ROW: Record<Facing, number> = { down: 0, left: 1, right: 2, up: 3 };

export function facingRow(f: Facing): number {
  return ROW[f];
}

/** Art-px top-left of a character frame whose tile position is `pos` (tile (tx, ty) → (tx*16, ty*16-8)). */
export function spriteTopLeft(pos: Point, tileSize: number): Point {
  return { x: Math.round(pos.x * tileSize), y: Math.round(pos.y * tileSize) - (FRAME_H - tileSize) };
}

/** Feet point in art px (used for y-sorting and name tags). */
export function feetPoint(pos: Point, tileSize: number): Point {
  const tl = spriteTopLeft(pos, tileSize);
  return { x: tl.x + FEET_X, y: tl.y + FEET_Y };
}

export interface FramePick {
  col: number;
  row: number;
  /** Vertical bob in art px (idle breathing). */
  bob: number;
}

/** Walk cycle at 8 fps while moving; idle shows frame 0 with a 1-px bob every 0.5 s. */
export function pickFrame(
  facing: Facing,
  moving: boolean,
  now: number,
  phase = 0,
  sleeping = false,
): FramePick {
  const row = facingRow(facing);
  if (moving) return { col: Math.floor(((now + phase) * WALK_FPS) / 1000) % SHEET_COLS, row, bob: 0 };
  if (sleeping) return { col: 0, row, bob: 0 };
  return { col: 0, row, bob: Math.floor((now + phase) / BOB_MS) % 2 === 1 ? -1 : 0 };
}

/** Resolve a sprite key from villagers.json ("villager-01", "characters/ada.png") to an asset URL. */
export function spriteUrl(key: string): string {
  const k = key.replace(/^\/+/, '').replace(/^assets\//, '');
  if (k.endsWith('.png')) return `/${k}`;
  if (k.includes('/')) return `/${k}.png`;
  return `/characters/${k}.png`;
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------- Placeholder sheets (used until/unless the real PNGs load) ----------

type RGBA = [number, number, number, number];

function hex(c: string): RGBA {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

const OUTLINE = hex('#272618');
const SKINS = ['#f1c8a0', '#e0a97c', '#c58a5c', '#8d5a3b'].map(hex);
const HAIRS = ['#3b2a1e', '#6b3f22', '#c98a3c', '#e2c46a', '#2b2b38', '#a04a3a', '#7a7a80', '#5a3a6a'].map(
  hex,
);
const SHIRTS = [
  '#5f9e4e',
  '#7a5a8c',
  '#e872b8',
  '#4f7fb0',
  '#c0503b',
  '#4f8f8a',
  '#d08a3c',
  '#8a6a4a',
  '#6a8ab0',
  '#b0b04a',
].map(hex);
const PANTS = ['#3c3a5a', '#4a3a2a', '#2f4a3a', '#5a4a3a'].map(hex);

export type PlaceholderKind = 'villager' | 'player' | 'stranger' | 'pet';

/** Deterministic 64×96 RGBA sheet in the real sheet layout, drawn from a seed string. */
export function placeholderSheet(seed: string, kind: PlaceholderKind = 'villager'): Uint8ClampedArray {
  const px = new Uint8ClampedArray(SHEET_W * SHEET_H * 4);
  const h = hashString(seed);
  const skin = SKINS[h % SKINS.length]!;
  const hair = HAIRS[(h >>> 4) % HAIRS.length]!;
  let shirt = SHIRTS[(h >>> 8) % SHIRTS.length]!;
  const pants = PANTS[(h >>> 12) % PANTS.length]!;
  if (kind === 'player') shirt = hex('#f2c94c');
  if (kind === 'stranger') shirt = hex('#6a5038');

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const ox = col * FRAME_W;
      const oy = row * FRAME_H;
      const put = (x: number, y: number, c: RGBA) => {
        if (x < 0 || y < 0 || x >= FRAME_W || y >= FRAME_H) return;
        const i = ((oy + y) * SHEET_W + ox + x) * 4;
        px[i] = c[0];
        px[i + 1] = c[1];
        px[i + 2] = c[2];
        px[i + 3] = c[3];
      };
      const rect = (x: number, y: number, w: number, hh: number, c: RGBA) => {
        for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, c);
      };
      const outlined = (x: number, y: number, w: number, hh: number, c: RGBA) => {
        rect(x - 1, y - 1, w + 2, hh + 2, OUTLINE);
        rect(x, y, w, hh, c);
      };
      const facing = (['down', 'left', 'right', 'up'] as const)[row]!;
      const step = col % 2 === 1; // frames 1 and 3 lift a foot
      const bob = step ? -1 : 0;
      if (kind === 'pet') drawPet(outlined, rect, put, facing, step);
      else drawPerson(outlined, rect, put, facing, step, bob, { skin, hair, shirt, pants, kind, col });
    }
  }
  return px;
}

type Put = (x: number, y: number, c: RGBA) => void;
type Rect = (x: number, y: number, w: number, h: number, c: RGBA) => void;

function drawPerson(
  outlined: Rect,
  rect: Rect,
  put: Put,
  facing: Facing,
  step: boolean,
  bob: number,
  c: { skin: RGBA; hair: RGBA; shirt: RGBA; pants: RGBA; kind: PlaceholderKind; col: number },
): void {
  // Legs (feet end at y = 22).
  const leftLift = step && c.col === 1 ? 1 : 0;
  const rightLift = step && c.col === 3 ? 1 : 0;
  outlined(5, 19, 2, 3 - leftLift, c.pants);
  outlined(9, 19, 2, 3 - rightLift, c.pants);
  // Body.
  outlined(4, 14 + bob, 8, 6, c.shirt);
  if (c.kind === 'stranger') rect(3, 14 + bob, 10, 7, c.shirt);
  // Arms.
  if (facing === 'down' || facing === 'up') {
    rect(3, 15 + bob, 1, 4, c.skin);
    rect(12, 15 + bob, 1, 4, c.skin);
  }
  // Head.
  outlined(3, 5 + bob, 10, 9, c.skin);
  // Hair / hood.
  const hair = c.kind === 'stranger' ? c.shirt : c.hair;
  rect(3, 5 + bob, 10, 3, hair);
  if (facing === 'up') rect(3, 5 + bob, 10, 8, hair);
  if (facing === 'left') rect(8, 5 + bob, 5, 7, hair);
  if (facing === 'right') rect(3, 5 + bob, 5, 7, hair);
  if (facing === 'down') {
    rect(3, 8 + bob, 1, 3, hair);
    rect(12, 8 + bob, 1, 3, hair);
  }
  // Eyes.
  const eye = hexCache.eye;
  if (facing === 'down') {
    put(5, 10 + bob, eye);
    put(10, 10 + bob, eye);
  } else if (facing === 'left') {
    put(4, 10 + bob, eye);
  } else if (facing === 'right') {
    put(11, 10 + bob, eye);
  }
  if (c.kind === 'player') rect(3, 4 + bob, 10, 1, hexCache.cap);
}

function drawPet(outlined: Rect, rect: Rect, put: Put, facing: Facing, step: boolean): void {
  const fur = hexCache.fur;
  const side = facing === 'left' || facing === 'right';
  if (side) {
    outlined(3, 16, 10, 5, fur);
    const head = facing === 'left' ? 2 : 9;
    outlined(head, 13, 5, 5, fur);
    put(head, 12, OUTLINE);
    put(head + 4, 12, OUTLINE);
    put(facing === 'left' ? head + 1 : head + 3, 15, hexCache.eye);
    rect(facing === 'left' ? 13 : 2, step ? 14 : 15, 1, 3, fur);
    rect(4, 21, 1, step ? 0 : 1, OUTLINE);
    rect(11, 21, 1, step ? 1 : 0, OUTLINE);
  } else {
    outlined(5, 15, 6, 7, fur);
    outlined(4, 11, 8, 5, fur);
    put(4, 10, OUTLINE);
    put(11, 10, OUTLINE);
    if (facing === 'down') {
      put(6, 13, hexCache.eye);
      put(9, 13, hexCache.eye);
    }
    rect(step ? 11 : 12, 17, 1, 3, fur);
  }
}

const hexCache = { eye: hex('#272618'), cap: hex('#c0503b'), fur: hex('#e08a3c') };
