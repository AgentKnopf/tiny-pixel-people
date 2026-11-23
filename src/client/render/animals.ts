import type { AnimalSpecies, AnimalStage, AnimalStatus, Point } from '../../shared/types.ts';

/**
 * `assets/animals/index.json` (art contract): side-view sheets, row 0 faces left and row 1 faces
 * right; columns are animation frames listed by name in `frames`. Frame sizes differ per species.
 * Young and old farm animals are separate entries (`age`).
 */
export interface AnimalIndex {
  note?: string;
  rows: string[];
  frames: Record<string, number[]>;
  fps: Record<string, number>;
  animals: AnimalEntry[];
}

export type AnimalAge = 'young' | 'adult' | 'old';

export interface AnimalEntry {
  key: string;
  group: 'farm' | 'zoo' | 'forest' | string;
  species: string;
  age?: AnimalAge;
  sprite: string;
  frameWidth: number;
  frameHeight: number;
  /** Feet point inside a frame. */
  anchor: Point;
  description?: string;
  /** Per-sheet override of the shared `frames` (e.g. the crow's hop and caw columns). */
  frames?: Record<string, number[]>;
}

export type Side = 'left' | 'right';

/** Everything needed to draw one sheet, real or placeholder. */
export interface AnimalSheetInfo {
  key: string;
  w: number;
  h: number;
  anchor: Point;
  rows: Record<Side, number>;
  frames: Record<string, number[]>;
  fps: Record<string, number>;
  /** Draw scale (babies without a young sheet are shrunk). */
  scale: number;
}

export const DEFAULT_FRAMES: Record<string, number[]> = { idle: [0, 1], walk: [2, 3, 4, 5] };
export const DEFAULT_FPS: Record<string, number> = { idle: 2, walk: 6, fly: 8, hop: 6, caw: 4 };
/** crow.png fallback when its index entry lists no frames: idle 0–1, hop 2–4, caw 5–6. */
const CROW_FRAMES: Record<string, number[]> = { idle: [0, 1], walk: [2, 3, 4], hop: [2, 3, 4], caw: [5, 6] };

export function ageOf(stage: AnimalStage | undefined): AnimalAge {
  return stage === 'baby' ? 'young' : stage === 'elder' ? 'old' : 'adult';
}

/**
 * The index entry for an animal: same species and age, else the adult (shrunk for babies). Several
 * entries for one species and age (bird, bluebird) are picked between by `seed`.
 */
export function resolveEntry(
  index: AnimalIndex | null,
  species: AnimalSpecies,
  stage: AnimalStage | undefined,
  seed: number,
): { entry: AnimalEntry; scale: number } | null {
  if (!index) return null;
  const all = index.animals.filter((a) => a.species === species);
  if (all.length === 0) return null;
  const age = ageOf(stage);
  const pick = (list: AnimalEntry[]) => list[seed % list.length]!;
  const same = all.filter((a) => (a.age ?? 'adult') === age);
  if (same.length > 0) return { entry: pick(same), scale: 1 };
  const adult = all.filter((a) => (a.age ?? 'adult') === 'adult');
  const base = adult.length > 0 ? adult : all;
  return { entry: pick(base), scale: age === 'young' ? 0.75 : 1 };
}

export function sheetInfo(index: AnimalIndex, entry: AnimalEntry, scale: number): AnimalSheetInfo {
  const rowOf = (s: Side, fallback: number) => {
    const i = index.rows.indexOf(s);
    return i >= 0 ? i : fallback;
  };
  const own = entry.frames ?? (entry.species === 'crow' ? CROW_FRAMES : {});
  const frames: Record<string, number[]> = { ...index.frames, ...own };
  // A sheet with its own frame list but no walk cycle (the crow) hops instead of walking.
  if (entry.frames && !entry.frames.walk && entry.frames.hop) frames.walk = entry.frames.hop;
  return {
    key: entry.key,
    w: entry.frameWidth,
    h: entry.frameHeight,
    anchor: entry.anchor,
    rows: { left: rowOf('left', 0), right: rowOf('right', 1) },
    frames: { ...DEFAULT_FRAMES, ...frames },
    fps: { ...DEFAULT_FPS, ...index.fps },
    scale,
  };
}

