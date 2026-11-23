import { PixelCanvas, drawText, mix, rng, textWidth, type Color } from './canvas.ts';
import { P, ROOFS } from './palette.ts';
import { extendAtlasForest } from './forest.ts';
import { E, N, S, TILE, W, terrainTile, type TerrainStyle, type TileAtlas } from './tiles.ts';

/** v2 terrains, props and buildings: zoo, rides, farmstead, station and hotel (docs/art/README.md). */

const GRAVEL: TerrainStyle = {
  inset: 1,
  edge: '#8a8070',
  fill: (_c, x, y, r) => {
    const v = r();
    if (v < 0.15) return '#7a7064';
    if (v < 0.3) return '#b8ae9a';
    return (x + y) % 5 === 0 ? '#9a9080' : '#a89e8c';
  },
};

const PAVING: TerrainStyle = {
  inset: 1,
  edge: P.stoneDark,
  fill: (_c, x, y) => {
    if (x % 8 === 0 || y % 8 === 0) return P.stoneMid;
    return (x + y) % 7 === 0 ? '#e2ddd0' : P.stone;
  },
};

const SAVANNA: TerrainStyle = {
  inset: 2,
  edge: '#b8a050',
  fill: (_c, x, y, r) => {
    const v = r();
    if (v < 0.1) return '#a89040';
    if (v < 0.25) return '#e8d48a';
    return (x * 3 + y) % 13 === 0 ? '#b8a050' : '#d8c070';
  },
};

const SNOW: TerrainStyle = {
  inset: 1,
  edge: '#9ab4c8',
  rim: '#c8dce8',
  fill: (_c, _x, _y, r) => (r() < 0.12 ? '#dcebf4' : '#f2f8fc'),
};

const MUD: TerrainStyle = {
  inset: 2,
  edge: '#6a4a30',
  fill: (_c, x, y, r) => (r() < 0.15 ? '#5a3c26' : (x + y) % 9 === 0 ? '#9a7050' : '#7e5a3c'),
};

export const V2_TERRAINS: [string, TerrainStyle][] = [
  ['gravel', GRAVEL],
  ['paving', PAVING],
  ['savanna', SAVANNA],
  ['snow', SNOW],
  ['mud', MUD],
];

function zooFenceTile(mask: number): PixelCanvas {
  const c = new PixelCanvas(TILE, TILE);
  const f = new PixelCanvas(TILE, TILE);
  const bar = '#5a5e68';
  const barLight = '#8a8e98';
  const rail = (x0: number, x1: number) => {
    f.hline(x0, x1, 4, barLight);
    f.hline(x0, x1, 12, bar);
    for (let x = x0; x <= x1; x++) if (x % 3 === 1) f.vline(x, 4, 12, bar);
  };
  if (mask & W) rail(0, 7);
  if (mask & E) rail(8, 15);
  if (mask & N) {
    f.rect(7, 0, 2, 5, bar);
    f.vline(7, 0, 4, barLight);
  }
  if (mask & S) f.rect(7, 10, 2, 6, bar);
  f.rect(6, 2, 4, 12, '#4a4e58');
  f.hline(6, 9, 2, barLight);
  f.outline(P.outline);
  c.blit(f, 0, 0);
  return c;
}

function coasterTile(mask: number): PixelCanvas {
  const c = new PixelCanvas(TILE, TILE);
  const t = new PixelCanvas(TILE, TILE);
  const steel = '#d44a3a';
  const steelLight = '#f07a5a';
  const sleeper = '#6a6e78';
  const horiz = (x0: number, x1: number) => {
    for (let x = x0; x <= x1; x += 3) t.vline(x, 4, 11, sleeper);
    t.hline(x0, x1, 5, steelLight);
    t.hline(x0, x1, 10, steel);
  };
  const vert = (y0: number, y1: number) => {
    for (let y = y0; y <= y1; y += 3) t.hline(4, 11, y, sleeper);
    t.vline(5, y0, y1, steelLight);
    t.vline(10, y0, y1, steel);
  };
  if (mask & W) horiz(0, 8);
  if (mask & E) horiz(7, 15);
  if (mask & N) vert(0, 8);
  if (mask & S) vert(7, 15);
  if (mask === 0) horiz(0, 15);
  t.outline('#3a2a28');
  c.ellipse(8, 14, 3, 1, P.shadow);
  c.rect(7, 11, 2, 4, '#8a8e98');
  c.blit(t, 0, 0);
  return c;
}

