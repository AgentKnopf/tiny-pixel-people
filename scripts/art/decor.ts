import { PixelCanvas, type Color } from './canvas.ts';
import { P, ROOFS } from './palette.ts';

/** Home-decorating items placed around the player's cottage (reference "Decorate your cottage" modal). */

export function drawWelcomeRug(): PixelCanvas {
  const c = new PixelCanvas(32, 16);
  c.rect(2, 4, 28, 10, P.redDark);
  c.rect(3, 5, 26, 8, P.red);
  c.rect(5, 7, 22, 4, P.flowerYellow);
  c.rect(6, 8, 20, 2, P.redLight);
  for (let x = 2; x < 30; x += 2) {
    c.set(x, 3, P.white);
    c.set(x, 14, P.white);
  }
  return c;
}

export function drawCushion(): PixelCanvas {
  const c = new PixelCanvas(16, 16);
  const b = new PixelCanvas(16, 16);
  b.rect(3, 6, 10, 7, ROOFS.teal!.base);
  b.rect(4, 6, 8, 2, ROOFS.teal!.light);
  b.set(8, 9, P.flowerYellow);
  b.set(3, 6, [0, 0, 0, 0]);
  b.set(12, 6, [0, 0, 0, 0]);
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

export function drawVase(): PixelCanvas {
  const c = new PixelCanvas(16, 16);
  const b = new PixelCanvas(16, 16);
  b.rect(6, 8, 4, 6, ROOFS.blue!.base);
  b.rect(5, 10, 6, 3, ROOFS.blue!.base);
  b.vline(6, 9, 12, ROOFS.blue!.light);
  b.vline(7, 4, 8, P.cropDark);
  b.vline(9, 3, 8, P.cropDark);
  b.set(6, 3, P.flowerPink);
  b.set(7, 3, P.flowerPink);
  b.set(9, 2, P.flowerWhite);
  b.set(10, 2, P.flowerWhite);
  b.set(8, 4, P.flowerYellow);
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

export function drawLantern(lit: boolean): PixelCanvas {
  const c = new PixelCanvas(16, 16);
  const b = new PixelCanvas(16, 16);
  b.vline(8, 1, 3, P.metal);
  b.rect(5, 4, 6, 8, P.metal);
  b.rect(6, 5, 4, 6, lit ? P.windowLit : '#c8b070');
  b.rect(6, 5, 2, 2, lit ? P.windowLitLight : '#e0d098');
  b.hline(4, 11, 12, P.metal);
  b.hline(6, 9, 3, P.metal);
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

/** Five tiles of string lights hung between two posts (overhead layer). */
export function drawStringLights(): PixelCanvas {
  const c = new PixelCanvas(80, 16);
  const colors: Color[] = [P.flowerYellow, P.flowerPink, P.flowerBlue, P.windowLit, P.crop];
  c.rect(1, 1, 2, 15, P.woodDark);
  c.rect(77, 1, 2, 15, P.woodDark);
  for (let x = 3; x < 77; x++) {
    const t = (x - 3) / 74;
    const y = 2 + Math.round(Math.sin(t * Math.PI) * 5);
    c.set(x, y, P.outline);
    if ((x - 3) % 6 === 3) {
      const col = colors[Math.floor((x - 3) / 6) % colors.length]!;
      c.rect(x - 1, y + 1, 3, 3, col);
      c.set(x, y + 1, '#ffffff');
    }
  }
  return c;
}

export function drawFlag(): PixelCanvas {
  const c = new PixelCanvas(16, 32);
  const b = new PixelCanvas(16, 32);
  b.vline(4, 2, 29, P.metalLight);
  b.vline(5, 2, 29, P.metal);
  b.rect(6, 3, 8, 6, P.red);
  b.rect(6, 5, 8, 2, P.white);
  b.set(14, 4, P.red);
  b.set(14, 7, P.red);
  b.ellipse(4.5, 1.5, 1.5, 1.5, P.flowerYellow);
  b.rect(2, 29, 6, 2, P.stoneMid);
  b.outline(P.outline);
  c.ellipse(5, 31, 4, 1, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

export function drawBirdBath(): PixelCanvas {
  const c = new PixelCanvas(16, 16);
  const b = new PixelCanvas(16, 16);
  b.ellipse(8, 5, 7, 2.5, P.stone);
  b.ellipse(8, 5, 5, 1.5, P.water);
  b.set(6, 4, P.waterLight);
  b.rect(7, 7, 2, 6, P.stoneMid);
  b.rect(5, 13, 6, 2, P.stoneMid);
  b.set(11, 2, '#7a5a3a');
  b.set(12, 2, '#7a5a3a');
  b.set(12, 1, '#7a5a3a');
  b.set(13, 2, P.flowerYellow);
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

export function drawDoorNote(): PixelCanvas {
  const c = new PixelCanvas(16, 16);
  const b = new PixelCanvas(16, 16);
  b.rect(4, 3, 8, 10, P.white);
  b.hline(5, 10, 5, P.stoneMid);
  b.hline(5, 10, 7, P.stoneMid);
  b.hline(5, 8, 9, P.stoneMid);
  b.set(7, 2, P.red);
  b.set(8, 2, P.red);
  b.set(11, 12, P.stone);
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}
