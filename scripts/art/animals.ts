import { PixelCanvas, mix, type Color } from './canvas.ts';
import { P } from './palette.ts';

/**
 * Animal sprite sheets (side view). Every sheet: 2 rows (0 = facing left, 1 = facing right) ×
 * 6 columns (0-1 idle, 2-5 walk). The crow has extra columns, see CROW_FRAMES.
 */
export const ANIMAL_ROWS = ['left', 'right'] as const;
export const ANIMAL_FRAMES = { idle: [0, 1], walk: [2, 3, 4, 5] } as const;
const COLS = 6;

type Px = (x: number, y: number, c: Color) => void;

export interface AnimalSpec {
  key: string;
  w: number;
  h: number;
  description: string;
  /** Draws one frame facing right; ground is at y = h - 2. */
  draw: (b: PixelCanvas, frame: number, px: Px) => void;
}

const OUT = P.outline;

function mirror(src: PixelCanvas): PixelCanvas {
  const out = new PixelCanvas(src.width, src.height);
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const c = src.get(x, y);
      if (c[3]) out.set(src.width - 1 - x, y, c);
    }
  return out;
}

function frameCanvas(spec: AnimalSpec, frame: number): PixelCanvas {
  const b = new PixelCanvas(spec.w, spec.h);
  spec.draw(b, frame, (x, y, c) => b.set(x, y, c));
  b.outline(OUT);
  const c = new PixelCanvas(spec.w, spec.h);
  c.ellipse(spec.w / 2, spec.h - 1.5, spec.w * 0.34, 1.2, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

export function drawAnimalSheet(spec: AnimalSpec, cols = COLS): PixelCanvas {
  const sheet = new PixelCanvas(spec.w * cols, spec.h * 2);
  for (let f = 0; f < cols; f++) {
    const right = frameCanvas(spec, f);
    sheet.blit(mirror(right), f * spec.w, 0);
    sheet.blit(right, f * spec.w, spec.h);
  }
  return sheet;
}

/** Walk leg offset for leg pair `pair` (0/1) at frame f; idle frames stand still. */
function legShift(f: number, pair: number): number {
  if (f < 2) return 0;
  const s = [1, 0, -1, 0][(f - 2) % 4]!;
  return pair === 0 ? s : -s;
}
const bob = (f: number) => (f >= 2 && f % 2 === 1 ? -1 : 0);
const idleNod = (f: number) => (f === 1 ? 1 : 0);

interface Quad {
  w: number;
  h: number;
  body: [number, number, number, number];
  fur: Color;
  belly?: Color;
  dark?: Color;
  legs: number[];
  legW?: number;
  legColor?: Color;
  hoof?: Color;
  head: [number, number, number, number];
  neck?: number;
  snout?: Color;
  ears?: 'up' | 'floppy' | 'round' | 'none';
  horns?: Color;
  tail?: 'thin' | 'tuft' | 'bushy' | 'stub' | 'thick';
  tailColor?: Color;
  pattern?: (b: PixelCanvas, f: number) => void;
  extra?: (b: PixelCanvas, f: number, hx: number, hy: number) => void;
}

function quadruped(q: Quad): (b: PixelCanvas, f: number) => void {
  return (b, f) => {
    const g = q.h - 2;
    const [bx, by0, brx, bry] = q.body;
    const by = by0 + bob(f);
    const dark = q.dark ?? mix(q.fur, '#000000', 0.25);
    const legColor = q.legColor ?? dark;
    const lw = q.legW ?? 2;
    // far legs first (darker), then near legs
    q.legs.forEach((lx, i) => {
      const sh = legShift(f, i % 2);
      const top = Math.round(by + bry * 0.4);
      const col = i >= q.legs.length / 2 ? (q.legColor ?? q.fur) : legColor;
      b.rect(lx + sh, top, lw, g - top, col);
      if (q.hoof) b.rect(lx + sh, g - 1, lw, 1, q.hoof);
    });
    // tail
    const tx = Math.round(bx - brx + 1);
    const ty = Math.round(by - bry * 0.4);
    const tc = q.tailColor ?? dark;
    const sway = f === 1 ? 1 : 0;
    switch (q.tail ?? 'thin') {
      case 'thin':
        for (let i = 0; i < 5; i++) b.set(tx - 1 - Math.floor(i / 3), ty + i + sway * (i > 2 ? 1 : 0), tc);
        break;
      case 'tuft':
        for (let i = 0; i < 5; i++) b.set(tx - 1, ty + i, tc);
        b.rect(tx - 2 - sway, ty + 5, 2, 2, mix(tc, '#000000', 0.3));
        break;
      case 'bushy':
        b.ellipse(tx - 3 - sway, ty + 1, 3.5, 2.5, tc);
        b.ellipse(tx - 5 - sway, ty + 1, 1.5, 1.5, P.white);
        break;
      case 'stub':
        b.rect(tx - 1, ty, 2, 2, tc);
        break;
      case 'thick':
        for (let i = 0; i < 8; i++) b.rect(tx - i, ty + 2 + Math.floor(i / 2), 3, 3 - Math.floor(i / 4), tc);
        break;
    }
    // body
    b.ellipse(bx, by, brx, bry, q.fur);
    if (q.belly) b.ellipse(bx, by + bry * 0.45, brx * 0.75, bry * 0.45, q.belly);
    b.ellipse(bx - brx * 0.2, by - bry * 0.5, brx * 0.5, bry * 0.25, mix(q.fur, '#ffffff', 0.15));
    q.pattern?.(b, f);
    // neck + head
    const [hx0, hy0, hrx, hry] = q.head;
    const hx = hx0;
    const hy = hy0 + bob(f) + idleNod(f);
    if (q.neck) {
      const nx0 = bx + brx * 0.6;
      const ny0 = by - bry * 0.3;
      for (let t = 0; t <= 1; t += 0.05)
        b.ellipse(nx0 + (hx - nx0) * t, ny0 + (hy - ny0) * t, q.neck, q.neck, q.fur);
    }
    b.ellipse(hx, hy, hrx, hry, q.fur);
    if (q.snout) b.ellipse(hx + hrx * 0.6, hy + hry * 0.35, hrx * 0.5, hry * 0.5, q.snout);
    b.set(Math.round(hx + hrx * 0.2), Math.round(hy - hry * 0.25), OUT);
    switch (q.ears ?? 'up') {
      case 'up':
        b.rect(Math.round(hx - hrx * 0.4), Math.round(hy - hry - 2), 2, 3, dark);
        break;
      case 'floppy':
        b.rect(Math.round(hx - hrx * 0.7), Math.round(hy - hry * 0.4), 3, 2, dark);
        break;
      case 'round':
        b.ellipse(hx - hrx * 0.5, hy - hry, 1.6, 1.6, dark);
        break;
      case 'none':
        break;
    }
    if (q.horns) {
      b.set(Math.round(hx - 1), Math.round(hy - hry - 1), q.horns);
      b.set(Math.round(hx), Math.round(hy - hry - 2), q.horns);
    }
    q.extra?.(b, f, hx, hy);
  };
}

/** Greys and dulls a colour for "old" variants. */
const aged = (c: Color) => mix(c, '#b8b4ac', 0.4);

function cow(kind: 'calf' | 'adult' | 'old'): AnimalSpec {
  const s = kind === 'calf' ? 0.72 : 1;
  const fur = kind === 'old' ? aged(P.white) : P.white;
  const spot = kind === 'old' ? aged('#3a3030') : '#3a3030';
  const w = 32;
  const h = 24;
  const g = h - 2;
  const sc = (v: number, c: number) => c + (v - c) * s;
  return {
    key: kind === 'adult' ? 'cow' : `cow-${kind}`,
    w,
    h,
    description: `black-and-white ${kind} cow`,
    draw: quadruped({
      w,
      h,
      body: [16, sc(13, g), 9 * s, 5 * s],
      fur,
      belly: fur,
      dark: mix(fur, '#000000', 0.3),
      legs: [sc(9, 16), sc(19, 16), sc(11, 16), sc(21, 16)].map(Math.round),
      legColor: fur,
      hoof: '#3a3030',
      head: [sc(26, 16), sc(10, g), 3.5 * s, 3 * s],
      neck: 2.2 * s,
      snout: '#f0b0a8',
      ears: 'floppy',
      horns: kind === 'calf' ? undefined : '#e8e0c8',
      tail: 'tuft',
      tailColor: fur,
      pattern: (b, f) => {
        const by = sc(13, g) + bob(f);
        b.ellipse(13, by - 1, 3 * s, 2.5 * s, spot);
        b.ellipse(19, by + 1, 2.5 * s, 2 * s, spot);
        if (kind !== 'calf') b.ellipse(16, by - 3, 1.5, 1, spot);
        if (kind === 'adult' || kind === 'old') b.ellipse(16, by + 4, 2, 1, '#f0b0a8');
      },
      extra: (b, _f, hx, hy) => b.ellipse(hx - 0.5, hy - 1.5, 1.5, 1, spot),
    }),
  };
}

function sheep(kind: 'lamb' | 'adult' | 'old'): AnimalSpec {
  const s = kind === 'lamb' ? 0.7 : 1;
  const wool = kind === 'old' ? '#d8d2c4' : '#f4f0e4';
  const face = kind === 'old' ? '#6a625a' : '#3a3434';
  const w = 24;
  const h = 24;
  const g = h - 2;
  const sc = (v: number, c: number) => c + (v - c) * s;
  return {
    key: kind === 'adult' ? 'sheep' : `sheep-${kind}`,
    w,
    h,
    description: `fluffy ${kind} sheep`,
    draw: quadruped({
      w,
      h,
      body: [11, sc(14, g), 7 * s, 4.5 * s],
      fur: wool,
      dark: mix(wool, '#000000', 0.15),
      legs: [sc(7, 12), sc(14, 12), sc(9, 12), sc(16, 12)].map(Math.round),
      legColor: face,
      head: [sc(19, 12), sc(12, g), 2.6 * s, 2.4 * s],
      ears: 'floppy',
      tail: 'stub',
      tailColor: wool,
      pattern: (b, f) => {
        const by = sc(14, g) + bob(f);
        for (let i = 0; i < 6; i++)
          b.ellipse(6 + i * 2 * s + (11 - 11 * s), by - 3 * s + (i % 2), 2 * s, 2 * s, wool);
        b.set(9, Math.round(by - 1), mix(wool, '#000000', 0.12));
        b.set(13, Math.round(by + 1), mix(wool, '#000000', 0.12));
      },
      extra: (b, f, hx, hy) => {
        b.ellipse(hx + 0.5, hy + 0.5, 2.2 * s, 2 * s, face);
        b.ellipse(hx - 1, hy - 2 * s, 2 * s, 1.5 * s, wool);
        b.set(Math.round(hx + 1), Math.round(hy - 0.5), P.white);
        void f;
      },
    }),
  };
}

function chicken(kind: 'chick' | 'adult' | 'old'): AnimalSpec {
  return {
    key: kind === 'adult' ? 'chicken' : `chicken-${kind}`,
    w: 16,
    h: 16,
    description: `${kind} chicken`,
    draw: (b, f) => {
      const g = 14;
      const peck = f === 1 ? 2 : 0;
      const y = bob(f);
      if (kind === 'chick') {
        b.ellipse(8, g - 3 + y, 3.5, 3, '#f6dc5a');
        b.ellipse(10, g - 6 + y + peck * 0.5, 2.2, 2, '#f6dc5a');
        b.set(12, g - 6 + y + peck * 0.5, '#e8923a');
        b.set(10, g - 7 + y + peck * 0.5, OUT);
        b.vline(7 + legShift(f, 0), g - 1, g, '#e8923a');
        b.vline(9 + legShift(f, 1), g - 1, g, '#e8923a');
        return;
      }
      const feather = kind === 'old' ? '#e0d8c8' : P.white;
      b.vline(7 + legShift(f, 0), g - 3, g, '#e8a23a');
      b.vline(9 + legShift(f, 1), g - 3, g, '#e8a23a');
      b.ellipse(7, g - 6 + y, 5, 3.5, feather);
      b.rect(2, g - 11 + y, 3, 4, feather);
      b.set(2, g - 12 + y, mix(feather, '#000000', 0.15));
      b.ellipse(7, g - 6 + y, 3, 1.5, mix(feather, '#000000', 0.12));
      const hy = g - 10 + y + peck;
      b.ellipse(11, hy, 2.5, 2.5, feather);
      b.rect(10, hy - 4, 3, 2, '#d8402a');
      b.set(14, hy, '#e8a23a');
      b.set(13, hy + 1, '#e8a23a');
      b.set(12, hy + 2, '#d8402a');
      b.set(11, hy - 1, OUT);
    },
  };
}

const lion = (): AnimalSpec => ({
  key: 'lion',
  w: 32,
  h: 24,
  description: 'lion with a big mane',
  draw: quadruped({
    w: 32,
    h: 24,
    body: [14, 13, 8, 4.5],
    fur: '#d8a04a',
    belly: '#e8c07a',
    legs: [8, 17, 10, 19],
    head: [24, 10, 3.5, 3.5],
    snout: '#f0d8a0',
    ears: 'round',
    tail: 'tuft',
    tailColor: '#b8803a',
    extra: (b, f, hx, hy) => {
      b.ellipse(hx - 1.5, hy, 5.5, 5.5, '#9a5a2a');
      b.ellipse(hx - 2, hy - 1, 4, 4, '#b8702e');
      b.ellipse(hx + 0.5, hy + 0.5, 3, 3, '#d8a04a');
      b.ellipse(hx + 2.5, hy + 1.5, 1.6, 1.4, '#f0d8a0');
      b.set(Math.round(hx + 1), Math.round(hy - 1), OUT);
      b.set(Math.round(hx + 4), Math.round(hy + 1), '#5a3020');
      void f;
    },
  }),
});

const zebra = (): AnimalSpec => ({
  key: 'zebra',
  w: 32,
  h: 24,
  description: 'striped zebra',
  draw: quadruped({
    w: 32,
    h: 24,
    body: [15, 12, 8, 4.5],
    fur: '#f4f0e8',
    legs: [9, 18, 11, 20],
    legColor: '#f4f0e8',
    hoof: '#2a2a2a',
    head: [26, 7, 3, 2.6],
    neck: 2.2,
    snout: '#3a3a3a',
    ears: 'up',
    tail: 'tuft',
    tailColor: '#2a2a2a',
    pattern: (b, f) => {
      for (let x = 8; x < 23; x += 3)
        for (let y = 7; y < 18; y++)
          if (b.alpha(x, y + bob(f)) && (x + y) % 5 !== 0) b.set(x, y + bob(f), '#2a2a2a');
      for (let y = 4; y < 12; y += 2) b.hline(21, 24, y, '#2a2a2a');
    },
    extra: (b, _f, hx, hy) => {
      b.rect(Math.round(hx - 5), Math.round(hy - 3), 6, 1, '#2a2a2a');
      b.set(Math.round(hx + 1), Math.round(hy - 1), OUT);
    },
  }),
});

const giraffe = (): AnimalSpec => ({
  key: 'giraffe',
  w: 32,
  h: 48,
  description: 'tall giraffe with patches',
  draw: quadruped({
    w: 32,
    h: 48,
    body: [13, 30, 7, 5],
    fur: '#e8b84a',
    belly: '#f2d48a',
    legs: [8, 16, 10, 18],
    hoof: '#5a3a20',
    legColor: '#e8b84a',
    head: [24, 7, 3, 2.4],
    neck: 1.8,
    snout: '#f2d48a',
    ears: 'up',
    horns: '#7a4a2a',
    tail: 'tuft',
    tailColor: '#7a4a2a',
    pattern: (b, f) => {
      const pts = [
        [9, 28],
        [13, 27],
        [17, 29],
        [11, 32],
        [15, 32],
        [19, 26],
        [20, 21],
        [21, 16],
        [22, 12],
      ];
      for (const [x, y] of pts) if (b.alpha(x!, y! + bob(f))) b.rect(x!, y! + bob(f), 2, 2, '#a8642a');
    },
  }),
});

const elephant = (): AnimalSpec => ({
  key: 'elephant',
  w: 40,
  h: 32,
  description: 'grey elephant with trunk and big ears',
  draw: quadruped({
    w: 40,
    h: 32,
    body: [18, 16, 12, 8],
    fur: '#9a9ca6',
    legs: [10, 22, 13, 25],
    legW: 4,
    head: [31, 12, 5, 5],
    ears: 'none',
    tail: 'thin',
    extra: (b, f, hx, hy) => {
      b.ellipse(hx - 3, hy, 3.5, 5, '#868894');
      b.ellipse(hx - 3, hy, 2, 3.5, '#d8a8a8');
      const sw = f === 1 ? 1 : 0;
      for (let i = 0; i < 10; i++)
        b.rect(
          Math.round(hx + 4 + (i > 6 ? 1 : 0) + sw * (i > 5 ? 1 : 0)),
          Math.round(hy + 1 + i),
          2,
          1,
          '#9a9ca6',
        );
      b.set(Math.round(hx + 3), Math.round(hy + 3), P.white);
      b.set(Math.round(hx + 1), Math.round(hy - 1), OUT);
    },
  }),
});

const hippo = (): AnimalSpec => ({
  key: 'hippo',
  w: 32,
  h: 24,
  description: 'round purple-grey hippo',
  draw: quadruped({
    w: 32,
    h: 24,
    body: [14, 14, 10, 6],
    fur: '#8a7a96',
    belly: '#c4a0b0',
    legs: [7, 18, 9, 20],
    legW: 3,
    head: [25, 13, 5, 4],
    snout: '#c4a0b0',
    ears: 'round',
    tail: 'stub',
    extra: (b, _f, hx, hy) => {
      b.set(Math.round(hx + 3), Math.round(hy - 1), OUT);
      b.set(Math.round(hx + 4), Math.round(hy + 2), '#5a4a66');
    },
  }),
});

const polarBear = (): AnimalSpec => ({
  key: 'polar_bear',
  w: 32,
  h: 24,
  description: 'white polar bear',
  draw: quadruped({
    w: 32,
    h: 24,
    body: [14, 13, 9, 5.5],
    fur: '#f4f2ec',
    dark: '#c8ccd4',
    legs: [7, 17, 9, 19],
    legW: 3,
    head: [25, 13, 3.5, 3],
    snout: '#f4f2ec',
    ears: 'round',
    tail: 'stub',
    extra: (b, _f, hx, hy) => b.set(Math.round(hx + 3), Math.round(hy), OUT),
  }),
});

const panda = (): AnimalSpec => ({
  key: 'panda',
  w: 24,
  h: 24,
  description: 'black-and-white panda munching bamboo',
  draw: (b, f) => {
    const g = 22;
    const y = bob(f);
    const blk = '#2a2a2e';
    b.rect(5 + legShift(f, 0), g - 5, 3, 5, blk);
    b.rect(14 + legShift(f, 1), g - 5, 3, 5, blk);
    b.ellipse(11, g - 7 + y, 7, 5, '#f4f2ec');
    b.ellipse(14.5, g - 7 + y, 2, 4.5, blk);
    b.ellipse(7, g - 4 + y, 3, 2, blk);
    b.ellipse(18, g - 10 + y + idleNod(f), 4, 3.5, '#f4f2ec');
    b.ellipse(16, g - 14 + y, 1.6, 1.6, blk);
    b.ellipse(20, g - 14 + y, 1.6, 1.6, blk);
    b.ellipse(19, g - 10 + y + idleNod(f), 1.3, 1.6, blk);
    b.set(19, g - 10 + y + idleNod(f), P.white);
    b.set(21, g - 9 + y + idleNod(f), blk);
    if (f < 2) {
      b.vline(22, g - 12, g - 6, '#7ab04a');
      b.set(23, g - 12, P.leafLight);
    }
  },
});

const kangaroo = (): AnimalSpec => ({
  key: 'kangaroo',
  w: 24,
  h: 24,
  description: 'hopping kangaroo',
  draw: (b, f) => {
    const g = 22;
    const hop = f >= 2 ? [0, -3, -4, -1][(f - 2) % 4]! : 0;
    const fur = '#c4844a';
    b.rect(7, g - 3 + hop, 8, 3, mix(fur, '#000000', 0.2));
    for (let i = 0; i < 9; i++) b.rect(6 - i, g - 3 - Math.floor(i / 3) + hop, 2, 2, fur);
    b.ellipse(11, g - 8 + hop, 4.5, 6, fur);
    b.ellipse(12, g - 7 + hop, 2.5, 4, '#e8c08a');
    b.ellipse(15, g - 15 + hop + idleNod(f), 3, 2.6, fur);
    b.rect(13, g - 20 + hop, 2, 4, fur);
    b.set(16, g - 16 + hop + idleNod(f), OUT);
    b.set(18, g - 14 + hop + idleNod(f), OUT);
    b.rect(14, g - 9 + hop, 2, 2, mix(fur, '#000000', 0.2));
  },
});

const penguin = (): AnimalSpec => ({
  key: 'penguin',
  w: 16,
  h: 16,
  description: 'waddling penguin',
  draw: (b, f) => {
    const g = 14;
    const tilt = f >= 2 ? [0, 1, 0, -1][(f - 2) % 4]! : 0;
    b.ellipse(8 + tilt * 0.5, g - 5, 4, 5.5, '#2a2e3a');
    b.ellipse(9 + tilt * 0.5, g - 4.5, 2.5, 4.5, P.white);
    b.ellipse(9, g - 10 + idleNod(f), 3, 2.6, '#2a2e3a');
    b.set(10, g - 10 + idleNod(f), P.white);
    b.set(10, g - 11 + idleNod(f), OUT);
    b.rect(12, g - 10 + idleNod(f), 2, 1, '#f2a23a');
    b.rect(6, g, 2, 1, '#f2a23a');
    b.rect(9, g, 2, 1, '#f2a23a');
    b.rect(4 + tilt, g - 7, 1, 4, '#1a1e2a');
  },
});

const monkey = (): AnimalSpec => ({
  key: 'monkey',
  w: 16,
  h: 16,
  description: 'playful brown monkey',
  draw: (b, f) => {
    const g = 14;
    const y = bob(f);
    const fur = '#8a5a3a';
    for (let i = 0; i < 6; i++) b.set(3 - (i > 3 ? 1 : 0), g - 2 - i + y, fur);
    b.set(4, g - 8 + y, fur);
    b.rect(5 + legShift(f, 0), g - 3, 2, 3, fur);
    b.rect(9 + legShift(f, 1), g - 3, 2, 3, fur);
    b.ellipse(8, g - 5 + y, 3.5, 3, fur);
    b.ellipse(10, g - 9 + y, 3, 2.8, fur);
    b.ellipse(11, g - 8.5 + y, 2, 1.8, '#e8c09a');
    b.set(11, g - 10 + y, OUT);
    b.ellipse(7.5, g - 10 + y, 1.2, 1.2, '#e8c09a');
    if (f === 1) b.rect(12, g - 14, 1, 4, fur);
  },
});

const flamingo = (): AnimalSpec => ({
  key: 'flamingo',
  w: 16,
  h: 24,
  description: 'pink flamingo (stands on one leg when idle)',
  draw: (b, f) => {
    const g = 22;
    const pink = '#f08aa8';
    b.vline(8 + legShift(f, 0), g - 9, g, '#d8607a');
    if (f >= 2) b.vline(9 + legShift(f, 1), g - 9, g, '#d8607a');
    else b.rect(8, g - 6, 3, 1, '#d8607a');
    b.ellipse(7, g - 11, 4.5, 3, pink);
    b.ellipse(6, g - 11, 2.5, 1.5, '#d8607a');
    for (let i = 0; i < 7; i++) b.set(10 + (i > 3 ? 1 : 0) - (i > 5 ? 1 : 0), g - 13 - i, pink);
    b.ellipse(11, g - 20 + idleNod(f), 1.8, 1.6, pink);
    b.rect(12, g - 20 + idleNod(f), 2, 1, '#2a2a2a');
    b.set(13, g - 19 + idleNod(f), '#2a2a2a');
    b.set(11, g - 21 + idleNod(f), OUT);
  },
});

const crocodile = (): AnimalSpec => ({
  key: 'crocodile',
  w: 32,
  h: 16,
  description: 'low green crocodile',
  draw: (b, f) => {
    const g = 14;
    const green = '#5a8a44';
    const dark = '#3f6a30';
    const sway = f >= 2 ? [0, 1, 0, -1][(f - 2) % 4]! : 0;
    for (let i = 0; i < 9; i++)
      b.rect(1 + i, g - 3 + Math.floor((9 - i) / 4) * 0 + (i < 3 ? sway : 0), 2, 2, green);
    b.ellipse(15, g - 3, 7, 2.5, green);
    b.rect(10 + legShift(f, 0), g - 1, 2, 2, dark);
    b.rect(18 + legShift(f, 1), g - 1, 2, 2, dark);
    b.rect(21, g - 5 + (f === 1 ? -1 : 0), 9, 2, green);
    b.rect(21, g - 3, 9, 2, mix(green, '#ffffff', 0.15));
    for (let x = 23; x < 30; x += 2) b.set(x, g - 3, P.white);
    b.set(23, g - 6, OUT);
    for (let x = 6; x < 20; x += 3) b.set(x, g - 5, dark);
  },
});

// ---------------------------------------------------------------- forest animals

const deer = (): AnimalSpec => ({
  key: 'deer',
  w: 24,
  h: 24,
  description: 'shy deer with antlers',
  draw: quadruped({
    w: 24,
    h: 24,
    body: [11, 12, 6, 3.5],
    fur: '#b8763e',
    belly: '#e8c49a',
    legs: [7, 13, 8, 14],
    legW: 1,
    hoof: '#3a2a20',
    head: [19, 6, 2.4, 2],
    neck: 1.5,
    snout: '#e8c49a',
    ears: 'up',
    tail: 'stub',
    tailColor: P.white,
    pattern: (b, f) => {
      for (const [x, y] of [
        [9, 10],
        [12, 11],
        [14, 10],
      ])
        b.set(x!, y! + bob(f), P.white);
    },
    extra: (b, _f, hx, hy) => {
      const ax = Math.round(hx - 1);
      const ay = Math.round(hy - 3);
      b.vline(ax, ay - 3, ay, '#6a4a2a');
      b.set(ax - 1, ay - 2, '#6a4a2a');
      b.set(ax + 1, ay - 3, '#6a4a2a');
      b.set(ax - 1, ay - 4, '#6a4a2a');
    },
  }),
});

const fox = (): AnimalSpec => ({
  key: 'fox',
  w: 24,
  h: 16,
  description: 'red fox with a bushy tail',
  draw: quadruped({
    w: 24,
    h: 16,
    body: [11, 9, 5.5, 2.6],
    fur: '#e0702a',
    belly: '#f6e4cc',
    legs: [7, 13, 8, 14],
    legW: 1,
    legColor: '#3a2a20',
    head: [18, 7, 2.6, 2.2],
    snout: '#f6e4cc',
    ears: 'up',
    tail: 'bushy',
    tailColor: '#e0702a',
  }),
});

const rabbit = (): AnimalSpec => ({
  key: 'rabbit',
  w: 16,
  h: 16,
  description: 'grey-brown rabbit (hops)',
  draw: (b, f) => {
    const g = 14;
    const hop = f >= 2 ? [0, -2, -3, -1][(f - 2) % 4]! : 0;
    const fur = '#a8907a';
    b.ellipse(7, g - 3 + hop, 4, 3, fur);
    b.ellipse(3.5, g - 4 + hop, 1.5, 1.5, P.white);
    b.ellipse(10.5, g - 6 + hop + idleNod(f), 2.8, 2.4, fur);
    b.rect(8, g - 13 + hop, 2, 6, fur);
    b.rect(11, g - 12 + hop, 2, 5, fur);
    b.vline(8, g - 12 + hop, g - 9 + hop, '#e8b0b0');
    b.vline(11, g - 11 + hop, g - 9 + hop, '#e8b0b0');
    b.set(13, g - 5 + hop + idleNod(f), '#e8a0a0');
    b.set(11, g - 7 + hop + idleNod(f), OUT);
    b.rect(5, g - 1 + hop, 3, 1, mix(fur, '#000000', 0.2));
  },
});

const squirrel = (): AnimalSpec => ({
  key: 'squirrel',
  w: 16,
  h: 16,
  description: 'red squirrel with a curled tail',
  draw: (b, f) => {
    const g = 14;
    const hop = f >= 2 ? [0, -1, -2, -1][(f - 2) % 4]! : 0;
    const fur = '#c4582a';
    b.ellipse(4, g - 7 + hop, 2.5, 4, fur);
    b.ellipse(5, g - 10 + hop, 2, 2, fur);
    b.ellipse(8, g - 3 + hop, 3, 2.5, fur);
    b.ellipse(11, g - 6 + hop, 2, 2, fur);
    b.set(11, g - 9 + hop, fur);
    b.set(12, g - 7 + hop, OUT);
    if (f === 1) b.ellipse(12, g - 3, 1, 1, '#8a5a2a');
    b.ellipse(9, g - 3 + hop, 1.5, 1, '#f0d0b0');
  },
});

const hedgehog = (): AnimalSpec => ({
  key: 'hedgehog',
  w: 16,
  h: 16,
  description: 'little hedgehog',
  draw: (b, f) => {
    const g = 14;
    b.ellipse(7, g - 3, 5, 3.2, '#6a5040');
    for (let x = 3; x < 12; x += 2) b.set(x, g - 6 + (x % 4 === 1 ? 0 : 1), '#3a2a20');
    b.ellipse(12, g - 2, 2, 1.6, '#e0c4a0');
    b.set(14, g - 2, OUT);
    b.set(12, g - 3, OUT);
    b.rect(5 + legShift(f, 0), g, 1, 1, '#3a2a20');
    b.rect(9 + legShift(f, 1), g, 1, 1, '#3a2a20');
  },
});

/** Songbird: idle 0-1 (hop), frames 2-5 flying (wings up/down). */
const bird = (key: string, body: Color, wing: Color, description: string): AnimalSpec => ({
  key,
  w: 16,
  h: 16,
  description,
  draw: (b, f) => {
    const fly = f >= 2;
    const lift = fly ? -5 : f === 1 ? -1 : 0;
    const g = 14 + lift;
    b.ellipse(8, g - 3, 3, 2.2, body);
    b.ellipse(10.5, g - 5, 1.8, 1.8, body);
    b.set(12, g - 5, '#e8a23a');
    b.set(11, g - 6, OUT);
    b.rect(4, g - 4, 2, 1, wing);
    if (fly) {
      const up = f % 2 === 0;
      b.rect(6, up ? g - 7 : g - 2, 4, 2, wing);
    } else {
      b.ellipse(7.5, g - 3, 2, 1.2, wing);
      b.vline(8, g - 1, g, '#e8a23a');
    }
  },
});

/** Duck on water: idle 0-1 (bob/dip), 2-5 paddling (ripple). */
const duck = (): AnimalSpec => ({
  key: 'duck',
  w: 16,
  h: 16,
  description: 'mallard duck swimming',
  draw: (b, f) => {
    const g = 12;
    const dip = f === 1 ? 1 : 0;
    b.ellipse(7, g - 2, 4.5, 2.5, '#a88a6a');
    b.ellipse(6, g - 2.5, 2.5, 1.3, '#6a5a4a');
    b.rect(2, g - 3, 2, 1, '#2a2a2a');
    b.ellipse(11, g - 6 + dip, 2, 2, '#2a7a4a');
    b.rect(11, g - 4 + dip, 1, 1, P.white);
    b.rect(13, g - 6 + dip, 2, 1, '#e8c24a');
    b.set(11, g - 7 + dip, OUT);
    const r = f >= 2 ? (f % 2 ? 1 : 0) : 0;
    b.hline(2 - r, 12 + r, g + 1, P.waterLight);
  },
});

/** The post office crow: columns 0-1 idle, 2-4 hop, 5-6 caw (beak open). */
export const CROW_FRAMES = { idle: [0, 1], hop: [2, 3, 4], caw: [5, 6] } as const;
export const crow = (): AnimalSpec => ({
  key: 'crow',
  w: 16,
  h: 16,
  description: 'the post office crow; idle, hop and caw frames',
  draw: (b, f) => {
    const lift = f === 3 ? -3 : f === 2 || f === 4 ? -1 : 0;
    const g = 14 + lift;
    const blk = '#22222e';
    const sheen = '#4a4a6a';
    for (let i = 0; i < 3; i++) b.rect(2 + i, g - 4 + Math.floor(i / 2), 1, 2, blk);
    b.ellipse(8, g - 4, 3.6, 2.6, blk);
    b.ellipse(7, g - 4.5, 2.4, 1.3, sheen);
    const cawUp = f === 5 || f === 6 ? -1 : 0;
    b.ellipse(11, g - 7 + cawUp, 2.2, 2.2, blk);
    b.set(11, g - 8 + cawUp, '#f2f2f2');
    if (f === 6) {
      b.rect(13, g - 9 + cawUp, 2, 1, '#5a5a5a');
      b.rect(13, g - 7 + cawUp, 2, 1, '#5a5a5a');
    } else b.rect(13, g - 7 + cawUp, 3, 1, '#5a5a5a');
    if (f === 3) b.rect(6, g - 8, 4, 2, sheen);
    b.vline(7, g - 1, g + (lift < 0 ? -1 : 0), '#5a5a5a');
    b.vline(9, g - 1, g + (lift < 0 ? -1 : 0), '#5a5a5a');
  },
});

export interface AnimalGroup {
  group: 'farm' | 'zoo' | 'forest' | 'crow';
  species: string;
  age?: 'young' | 'adult' | 'old';
  spec: AnimalSpec;
}

export const ANIMALS: AnimalGroup[] = [
  ...(['calf', 'adult', 'old'] as const).map((k) => ({
    group: 'farm' as const,
    species: 'cow',
    age: k === 'calf' ? ('young' as const) : k,
    spec: cow(k),
  })),
  ...(['lamb', 'adult', 'old'] as const).map((k) => ({
    group: 'farm' as const,
    species: 'sheep',
    age: k === 'lamb' ? ('young' as const) : k,
    spec: sheep(k),
  })),
  ...(['chick', 'adult', 'old'] as const).map((k) => ({
    group: 'farm' as const,
    species: 'chicken',
    age: k === 'chick' ? ('young' as const) : k,
    spec: chicken(k),
  })),
  ...[
    penguin,
    polarBear,
    panda,
    monkey,
    lion,
    zebra,
    giraffe,
    elephant,
    hippo,
    kangaroo,
    flamingo,
    crocodile,
  ].map((fn) => {
    const spec = fn();
    return { group: 'zoo' as const, species: spec.key, spec };
  }),
  ...[
    deer(),
    rabbit(),
    squirrel(),
    hedgehog(),
    fox(),
    bird('bird', '#7a5a3a', '#5a3a2a', 'brown songbird; frames 2-5 fly'),
    bird('bluebird', '#5a86c8', '#3a5a9a', 'bluebird; frames 2-5 fly'),
    duck(),
  ].map((spec) => ({ group: 'forest' as const, species: spec.key, spec })),
];