function railTile(): PixelCanvas {
  const c = new PixelCanvas(TILE, TILE);
  for (let x = 1; x < 16; x += 4) c.rect(x, 3, 2, 10, '#6e4a30');
  c.hline(0, 15, 5, '#c8ccd4');
  c.hline(0, 15, 6, '#6a6e78');
  c.hline(0, 15, 10, '#c8ccd4');
  c.hline(0, 15, 11, '#6a6e78');
  return c;
}

function platformLine(): PixelCanvas {
  const c = new PixelCanvas(TILE, TILE);
  for (let x = 0; x < 16; x++) if (x % 4 < 2) c.set(x, 14, '#f2c94c');
  c.hline(0, 15, 15, P.stoneDark);
  return c;
}

function drawBarn(): PixelCanvas {
  const Wd = 7 * TILE;
  const H = 5 * TILE;
  const c = new PixelCanvas(Wd, H);
  const b = new PixelCanvas(Wd, H);
  const red = '#b04a3a';
  const redDark = '#8a3428';
  const roofH = 40;
  b.rect(1, roofH - 2, Wd - 2, H - roofH + 1, red);
  for (let x = 4; x < Wd - 2; x += 5) b.vline(x, roofH, H - 4, redDark);
  b.rect(1, H - 3, Wd - 2, 2, P.stoneMid);
  const dx = 3 * TILE - 6;
  b.rect(dx, H - 28, 28, 26, P.white);
  b.rect(dx + 2, H - 26, 24, 24, redDark);
  for (let i = 0; i < 24; i++) {
    b.set(dx + 2 + i, H - 26 + i, P.white);
    b.set(dx + 25 - i, H - 26 + i, P.white);
  }
  b.vline(dx + 14, H - 26, H - 3, P.white);
  b.rect(16, roofH + 6, 14, 10, P.white);
  b.rect(18, roofH + 8, 10, 6, '#3a2a20');
  b.rect(Wd - 30, roofH + 6, 14, 10, P.white);
  b.rect(Wd - 28, roofH + 8, 10, 6, '#3a2a20');
  for (let y = 0; y < roofH; y++) {
    const inset = Math.round((1 - y / roofH) * 10);
    b.hline(inset, Wd - 1 - inset, y, y % 4 === 3 ? '#4a4e58' : y < 3 ? '#8a8e98' : '#6a6e78');
  }
  b.hline(0, Wd - 1, roofH - 1, '#3a3e48');
  b.rect(Wd / 2 - 6, 8, 12, 10, P.white);
  b.rect(Wd / 2 - 4, 10, 8, 6, '#e8c25a');
  b.outline(P.outline);
  c.rect(2, H - 1, Wd - 2, 1, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawCoop(): PixelCanvas {
  const c = new PixelCanvas(48, 48);
  const b = new PixelCanvas(48, 48);
  b.rect(4, 22, 40, 22, P.woodLight);
  for (let x = 6; x < 44; x += 4) b.vline(x, 23, 43, P.wood);
  b.rect(19, 30, 10, 14, P.woodDarker);
  b.rect(30, 26, 8, 6, '#f2c464');
  for (let y = 0; y < 22; y++) {
    const inset = Math.max(0, 12 - Math.floor(y / 1.6));
    b.hline(2 + inset, 45 - inset, y + 2, y % 4 === 3 ? ROOFS.brown!.dark : ROOFS.brown!.base);
  }
  b.hline(2, 45, 23, ROOFS.brown!.dark);
  b.outline(P.outline);
  c.ellipse(24, 46, 21, 1.5, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawSignBoard(
  lines: string[],
  w = 80,
  board: Color = P.wood,
  boardLight: Color = P.woodLight,
  ink: Color = P.woodDarker,
): PixelCanvas {
  const c = new PixelCanvas(w, 32);
  const b = new PixelCanvas(w, 32);
  b.rect(10, 18, 3, 12, P.woodDark);
  b.rect(w - 13, 18, 3, 12, P.woodDark);
  b.rect(4, 3, w - 8, 17, board);
  b.rect(5, 4, w - 10, 15, boardLight);
  lines.forEach((line, i) =>
    drawText(b, Math.floor((w - textWidth(line)) / 2), lines.length === 1 ? 9 : 5 + i * 7, line, ink),
  );
  b.outline(P.outline);
  c.ellipse(w / 2, 30, w / 2 - 6, 1.5, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawPillar(flag: Color): PixelCanvas {
  const c = new PixelCanvas(16, 32);
  const b = new PixelCanvas(16, 32);
  b.rect(4, 10, 8, 19, P.stone);
  b.vline(4, 10, 28, '#ffffff');
  b.vline(11, 10, 28, P.stoneMid);
  b.rect(3, 8, 10, 3, P.stoneMid);
  b.rect(3, 28, 10, 2, P.stoneDark);
  b.vline(8, 0, 8, P.metal);
  b.rect(9, 1, 6, 4, flag);
  b.outline(P.outline);
  c.ellipse(8, 30.5, 5, 1.2, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawAcacia(): PixelCanvas {
  const c = new PixelCanvas(32, 32);
  const b = new PixelCanvas(32, 32);
  b.vline(15, 14, 28, P.trunk);
  b.vline(16, 14, 28, P.trunk);
  b.set(13, 15, P.trunk);
  b.set(18, 15, P.trunk);
  b.ellipse(16, 10, 14, 5, P.leafDark);
  b.ellipse(15, 9, 12, 3.5, P.leaf);
  b.ellipse(11, 8, 5, 1.5, P.leafLight);
  b.outline(P.outline);
  c.ellipse(16, 29.5, 10, 2, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawPalm(): PixelCanvas {
  const c = new PixelCanvas(32, 32);
  const b = new PixelCanvas(32, 32);
  for (let y = 10; y < 29; y++)
    b.rect(15 + Math.round(Math.sin(y / 5)), y, 3, 1, y % 3 === 0 ? P.woodDark : P.wood);
  const frond = (dx: number, dy: number) => {
    for (let i = 0; i < 10; i++)
      b.rect(
        16 + Math.round(dx * i),
        9 + Math.round(dy * i + (i * i) / 14),
        2,
        2,
        i % 3 ? P.leaf : P.leafLight,
      );
  };
  frond(1, -0.3);
  frond(-1, -0.3);
  frond(0.7, 0.4);
  frond(-0.7, 0.4);
  frond(0.2, -0.8);
  b.ellipse(16, 10, 2, 2, P.woodDark);
  b.outline(P.outline);
  c.ellipse(16, 29.5, 8, 2, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawBamboo(seed: number): PixelCanvas {
  const c = new PixelCanvas(16, 32);
  const b = new PixelCanvas(16, 32);
  const r = rng(seed);
  for (const x of [3, 7, 11]) {
    const top = 2 + Math.floor(r() * 6);
    b.vline(x, top, 30, '#7ab04a');
    b.vline(x + 1, top, 30, '#5a8a3a');
    for (let y = top + 4; y < 30; y += 6) b.hline(x, x + 1, y, '#3a6a2a');
    b.rect(x - 2, top + 2, 2, 1, P.leafLight);
    b.rect(x + 2, top + 5, 2, 1, P.leafLight);
  }
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

function drawBigRock(): PixelCanvas {
  const c = new PixelCanvas(32, 32);
  const b = new PixelCanvas(32, 32);
  b.ellipse(16, 18, 13, 10, '#8a8478');
  b.ellipse(14, 15, 10, 7, '#a8a294');
  b.ellipse(11, 12, 5, 3, '#c4bfb2');
  b.ellipse(22, 22, 5, 3, '#6e6a60');
  b.outline(P.outline);
  c.ellipse(16, 28, 13, 3, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawLog(): PixelCanvas {
  const c = new PixelCanvas(32, 16);
  const b = new PixelCanvas(32, 16);
  b.rect(3, 5, 26, 7, P.wood);
  b.hline(3, 28, 6, P.woodLight);
  b.ellipse(28, 8.5, 2.5, 3.5, P.woodLight);
  b.ellipse(28, 8.5, 1.2, 1.8, P.woodDark);
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

function drawHay(): PixelCanvas {
  const c = new PixelCanvas(16, 16);
  const b = new PixelCanvas(16, 16);
  b.rect(2, 4, 12, 10, P.wheat);
  for (let y = 5; y < 14; y += 2) b.hline(2, 13, y, P.wheatDark);
  b.vline(5, 4, 13, '#a07a30');
  b.vline(10, 4, 13, '#a07a30');
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

function drawTrough(): PixelCanvas {
  const c = new PixelCanvas(32, 16);
  const b = new PixelCanvas(32, 16);
  b.rect(2, 5, 28, 8, P.woodDark);
  b.rect(4, 6, 24, 4, P.water);
  b.hline(4, 27, 6, P.waterLight);
  b.rect(3, 13, 2, 2, P.woodDarker);
  b.rect(27, 13, 2, 2, P.woodDarker);
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

function drawChurn(): PixelCanvas {
  const c = new PixelCanvas(16, 16);
  const b = new PixelCanvas(16, 16);
  b.rect(5, 5, 6, 9, '#c8ccd4');
  b.rect(6, 3, 4, 2, '#a8acb4');
  b.vline(6, 6, 12, '#ffffff');
  b.hline(5, 10, 9, '#8a8e98');
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

/** Ice cream truck, 2×1 tiles, viewed from the side (serving hatch faces the viewer). */
export function drawIceCreamTruck(frame = 0): PixelCanvas {
  const c = new PixelCanvas(32, 16);
  const b = new PixelCanvas(32, 16);
  b.rect(1, 3, 22, 9, '#f6d6e8');
  b.rect(23, 6, 8, 6, '#f6d6e8');
  b.rect(25, 7, 4, 3, P.glassLight);
  b.rect(4, 5, 14, 5, '#fffaea');
  b.rect(5, 6, 12, 3, frame % 2 ? '#f6b8d0' : '#ee8fb4');
  b.hline(1, 22, 3, '#ee8fb4');
  b.ellipse(11, 1.5, 2, 1.5, '#e8a858');
  b.set(11, 0, '#fbf0d9');
  b.set(frame % 2 ? 12 : 10, 0, '#ee8fb4');
  b.ellipse(6, 13, 2, 2, '#3a3a42');
  b.ellipse(25, 13, 2, 2, '#3a3a42');
  b.set(6, 13, '#8a8e98');
  b.set(25, 13, '#8a8e98');
  b.outline(P.outline);
  c.ellipse(16, 15, 15, 1, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawFoodCart(color: string, colorLight: string, goods: Color): PixelCanvas {
  const c = new PixelCanvas(16, 32);
  const b = new PixelCanvas(16, 32);
  b.rect(1, 16, 14, 10, color);
  b.hline(1, 14, 16, colorLight);
  b.rect(3, 12, 10, 4, '#fffaea');
  for (let i = 0; i < 4; i++) b.ellipse(5 + i * 2, 12, 1.5, 1.2, goods);
  b.vline(2, 4, 16, P.metal);
  b.vline(13, 4, 16, P.metal);
  for (let x = 0; x < 16; x++) b.rect(x, 2, 1, 4 + (x % 4 < 2 ? 1 : 0), x % 4 < 2 ? color : P.white);
  b.ellipse(4, 27, 2, 2, '#3a3a42');
  b.ellipse(12, 27, 2, 2, '#3a3a42');
  b.outline(P.outline);
  c.ellipse(8, 30, 6, 1.2, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawPicnicTable(): PixelCanvas {
  const c = new PixelCanvas(32, 32);
  const b = new PixelCanvas(32, 32);
  b.rect(3, 4, 26, 3, P.wood);
  b.rect(2, 11, 28, 10, P.woodLight);
  for (let y = 13; y < 21; y += 3) b.hline(2, 29, y, P.wood);
  b.rect(3, 25, 26, 3, P.wood);
  b.rect(10, 13, 12, 5, '#e85a4a');
  for (let x = 10; x < 22; x += 2) for (let y = 13; y < 18; y += 2) b.set(x, y, P.white);
  b.outline(P.outline);
  c.ellipse(16, 30, 14, 1.5, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawBin(): PixelCanvas {
  const c = new PixelCanvas(16, 16);
  const b = new PixelCanvas(16, 16);
  b.rect(4, 4, 8, 10, '#4f8a52');
  b.rect(3, 3, 10, 2, '#3a6a3c');
  b.vline(6, 6, 12, '#6aa86c');
  b.vline(9, 6, 12, '#6aa86c');
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

function drawBalloons(): PixelCanvas {
  const c = new PixelCanvas(16, 32);
  const b = new PixelCanvas(16, 32);
  const cols = [P.red, P.flowerYellow, P.flowerBlue, P.flowerPink, '#8fd16a'];
  const pos = [
    [4, 5],
    [11, 4],
    [8, 9],
    [3, 12],
    [12, 11],
  ];
  pos.forEach(([x, y], i) => {
    b.vline(8, y! + 3, 24, '#5a5a5a');
    b.ellipse(x!, y!, 2.8, 3.2, cols[i]!);
    b.set(x! - 1, y! - 1, '#ffffff');
  });
  b.rect(5, 24, 6, 5, P.wood);
  b.outline(P.outline);
  c.ellipse(8, 30, 5, 1, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawLounger(): PixelCanvas {
  const c = new PixelCanvas(16, 32);
  const b = new PixelCanvas(16, 32);
  b.rect(3, 6, 10, 22, P.white);
  b.rect(3, 6, 10, 8, '#7ab4e0');
  for (let y = 15; y < 28; y += 3) b.hline(3, 12, y, '#d4c8ae');
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

function drawUmbrella(color: Color): PixelCanvas {
  const c = new PixelCanvas(32, 32);
  const b = new PixelCanvas(32, 32);
  b.ellipse(16, 12, 13, 9, color);
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    for (let d = 0; d < 12; d++)
      if (a % 2 === 0) b.set(16 + Math.cos(ang) * d, 12 + Math.sin(ang) * d * 0.7, P.white);
  }
  b.ellipse(16, 12, 1.5, 1.5, P.metal);
  b.outline(P.outline);
  c.ellipse(16, 24, 10, 3, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

/** Ferris wheel 6×7 tiles; `angle` rotates the wheel (frames for rides/ferris-wheel.png). */
export function drawFerrisWheel(angle: number): PixelCanvas {
  const Wd = 96;
  const H = 112;
  const c = new PixelCanvas(Wd, H);
  const b = new PixelCanvas(Wd, H);
  const cx = 48;
  const cy = 44;
  const R = 38;
  b.rect(16, 100, 64, 8, P.stoneMid);
  b.hline(16, 79, 100, P.stone);
  for (let t = 0; t <= 1; t += 0.01) {
    b.rect(Math.round(cx - 4 - t * 26), Math.round(cy + t * 56), 3, 1, '#6a6e78');
    b.rect(Math.round(cx + 2 + t * 26), Math.round(cy + t * 56), 3, 1, '#6a6e78');
  }
  for (let a = 0; a < 360; a += 0.7) {
    const r = (a * Math.PI) / 180;
    b.set(cx + Math.cos(r) * R, cy + Math.sin(r) * R, '#e8e4dc');
    b.set(cx + Math.cos(r) * (R - 1), cy + Math.sin(r) * (R - 1), '#b8b4ac');
    b.set(cx + Math.cos(r) * (R - 12), cy + Math.sin(r) * (R - 12), '#c8c4bc');
  }
  const spokes = 8;
  const gondola = [
    P.red,
    P.flowerYellow,
    P.flowerBlue,
    '#8fd16a',
    P.flowerPink,
    '#b49ad0',
    P.autumn,
    '#7ab4e0',
  ];
  for (let i = 0; i < spokes; i++) {
    const r = angle + (i / spokes) * Math.PI * 2;
    for (let d = 0; d < R; d += 0.5) b.set(cx + Math.cos(r) * d, cy + Math.sin(r) * d, '#d8d4cc');
  }
  b.ellipse(cx, cy, 4, 4, '#8a8e98');
  b.ellipse(cx, cy, 2, 2, P.flowerYellow);
  for (let i = 0; i < spokes; i++) {
    const r = angle + (i / spokes) * Math.PI * 2;
    const gx = Math.round(cx + Math.cos(r) * R);
    const gy = Math.round(cy + Math.sin(r) * R);
    b.vline(gx, gy, gy + 3, P.metal);
    b.rect(gx - 4, gy + 3, 9, 7, gondola[i]!);
    b.rect(gx - 3, gy + 4, 7, 2, P.glassLight);
    b.hline(gx - 5, gx + 5, gy + 3, mix(gondola[i]!, '#000000', 0.3));
  }
  b.outline(P.outline);
  c.ellipse(48, 108, 34, 3, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

/** Carousel 5×5 tiles seen from above: striped round canopy; `phase` rotates the stripes. */
export function drawCarousel(phase: number): PixelCanvas {
  const S2 = 80;
  const c = new PixelCanvas(S2, S2);
  const b = new PixelCanvas(S2, S2);
  const cx = 40;
  const cy = 38;
  b.ellipse(cx, cy + 6, 36, 30, '#c8a070');
  b.ellipse(cx, cy + 5, 34, 28, '#e8c890');
  const cols = [P.red, P.white, '#7ab4e0', P.white, P.flowerYellow, P.white];
  for (let y = 0; y < S2; y++)
    for (let x = 0; x < S2; x++) {
      const dx = x + 0.5 - cx;
      const dy = (y + 0.5 - cy) * 1.15;
      const d = Math.hypot(dx, dy);
      if (d > 31) continue;
      const a = Math.atan2(dy, dx) + phase;
      const seg = Math.floor(((a / (Math.PI * 2)) * 12 + 120) % 12);
      let col: Color = cols[seg % cols.length]!;
      if (d > 28) col = mix(col, '#000000', 0.2);
      if (d < 4) col = P.flowerYellow;
      b.set(x, y, col);
    }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + phase;
    b.ellipse(cx + Math.cos(a) * 30, cy + Math.sin(a) * 26, 1.5, 1.5, P.flowerYellow);
  }
  b.vline(cx, cy - 10, cy - 4, '#d4a23a');
  b.ellipse(cx, cy - 11, 2, 2, P.red);
  b.outline(P.outline);
  c.ellipse(cx, cy + 10, 36, 28, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawCoasterStation(): PixelCanvas {
  const c = new PixelCanvas(48, 32);
  const b = new PixelCanvas(48, 32);
  b.rect(2, 12, 44, 18, P.stone);
  for (let x = 2; x < 46; x += 8) b.vline(x, 12, 29, P.stoneMid);
  b.rect(4, 14, 3, 14, P.metal);
  b.rect(41, 14, 3, 14, P.metal);
  for (let x = 0; x < 48; x++) b.rect(x, 2, 1, 10, Math.floor(x / 6) % 2 ? P.red : P.flowerYellow);
  b.hline(0, 47, 11, P.redDark);
  drawText(b, 11, 4, 'RIDES', P.outline);
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

export function extendAtlasV2(atlas: TileAtlas): void {
  V2_TERRAINS.forEach(([name, style], ti) => {
    for (let mask = 0; mask < 16; mask++) atlas.add(`${name}_${mask}`, terrainTile(style, mask, 20 + ti));
  });
  for (let mask = 0; mask < 16; mask++) atlas.add(`zfence_${mask}`, zooFenceTile(mask));
  for (let mask = 0; mask < 16; mask++) atlas.add(`coaster_${mask}`, coasterTile(mask));
  atlas.add('rail_h', railTile());
  atlas.add('platform_line', platformLine());

  const o = atlas.addObject.bind(atlas);
  const block = (w: number, h: number, free: [number, number][] = []): (0 | 1)[][] =>
    Array.from({ length: h }, (_, y) =>
      Array.from({ length: w }, (_, x) => (free.some(([fx, fy]) => fx === x && fy === y) ? 0 : 1)),
    );

  // buildings
  atlas.addBuilding('station', {
    w: 11,
    h: 5,
    roof: ROOFS.slate!,
    wall: '#c98a6a',
    wallDark: '#a86a4e',
    doorCol: 5,
    windows: [10, 40, 112, 142],
    windowWidth: 14,
    sign: 'STATION',
    chimney: true,
  });
  atlas.addBuilding('hotel', {
    w: 11,
    h: 6,
    roof: ROOFS.purple!,
    wall: P.wallWhite,
    wallDark: P.wallWhiteDark,
    doorCol: 5,
    windows: [10, 40, 112, 142],
    upperWindows: [10, 40, 72, 112, 142],
    windowWidth: 14,
    sign: 'HOTEL',
    awning: ['#7a5a8c', P.white],
    roofFraction: 0.4,
  });
  atlas.addBuilding('burger_joint', {
    w: 7,
    h: 4,
    roof: ROOFS.red!,
    wall: P.wallCream,
    wallDark: P.wallCreamDark,
    doorCol: 3,
    windows: [10, 82],
    windowWidth: 16,
    sign: 'BURGERS',
    awning: [P.flowerYellow, P.red],
    goods: true,
  });
  atlas.addBuilding('butcher', {
    w: 5,
    h: 4,
    roof: ROOFS.slate!,
    wall: P.wallWhite,
    wallDark: P.wallWhiteDark,
    doorCol: 2,
    windows: [8, 60],
    sign: 'BUTCHER',
  });
  atlas.addBuilding('farmhouse', {
    w: 6,
    h: 4,
    roof: ROOFS.green!,
    wall: P.wallCream,
    wallDark: P.wallCreamDark,
    doorCol: 2,
    windows: [8, 60, 76],
    chimney: true,
  });
  o('barn', drawBarn(), {
    overheadRows: 2,
    collision: block(7, 5, [[3, 4]]),
    anchors: { door: { x: 3, y: 4 } },
  });
  o('coop', drawCoop(), {
    overheadRows: 1,
    collision: block(3, 3, [[1, 2]]),
    anchors: { door: { x: 1, y: 2 } },
  });

  // signs, gates, nature
  o('sign_zoo', drawSignBoard(['CITY', 'ZOO']), {
    collision: [
      [0, 0, 0, 0, 0],
      [0, 1, 0, 1, 0],
    ],
  });
  o('sign_farm', drawSignBoard(['MEADOW', 'FARM']), {
    collision: [
      [0, 0, 0, 0, 0],
      [0, 1, 0, 1, 0],
    ],
  });
  o('sign_rides', drawSignBoard(['FUN', 'RIDES'], 80, P.red, P.redLight, P.white), {
    collision: [
      [0, 0, 0, 0, 0],
      [0, 1, 0, 1, 0],
    ],
  });
  o('pillar_red', drawPillar(P.red), { overheadRows: 1, collision: [[0], [1]] });
  o('pillar_green', drawPillar('#5f9a48'), { overheadRows: 1, collision: [[0], [1]] });
  o('tree_acacia', drawAcacia(), {
    overheadRows: 1,
    collision: [
      [0, 0],
      [1, 1],
    ],
  });
  o('tree_palm', drawPalm(), {
    overheadRows: 1,
    collision: [
      [0, 0],
      [1, 1],
    ],
  });
  o('bamboo', drawBamboo(3), { overheadRows: 1, collision: [[0], [1]] });
  o('rock_big', drawBigRock(), {
    collision: [
      [1, 1],
      [1, 1],
    ],
  });
  o('log', drawLog(), { collision: [[1, 1]] });
  o('hay', drawHay(), { collision: [[1]] });
  o('trough', drawTrough(), { collision: [[1, 1]] });
  o('churn', drawChurn(), { collision: [[1]] });

  // rides and food
  o('ferris_wheel', drawFerrisWheel(0), {
    overheadRows: 5,
    collision: block(7, 7).map((r) => r.slice(0, 6)),
  });
  o('carousel', drawCarousel(0), { overheadRows: 2, collision: block(5, 5) });
  o('coaster_station', drawCoasterStation(), {
    overheadRows: 1,
    collision: [
      [0, 0, 0],
      [0, 0, 0],
    ],
  });
  o('ice_cream_truck', drawIceCreamTruck(0), { collision: [[1, 1]] });
  o('cart_popcorn', drawFoodCart('#d44a3a', '#f07a5a', '#fffaea'), {
    overheadRows: 1,
    collision: [[0], [1]],
  });
  o('cart_lemonade', drawFoodCart('#e8c24a', '#f6dc7a', '#f6e04a'), {
    overheadRows: 1,
    collision: [[0], [1]],
  });
  o('cart_cotton_candy', drawFoodCart('#e872b8', '#f6a8d4', '#f6c8e0'), {
    overheadRows: 1,
    collision: [[0], [1]],
  });
  o('balloons', drawBalloons(), { overheadRows: 1, collision: [[0], [1]] });
  o('picnic_table', drawPicnicTable(), {
    collision: [
      [1, 1],
      [1, 1],
    ],
  });
  o('bin', drawBin(), { collision: [[1]] });
  o('lounger', drawLounger(), { collision: [[1], [1]] });
  o('umbrella_teal', drawUmbrella(ROOFS.teal!.base), {
    overheadRows: 1,
    collision: [
      [0, 0],
      [0, 0],
    ],
  });
  o('umbrella_red', drawUmbrella(P.red), {
    overheadRows: 1,
    collision: [
      [0, 0],
      [0, 0],
    ],
  });
  extendAtlasForest(atlas);
}
