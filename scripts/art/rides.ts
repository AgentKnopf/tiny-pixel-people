import { PixelCanvas, mix, type Color } from './canvas.ts';
import { P } from './palette.ts';
import { drawCarousel, drawFerrisWheel, drawIceCreamTruck } from './v2-tiles.ts';

/** Vehicles and ride animation sheets. */

export const TRAIN_PIECE = { w: 64, h: 32 } as const;
export const TRAIN_ROWS = ['engine', 'carriage_red', 'carriage_green', 'carriage_blue'] as const;
export const FERRIS_FRAMES = 8;
export const CAROUSEL_FRAMES = 6;

function mirror(src: PixelCanvas): PixelCanvas {
  const out = new PixelCanvas(src.width, src.height);
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const c = src.get(x, y);
      if (c[3]) out.set(src.width - 1 - x, y, c);
    }
  return out;
}

function wheel(b: PixelCanvas, cx: number, cy: number, r: number, frame: number): void {
  b.ellipse(cx, cy, r, r, '#2a2a32');
  b.ellipse(cx, cy, r - 1.2, r - 1.2, '#8a8e98');
  const a = (frame * Math.PI) / 4;
  for (let i = 0; i < 2; i++) {
    const t = a + (i * Math.PI) / 2;
    for (let d = -r + 1.5; d <= r - 1.5; d += 0.5)
      b.set(cx + Math.cos(t) * d, cy + Math.sin(t) * d, '#4a4a52');
  }
  b.set(cx, cy, '#d8d4cc');
}

/** Steam engine facing left (chimney at the front). */
function engine(frame: number): PixelCanvas {
  const { w, h } = TRAIN_PIECE;
  const b = new PixelCanvas(w, h);
  const body = '#2f5a8a';
  const bodyLight = '#4a7ab0';
  b.rect(8, 22, 52, 4, '#3a3a42');
  b.rect(10, 11, 34, 11, body);
  b.hline(10, 43, 11, bodyLight);
  b.hline(10, 43, 16, '#d8a23a');
  b.rect(42, 3, 18, 19, '#8a2e2a');
  b.rect(44, 6, 6, 6, P.glassLight);
  b.rect(52, 6, 6, 6, P.glassLight);
  b.rect(40, 1, 22, 3, '#3a3a42');
  b.rect(14, 3, 6, 8, '#3a3a42');
  b.rect(13, 2, 8, 2, '#2a2a32');
  b.ellipse(28, 10, 3, 2, '#d8a23a');
  b.rect(2, 22, 7, 3, '#8a2e2a');
  for (let i = 0; i < 4; i++) b.set(2 + i, 25 - i, '#d8d4cc');
  b.ellipse(9, 16, 2, 2, P.windowLitLight);
  wheel(b, 18, 26, 5, frame);
  wheel(b, 31, 26, 5, frame + 1);
  wheel(b, 50, 27, 4, frame);
  b.hline(18, 31, 26, '#c8ccd4');
  b.outline(P.outline);
  const c = new PixelCanvas(w, h);
  const puff = frame % 2 === 0;
  c.ellipse(puff ? 17 : 21, puff ? 0 : -1, 4, 3, '#e8e8ec');
  c.blit(b, 0, 0);
  if (!puff) c.ellipse(15, 1, 2, 1.5, '#f6f6f8');
  return c;
}

function carriage(color: Color, frame: number): PixelCanvas {
  const { w, h } = TRAIN_PIECE;
  const b = new PixelCanvas(w, h);
  const light = mix(color, '#ffffff', 0.25);
  const dark = mix(color, '#000000', 0.25);
  b.rect(2, 22, 60, 3, '#3a3a42');
  b.rect(3, 6, 58, 16, color);
  b.hline(3, 60, 6, light);
  b.hline(3, 60, 18, dark);
  b.rect(2, 3, 60, 3, dark);
  for (let i = 0; i < 4; i++) {
    const x = 8 + i * 13;
    b.rect(x, 9, 9, 7, P.glassLight);
    b.rect(x, 9, 9, 2, P.glass);
    if ((i + frame) % 3 === 0) b.ellipse(x + 4, 14, 2, 2.5, '#5a4a3a');
  }
  wheel(b, 12, 26, 4, frame);
  wheel(b, 22, 26, 4, frame + 1);
  wheel(b, 42, 26, 4, frame);
  wheel(b, 52, 26, 4, frame + 1);
  b.rect(0, 20, 2, 2, '#3a3a42');
  b.rect(62, 20, 2, 2, '#3a3a42');
  b.outline(P.outline);
  return b;
}

/** Train sheet: rows engine + 3 carriages facing left (rows 0-3) and facing right (rows 4-7); 2 frames each. */
export function drawTrainSheet(): PixelCanvas {
  const { w, h } = TRAIN_PIECE;
  const sheet = new PixelCanvas(w * 2, h * 8);
  const pieces = [
    (f: number) => engine(f),
    (f: number) => carriage('#b04a3a', f),
    (f: number) => carriage('#4f8a52', f),
    (f: number) => carriage('#3f6aa0', f),
  ];
  pieces.forEach((draw, row) => {
    for (let f = 0; f < 2; f++) {
      const left = draw(f);
      sheet.blit(left, f * w, row * h);
      sheet.blit(mirror(left), f * w, (row + 4) * h);
    }
  });
  return sheet;
}

/** Coaster car seen from above with two riders; columns face east, south, west, north. */
export function drawCoasterCarSheet(): PixelCanvas {
  const sheet = new PixelCanvas(64, 16);
  for (let d = 0; d < 4; d++) {
    const b = new PixelCanvas(16, 16);
    const horiz = d % 2 === 0;
    if (horiz) {
      b.rect(1, 4, 14, 8, '#e8c24a');
      b.rect(2, 5, 12, 6, '#d44a3a');
      b.ellipse(5.5, 8, 2, 2, '#5a3a26');
      b.ellipse(10.5, 8, 2, 2, '#e8c060');
      b.rect(d === 0 ? 14 : 0, 5, 2, 6, '#8a8e98');
    } else {
      b.rect(4, 1, 8, 14, '#e8c24a');
      b.rect(5, 2, 6, 12, '#d44a3a');
      b.ellipse(8, 5.5, 2, 2, '#5a3a26');
      b.ellipse(8, 10.5, 2, 2, '#e8c060');
      b.rect(5, d === 1 ? 14 : 0, 6, 2, '#8a8e98');
    }
    b.outline(P.outline);
    sheet.blit(b, d * 16, 0);
  }
  return sheet;
}

export function drawFerrisSheet(): PixelCanvas {
  const first = drawFerrisWheel(0);
  const sheet = new PixelCanvas(first.width * FERRIS_FRAMES, first.height);
  for (let f = 0; f < FERRIS_FRAMES; f++)
    sheet.blit(drawFerrisWheel((f / FERRIS_FRAMES) * ((Math.PI * 2) / 8)), f * first.width, 0);
  return sheet;
}

export function drawCarouselSheet(): PixelCanvas {
  const first = drawCarousel(0);
  const sheet = new PixelCanvas(first.width * CAROUSEL_FRAMES, first.height);
  for (let f = 0; f < CAROUSEL_FRAMES; f++)
    sheet.blit(drawCarousel((f / CAROUSEL_FRAMES) * ((Math.PI * 2) / 6)), f * first.width, 0);
  return sheet;
}

export function drawIceCreamSheet(): PixelCanvas {
  const sheet = new PixelCanvas(64, 16);
  for (let f = 0; f < 2; f++) sheet.blit(drawIceCreamTruck(f), f * 32, 0);
  return sheet;
}
