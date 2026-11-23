export type Rgba = [number, number, number, number];
export type Color = string | Rgba;

export function rgba(color: Color): Rgba {
  if (typeof color !== 'string') return color;
  const hex = color.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) : 255;
  return [r, g, b, a];
}

/** Mixes two colours; t = 0 gives a, t = 1 gives b. */
export function mix(a: Color, b: Color, t: number): Rgba {
  const ca = rgba(a);
  const cb = rgba(b);
  return [0, 1, 2, 3].map((i) => Math.round(ca[i]! + (cb[i]! - ca[i]!) * t)) as Rgba;
}

/** Deterministic PRNG (mulberry32) so regenerated art is byte-identical. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class PixelCanvas {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4);
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): Rgba {
    if (!this.inside(x, y)) return [0, 0, 0, 0];
    const i = (y * this.width + x) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!, this.data[i + 3]!];
  }

  alpha(x: number, y: number): number {
    return this.inside(x, y) ? this.data[(y * this.width + x) * 4 + 3]! : 0;
  }

  /** Source-over blend of one pixel. */
  set(x: number, y: number, color: Color): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (!this.inside(x, y)) return;
    const [r, g, b, a] = rgba(color);
    const i = (y * this.width + x) * 4;
    if (a === 255) {
      this.data.set([r, g, b, 255], i);
      return;
    }
    if (a === 0) return;
    const da = this.data[i + 3]! / 255;
    const sa = a / 255;
    const oa = sa + da * (1 - sa);
    for (let k = 0; k < 3; k++) {
      const sc = [r, g, b][k]!;
      this.data[i + k] = Math.round((sc * sa + this.data[i + k]! * da * (1 - sa)) / oa);
    }
    this.data[i + 3] = Math.round(oa * 255);
  }

  clear(x: number, y: number): void {
    if (this.inside(x, y)) this.data.fill(0, (y * this.width + x) * 4, (y * this.width + x) * 4 + 4);
  }

  rect(x: number, y: number, w: number, h: number, color: Color): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, color);
  }

  hline(x0: number, x1: number, y: number, color: Color): void {
    for (let x = x0; x <= x1; x++) this.set(x, y, color);
  }

  vline(x: number, y0: number, y1: number, color: Color): void {
    for (let y = y0; y <= y1; y++) this.set(x, y, color);
  }

  /** Filled ellipse centred on (cx, cy) with radii rx, ry (pixel-centre test). */
  ellipse(cx: number, cy: number, rx: number, ry: number, color: Color): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x, y, color);
      }
    }
  }

  /** Draws a pixel mask given as rows of characters; each character maps to a colour (space = skip). */
  pattern(x: number, y: number, rows: string[], colors: Record<string, Color>): void {
    rows.forEach((row, dy) => {
      [...row].forEach((ch, dx) => {
        const c = colors[ch];
        if (c !== undefined) this.set(x + dx, y + dy, c);
      });
    });
  }

  /** Adds a 1-px outline around all opaque pixels (4-neighbour), in place. */
  outline(color: Color): void {
    const marks: [number, number][] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.alpha(x, y) > 0) continue;
        if (
          this.alpha(x - 1, y) > 128 ||
          this.alpha(x + 1, y) > 128 ||
          this.alpha(x, y - 1) > 128 ||
          this.alpha(x, y + 1) > 128
        )
          marks.push([x, y]);
      }
    }
    for (const [x, y] of marks) this.set(x, y, color);
  }

  blit(src: PixelCanvas, dx: number, dy: number, sx = 0, sy = 0, w = src.width, h = src.height): void {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = src.get(sx + x, sy + y);
        if (c[3] > 0) this.set(dx + x, dy + y, c);
      }
    }
  }

  crop(x: number, y: number, w: number, h: number): PixelCanvas {
    const out = new PixelCanvas(w, h);
    out.blit(this, 0, 0, x, y, w, h);
    return out;
  }

  /** Nearest-neighbour upscale by an integer factor. */
  scaled(factor: number): PixelCanvas {
    const out = new PixelCanvas(this.width * factor, this.height * factor);
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const i = (y * out.width + x) * 4;
        const j = (Math.floor(y / factor) * this.width + Math.floor(x / factor)) * 4;
        out.data.set(this.data.subarray(j, j + 4), i);
      }
    }
    return out;
  }

  /** Applies a function to every opaque pixel's colour. */
  map(fn: (c: Rgba, x: number, y: number) => Rgba): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = (y * this.width + x) * 4;
        if (this.data[i + 3] === 0) continue;
        this.data.set(fn(this.get(x, y), x, y), i);
      }
    }
  }
}

/** 3×5 pixel font for signs (upper case, digits and a few symbols). */
const FONT_3X5: Record<string, string[]> = {
  A: ['###', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['###', '#..', '#..', '#..', '###'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['###', '#..', '#.#', '#.#', '###'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '###'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['##.', '#.#', '#.#', '#.#', '#.#'],
  O: ['###', '#.#', '#.#', '#.#', '###'],
  P: ['###', '#.#', '###', '#..', '#..'],
  Q: ['###', '#.#', '#.#', '###', '..#'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['###', '#..', '###', '..#', '###'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#.#', '#.#', '###', '###', '#.#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '&': ['.#.', '#.#', '.#.', '#.#', '.##'],
  ' ': ['...', '...', '...', '...', '...'],
};

export function textWidth(text: string): number {
  return text.length * 4 - 1;
}

export function drawText(c: PixelCanvas, x: number, y: number, text: string, color: Color): void {
  [...text.toUpperCase()].forEach((ch, i) => {
    const glyph = FONT_3X5[ch] ?? FONT_3X5[' ']!;
    c.pattern(
      x + i * 4,
      y,
      glyph.map((r) => r.replaceAll('.', ' ')),
      { '#': color },
    );
  });
}