/** Birds and the crow are drawn above the overhead layer (they sit in trees and on roofs). */
export function isAerial(species: AnimalSpecies): boolean {
  return species === 'bird' || species === 'crow';
}

/** Lift in art px while flying, so the bird reads as airborne over its shadow. */
export const FLY_LIFT = 10;

export function animationFor(status: AnimalStatus, moving: boolean, emoting: boolean): string {
  if (status === 'flying') return 'fly';
  if (status === 'sleeping') return 'sleep';
  if (emoting) return 'caw';
  if (moving || status === 'walking' || status === 'leaving') return 'walk';
  return 'idle';
}

/** Column to draw for an animation, falling back to walk/idle when the sheet lacks it. */
export function pickAnimalColumn(info: AnimalSheetInfo, anim: string, now: number, phase = 0): number {
  const list = info.frames[anim] ??
    (anim === 'fly' ? info.frames.walk : anim === 'caw' ? info.frames.idle : undefined) ??
    info.frames.idle ?? [0];
  if (anim === 'sleep' && !info.frames.sleep) return list[0] ?? 0;
  const fps = info.fps[anim] ?? DEFAULT_FPS[anim] ?? 4;
  const i = Math.floor(((now + phase) * fps) / 1000) % list.length;
  return list[i] ?? 0;
}

/** Art-px top-left of an animal frame: its feet anchor sits at the bottom-centre of the tile. */
export function animalTopLeft(pos: Point, tileSize: number, info: AnimalSheetInfo): Point {
  const s = info.scale;
  return {
    x: Math.round(pos.x * tileSize + tileSize / 2 - info.anchor.x * s),
    y: Math.round(pos.y * tileSize + tileSize - 2 - info.anchor.y * s),
  };
}

export function animalHitBox(
  pos: Point,
  tileSize: number,
  info: AnimalSheetInfo,
  lift = 0,
): { x: number; y: number; w: number; h: number } {
  const tl = animalTopLeft(pos, tileSize, info);
  const w = info.w * info.scale;
  const h = info.h * info.scale;
  return { x: tl.x + 1, y: tl.y + 1 - lift, w: Math.max(6, w - 2), h: Math.max(6, h - 2) };
}

// ---------- Placeholder sheets (same layout: 2 rows, idle 0–1, walk 2–5, sleep 6, fly 7) ----------

type Size = 'small' | 'medium' | 'large' | 'tall';

const SIZE: Record<AnimalSpecies, Size> = {
  chicken: 'small',
  rabbit: 'small',
  squirrel: 'small',
  hedgehog: 'small',
  bird: 'small',
  duck: 'small',
  crow: 'small',
  penguin: 'small',
  flamingo: 'small',
  sheep: 'medium',
  fox: 'medium',
  monkey: 'medium',
  kangaroo: 'medium',
  cow: 'large',
  deer: 'large',
  lion: 'large',
  zebra: 'large',
  panda: 'large',
  polar_bear: 'large',
  hippo: 'large',
  crocodile: 'large',
  elephant: 'tall',
  giraffe: 'tall',
};

const FRAME: Record<Size, { w: number; h: number }> = {
  small: { w: 16, h: 16 },
  medium: { w: 24, h: 24 },
  large: { w: 32, h: 24 },
  tall: { w: 40, h: 40 },
};

export const PLACEHOLDER_COLS = 8;
const PH_FRAMES: Record<string, number[]> = { idle: [0, 1], walk: [2, 3, 4, 5], sleep: [6], fly: [7] };

type RGBA = [number, number, number, number];

function hex(c: string): RGBA {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

const OUTLINE = hex('#272618');

interface Look {
  body: string;
  head?: string;
  accent?: string;
  legs?: string;
  pattern?: 'spots' | 'stripes' | 'mane' | 'patch' | 'belly';
}

const LOOK: Record<AnimalSpecies, Look> = {
  cow: { body: '#f4efe2', accent: '#3b3330', legs: '#3b3330', pattern: 'spots' },
  sheep: { body: '#f3ecd9', head: '#3b3330', legs: '#3b3330' },
  chicken: { body: '#fbf6ea', accent: '#d6463a', legs: '#e8a23a' },
  lion: { body: '#d9a14e', accent: '#8a4f22', pattern: 'mane' },
  elephant: { body: '#9a9aa0', accent: '#7a7a82' },
  giraffe: { body: '#e8b85a', accent: '#9a5a24', pattern: 'spots' },
  zebra: { body: '#f6f3ea', accent: '#2b2b30', pattern: 'stripes' },
  penguin: { body: '#2b2b38', accent: '#f6f3ea', legs: '#e8a23a', pattern: 'belly' },
  monkey: { body: '#8a5a32', head: '#c99a6a', accent: '#c99a6a' },
  panda: { body: '#f6f3ea', accent: '#2b2b30', legs: '#2b2b30', pattern: 'patch' },
  flamingo: { body: '#f29ab8', accent: '#2b2b30', legs: '#e07a9a' },
  kangaroo: { body: '#c08a52', accent: '#e8c89a', pattern: 'belly' },
  polar_bear: { body: '#f4f2ec', accent: '#2b2b30' },
  hippo: { body: '#8a8aa8', head: '#9a9ab8', accent: '#e8a0a0' },
  crocodile: { body: '#5a8a3c', accent: '#3c6a2a', pattern: 'stripes' },
  deer: { body: '#b07a42', accent: '#f3e7d0', pattern: 'spots' },
  rabbit: { body: '#c9b49a', accent: '#f6f0e6' },
  squirrel: { body: '#c0602a', accent: '#f0d0a0' },
  hedgehog: { body: '#6a5038', head: '#d8b88a', accent: '#4a3828' },
  fox: { body: '#e07a30', accent: '#f6f0e6' },
  bird: { body: '#5a8ad0', accent: '#f2c94c' },
  duck: { body: '#f6f0e0', head: '#3a8a4a', accent: '#e8a23a' },
  crow: { body: '#2e2e3a', accent: '#e8a23a' },
};

export function placeholderInfo(species: AnimalSpecies, young = false): AnimalSheetInfo {
  const f = FRAME[SIZE[species] ?? 'small'];
  const k = young ? 0.75 : 1;
  const w = Math.round(f.w * k);
  const h = Math.round(f.h * k);
  return {
    key: `placeholder-${species}${young ? '-young' : ''}`,
    w,
    h,
    anchor: { x: Math.floor(w / 2), y: h - 1 },
    rows: { left: 0, right: 1 },
    frames: { ...PH_FRAMES },
    fps: { ...DEFAULT_FPS },
    scale: 1,
  };
}

/**
 * Deterministic placeholder sheet in the art layout. Side-view silhouettes (row 0 faces left, row 1
 * right), recognisable by colour and one detail per species.
 */
export function placeholderAnimalSheet(
  species: AnimalSpecies,
  young = false,
): { px: Uint8ClampedArray; w: number; h: number; info: AnimalSheetInfo } {
  const info = placeholderInfo(species, young);
  const fw = info.w;
  const fh = info.h;
  const W = fw * PLACEHOLDER_COLS;
  const H = fh * 2;
  const px = new Uint8ClampedArray(W * H * 4);
  const look = LOOK[species];
  const body = hex(look.body);
  const head = hex(look.head ?? look.body);
  const accent = hex(look.accent ?? look.body);
  const legs = hex(look.legs ?? look.body);
  const small = SIZE[species] === 'small';
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < PLACEHOLDER_COLS; col++) {
      const mirror = row === 0;
      const ox = col * fw;
      const oy = row * fh;
      const put = (x: number, y: number, c: RGBA) => {
        const xx = mirror ? fw - 1 - x : x;
        if (xx < 0 || y < 0 || xx >= fw || y >= fh) return;
        const i = ((oy + y) * W + ox + xx) * 4;
        px[i] = c[0];
        px[i + 1] = c[1];
        px[i + 2] = c[2];
        px[i + 3] = 255;
      };
      const rect = (x: number, y: number, w: number, h: number, c: RGBA) => {
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, c);
      };
      const outlined = (x: number, y: number, w: number, h: number, c: RGBA) => {
        rect(x - 1, y - 1, w + 2, h + 2, OUTLINE);
        rect(x, y, w, h, c);
      };
      const sleeping = col === 6;
      const flying = col === 7;
      const step = col >= 2 && col <= 5 && col % 2 === 1;
      const bobIdle = col === 1 ? 1 : 0;
      const legH = sleeping ? 0 : Math.max(1, Math.round(fh * (species === 'flamingo' ? 0.35 : 0.18)));
      const bodyW = Math.round(fw * (small ? 0.55 : 0.62));
      const bodyH = Math.max(3, Math.round(fh * (sleeping ? 0.3 : small ? 0.35 : 0.38)));
      const bx = Math.round((fw - bodyW) / 2) - (small ? 0 : 2);
      const by = fh - 2 - legH - bodyH + (sleeping ? 0 : bobIdle);
      if (!sleeping && !flying) {
        const lw = small ? 1 : 2;
        outlined(bx + 1, by + bodyH, lw, Math.max(1, legH - (step ? 1 : 0) - bobIdle), legs);
        outlined(bx + bodyW - 1 - lw, by + bodyH, lw, Math.max(1, legH - (step ? 0 : 1) - bobIdle), legs);
      }
      outlined(bx, by, bodyW, bodyH, body);
      if (look.pattern === 'spots') {
        put(bx + 2, by + 1, accent);
        put(bx + bodyW - 3, by + 2, accent);
        if (bodyW > 8) rect(bx + Math.floor(bodyW / 2), by + 1, 2, 2, accent);
      } else if (look.pattern === 'stripes') {
        for (let sx = bx + 1; sx < bx + bodyW - 1; sx += 3) rect(sx, by, 1, bodyH, accent);
      } else if (look.pattern === 'belly') {
        rect(bx + 1, by + Math.floor(bodyH / 2), bodyW - 2, Math.ceil(bodyH / 2), accent);
      } else if (look.pattern === 'patch') {
        rect(bx, by + 1, 2, bodyH - 1, accent);
      }
      const hs = Math.max(3, Math.round(fh * (small ? 0.3 : 0.28)));
      let hx = bx + bodyW - Math.floor(hs / 2);
      let hy = by - Math.floor(hs / 2) + (sleeping ? Math.floor(hs / 2) : 0);
      if (species === 'giraffe' && !sleeping) {
        const neck = Math.round(fh * 0.4);
        rect(bx + bodyW - 4, by - neck, 3, neck, body);
        hy = by - neck - hs + 2;
        hx = bx + bodyW - 4;
      }
      if (species === 'flamingo' && !sleeping) {
        rect(bx + bodyW - 1, by - 5, 1, 5, body);
        hy = by - 7;
      }
      hx = Math.min(hx, fw - hs - 1);
      hy = Math.max(1, Math.round(hy));
      outlined(hx, hy, hs, hs, head);
      if (!sleeping) put(hx + hs - 2, hy + 1, OUTLINE);
      if (look.pattern === 'mane') {
        rect(hx - 1, hy - 1, 2, hs + 2, accent);
        rect(hx, hy - 1, hs, 1, accent);
      }
      if (species === 'elephant') rect(hx + hs, hy + 2, 1, hs, accent);
      if (species === 'chicken' || species === 'duck' || species === 'bird' || species === 'crow') {
        put(hx + hs, hy + Math.floor(hs / 2), accent);
        if (species === 'chicken') put(hx + 1, hy - 1, accent);
      }
      if (species === 'flamingo') put(hx + hs, hy + 1, accent);
      if (species === 'rabbit') {
        rect(hx + 1, hy - 3, 1, 3, head);
        rect(hx + 3, hy - 3, 1, 3, head);
      }
      if (species === 'fox' || species === 'squirrel' || species === 'monkey') {
        rect(bx - 3, by - 2, 3, 3, species === 'fox' ? body : accent);
        if (species === 'fox') put(bx - 3, by - 2, accent);
      }
      if (species === 'hedgehog') for (let sx = bx; sx < bx + bodyW; sx += 2) put(sx, by - 1, accent);
      if (species === 'deer' && !sleeping) {
        put(hx + 1, hy - 1, accent);
        put(hx + 1, hy - 2, accent);
        put(hx + 3, hy - 2, accent);
      }
      if (sleeping) rect(hx + 1, hy + Math.floor(hs / 2), hs - 2, 1, OUTLINE);
      if (flying) {
        rect(bx + 1, by - 2, Math.max(2, bodyW - 3), 2, body);
        put(bx + 1, by - 2, OUTLINE);
      }
    }
  }
  return { px, w: W, h: H, info };
}
