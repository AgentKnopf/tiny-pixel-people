import { PixelCanvas, drawText, mix, rng, textWidth, type Color } from './canvas.ts';
import { P, type RoofStyle } from './palette.ts';
import { terrainTile, type TerrainStyle, type TileAtlas } from './tiles.ts';

/** Forest district, post row (post office, Laude's and Franzi's houses) and lake tiles. */

export const ROOF_OCHRE: RoofStyle = { base: '#b8863a', light: '#d4a24e', dark: '#8a6228' };
export const ROOF_ROSE: RoofStyle = { base: '#c46a7e', light: '#dc8a9a', dark: '#94505e' };
export const ROOF_POST: RoofStyle = { base: '#3f6aa0', light: '#5a86bc', dark: '#2e507c' };

const MOSS: TerrainStyle = {
  inset: 2,
  edge: P.grassDark,
  fill: (_c, x, y, r) => {
    const v = r();
    if (v < 0.05) return P.autumnDark;
    if (v < 0.09) return P.autumn;
    if (v < 0.25) return P.grassDarker;
    return (x * 5 + y * 3) % 17 === 0 ? P.leafLight : '#6a8c45';
  },
};

const LAKE: TerrainStyle = {
  inset: 2,
  edge: P.sandDark,
  rim: P.sand,
  fill: (_c, x, y) => {
    if ((y % 6 === 2 && (x + y) % 8 < 3) || (y % 6 === 5 && (x + y * 3) % 9 < 2)) return P.waterLight;
    return (x + y * 2) % 13 === 0 ? P.waterDeep : '#6aa6c0';
  },
};

const PLANKS: TerrainStyle = {
  inset: 0,
  edge: P.woodDarker,
  fill: (_c, x, y) => {
    if (y % 4 === 3) return P.woodDark;
    if ((x + Math.floor(y / 4) * 5) % 9 === 0) return P.woodDark;
    return y % 4 === 0 ? P.woodLight : P.wood;
  },
};

export const FOREST_TERRAINS: [string, TerrainStyle][] = [
  ['moss', MOSS],
  ['lake', LAKE],
  ['planks', PLANKS],
];

function finish(b: PixelCanvas, shadow?: [number, number, number, number]): PixelCanvas {
  b.outline(P.outline);
  const c = new PixelCanvas(b.width, b.height);
  if (shadow) c.ellipse(shadow[0], shadow[1], shadow[2], shadow[3], P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function leafy(
  b: PixelCanvas,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  pal: Color[],
  seed: number,
): void {
  b.ellipse(cx, cy, rx, ry, pal[0]!);
  b.ellipse(cx - 0.5, cy - 1, rx - 1, ry - 1, pal[1]!);
  const r = rng(seed);
  for (let i = 0; i < Math.round(rx * 0.9); i++) {
    const a = r() * Math.PI * 2;
    const d = r() * rx * 0.6;
    b.ellipse(
      cx + Math.cos(a) * d,
      cy + Math.sin(a) * d * 0.8,
      rx * 0.25,
      ry * 0.22,
      pal[i % 3 === 0 ? 0 : 1]!,
    );
  }
  b.ellipse(cx - rx * 0.35, cy - ry * 0.4, rx * 0.4, ry * 0.3, pal[2]!);
  b.ellipse(cx - rx * 0.45, cy - ry * 0.5, rx * 0.2, ry * 0.15, pal[3]!);
  for (let i = 0; i < rx; i++) {
    const x = Math.round(cx - rx + r() * rx * 2);
    const y = Math.round(cy - ry + r() * ry * 2);
    if (b.alpha(x, y) && b.alpha(x, y + 1)) {
      b.set(x, y, pal[3]!);
      b.set(x, y + 1, pal[0]!);
    }
  }
}

function drawPine(seed: number, snow = false): PixelCanvas {
  const b = new PixelCanvas(32, 48);
  b.rect(14, 38, 4, 8, P.trunk);
  const dark = '#2f5a3a';
  const mid = '#3f7448';
  const light = '#5a9458';
  for (let tier = 0; tier < 4; tier++) {
    const top = 2 + tier * 9;
    const h = 14;
    for (let y = 0; y < h; y++) {
      const half = Math.round(2 + (y / h) * (6 + tier * 2.2));
      b.hline(16 - half, 15 + half, top + y, y === h - 1 ? dark : mid);
      b.hline(16 - half, 16 - half + Math.max(1, Math.floor(half / 2)), top + y, light);
    }
  }
  const r = rng(seed);
  for (let i = 0; i < 8; i++) {
    const x = 6 + Math.floor(r() * 20);
    const y = 8 + Math.floor(r() * 30);
    if (b.alpha(x, y)) b.set(x, y, snow ? P.white : dark);
  }
  if (snow) for (let tier = 0; tier < 4; tier++) b.hline(13 - tier, 18 + tier, 3 + tier * 9, P.white);
  return finish(b, [16, 46, 8, 2]);
}

function drawBirch(): PixelCanvas {
  const b = new PixelCanvas(32, 32);
  b.rect(15, 16, 3, 13, '#ece6d6');
  for (const y of [18, 21, 25, 27]) b.hline(15, 16 + (y % 2), y, '#3a3a32');
  leafy(b, 16, 11, 10, 9, ['#6a9a3a', '#8cba4a', '#a8d060', '#c8e27a'], 77);
  return finish(b, [16, 29.5, 7, 2]);
}

function drawOak(seed: number, autumn: boolean): PixelCanvas {
  const b = new PixelCanvas(48, 48);
  b.rect(20, 32, 8, 13, P.trunk);
  b.vline(26, 32, 44, mix(P.trunk, '#000000', 0.25));
  b.rect(17, 43, 3, 2, P.trunk);
  b.rect(28, 43, 3, 2, P.trunk);
  const pal = autumn
    ? [P.autumnDarker, P.autumnDark, P.autumnLight, '#f7c46a']
    : [P.leafDarker, P.leafDark, P.leafLight, P.leafLighter];
  leafy(b, 24, 19, 21, 17, pal, seed);
  return finish(b, [24, 44.5, 13, 3]);
}

/** The grove's ancient tree, 4×4 tiles. */
function drawGrandTree(): PixelCanvas {
  const b = new PixelCanvas(64, 64);
  b.rect(26, 40, 12, 20, P.trunk);
  b.rect(22, 56, 20, 4, P.trunk);
  b.vline(35, 40, 59, mix(P.trunk, '#000000', 0.3));
  b.vline(29, 44, 55, mix(P.trunk, '#ffffff', 0.15));
  b.ellipse(32, 50, 2, 3, '#3a2818');
  leafy(b, 32, 24, 30, 23, ['#3a5a30', '#4f7a3c', '#78a84a', '#a8d06a'], 5);
  const r = rng(13);
  for (let i = 0; i < 10; i++) {
    const x = 8 + Math.floor(r() * 48);
    const y = 6 + Math.floor(r() * 34);
    if (b.alpha(x, y)) b.set(x, y, P.flowerPink);
  }
  return finish(b, [32, 60, 18, 3]);
}

function drawStump(): PixelCanvas {
  const b = new PixelCanvas(16, 16);
  b.rect(3, 6, 10, 7, P.wood);
  b.ellipse(8, 6, 5, 2.5, P.woodLight);
  b.ellipse(8, 6, 2.5, 1.2, P.wood);
  b.vline(5, 8, 12, P.woodDark);
  b.vline(10, 8, 12, P.woodDark);
  return finish(b, [8, 13.5, 6, 1.5]);
}

function drawMushrooms(): PixelCanvas {
  const b = new PixelCanvas(16, 16);
  for (const [x, y, s] of [
    [5, 9, 3],
    [11, 11, 2],
    [8, 13, 2],
  ] as const) {
    b.rect(x - 1, y, 2, s + 1, P.white);
    b.ellipse(x, y, s + 0.5, s * 0.7, P.red);
    b.set(x - 1, y - 1, P.white);
    b.set(x + 1, y, P.white);
  }
  return finish(b);
}

function drawFern(): PixelCanvas {
  const b = new PixelCanvas(16, 16);
  for (const [dx, dy] of [
    [-1, -0.6],
    [1, -0.6],
    [-0.8, 0.1],
    [0.8, 0.1],
    [0, -1],
  ] as const)
    for (let i = 0; i < 7; i++)
      b.rect(8 + Math.round(dx * i), 12 + Math.round(dy * i), 1, 2, i % 2 ? P.leafLight : P.leaf);
  return finish(b);
}

function drawReeds(): PixelCanvas {
  const b = new PixelCanvas(16, 16);
  for (const x of [3, 6, 9, 12]) {
    const top = 2 + (x % 4);
    b.vline(x, top, 14, '#6a8a3a');
    b.rect(x, top, 1, 3, P.woodDark);
  }
  b.vline(8, 5, 14, '#8aaa4a');
  return finish(b);
}

function drawStandingStone(): PixelCanvas {
  const b = new PixelCanvas(16, 32);
  b.rect(4, 8, 8, 21, '#8a8478');
  b.ellipse(8, 8, 4, 3, '#8a8478');
  b.vline(5, 7, 27, '#a8a294');
  b.rect(9, 14, 2, 6, '#5f8a45');
  b.set(7, 20, '#5f8a45');
  return finish(b, [8, 30, 6, 1.5]);
}

function drawCampfire(lit: boolean): PixelCanvas {
  const b = new PixelCanvas(16, 16);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    b.ellipse(8 + Math.cos(a) * 5, 11 + Math.sin(a) * 2.5, 1.5, 1.2, P.stoneMid);
  }
  b.rect(4, 10, 8, 2, P.woodDark);
  b.rect(6, 9, 4, 1, P.wood);
  if (lit) {
    b.ellipse(8, 7, 3, 4, P.autumn);
    b.ellipse(8, 8, 2, 2.5, P.flowerYellow);
    b.set(8, 2, P.autumnLight);
  }
  return finish(b);
}

function drawBirdhouse(): PixelCanvas {
  const b = new PixelCanvas(16, 32);
  b.rect(7, 12, 2, 18, P.woodDark);
  b.rect(3, 4, 10, 9, P.woodLight);
  for (let y = 0; y < 4; y++) b.hline(2 + y, 13 - y, 4 - y, P.red);
  b.ellipse(8, 8, 1.5, 1.5, P.woodDarker);
  return finish(b, [8, 30.5, 4, 1]);
}

function drawDuckHouse(): PixelCanvas {
  const b = new PixelCanvas(32, 16);
  b.rect(2, 8, 28, 4, P.woodDark);
  b.rect(8, 3, 16, 7, P.woodLight);
  for (let y = 0; y < 3; y++) b.hline(7 + y, 24 - y, 3 - y, P.red);
  b.rect(14, 6, 4, 4, P.woodDarker);
  return finish(b);
}

/** Post office notice board, 2×2 tiles: cork board with pinned notes and a little roof. */
export function drawNoticeBoard(notes = 6): PixelCanvas {
  const b = new PixelCanvas(32, 32);
  b.rect(5, 20, 3, 10, P.woodDark);
  b.rect(24, 20, 3, 10, P.woodDark);
  b.rect(2, 6, 28, 16, P.woodDark);
  b.rect(4, 8, 24, 12, '#c89a62');
  for (let y = 0; y < 5; y++) b.hline(1 + y, 30 - y, 5 - y, ROOF_POST.base);
  b.hline(1, 30, 5, ROOF_POST.dark);
  const pos = [
    [5, 9, P.white],
    [11, 10, '#f6e08a'],
    [17, 9, P.white],
    [22, 11, '#bcd8f0'],
    [7, 14, '#f6c8d8'],
    [14, 14, P.white],
    [20, 15, '#f6e08a'],
  ] as const;
  pos.slice(0, notes).forEach(([x, y, col]) => {
    b.rect(x, y, 5, 5, col);
    b.hline(x + 1, x + 3, y + 2, P.metalLight);
    b.set(x + 2, y, P.red);
  });
  return finish(b, [16, 30, 12, 1.5]);
}

function drawPostBox(): PixelCanvas {
  const b = new PixelCanvas(16, 32);
  b.rect(4, 10, 8, 19, '#d8a21a');
  b.ellipse(8, 10, 4, 3, '#d8a21a');
  b.vline(5, 9, 27, '#f2c94c');
  b.rect(5, 14, 6, 1, P.outline);
  b.rect(6, 19, 4, 3, ROOF_POST.base);
  b.rect(3, 28, 10, 2, P.metal);
  return finish(b, [8, 30.5, 5, 1.2]);
}

function drawSign(lines: string[], board: Color, boardLight: Color, ink: Color): PixelCanvas {
  const w = 80;
  const b = new PixelCanvas(w, 32);
  b.rect(10, 18, 3, 12, P.woodDark);
  b.rect(w - 13, 18, 3, 12, P.woodDark);
  b.rect(4, 3, w - 8, 17, board);
  b.rect(5, 4, w - 10, 15, boardLight);
  lines.forEach((line, i) =>
    drawText(b, Math.floor((w - textWidth(line)) / 2), lines.length === 1 ? 9 : 5 + i * 7, line, ink),
  );
  return finish(b, [w / 2, 30, w / 2 - 6, 1.5]);
}

export function extendAtlasForest(atlas: TileAtlas): void {
  FOREST_TERRAINS.forEach(([name, style], ti) => {
    for (let mask = 0; mask < 16; mask++) atlas.add(`${name}_${mask}`, terrainTile(style, mask, 40 + ti));
  });
  const o = atlas.addObject.bind(atlas);
  const pine: (0 | 1)[][] = [
    [0, 0],
    [0, 0],
    [1, 1],
  ];
  o('tree_pine', drawPine(1), { overheadRows: 2, collision: pine });
  o('tree_pine_b', drawPine(2), { overheadRows: 2, collision: pine });
  o('tree_pine_snow', drawPine(3, true), { overheadRows: 2, collision: pine });
  o('tree_birch', drawBirch(), {
    overheadRows: 1,
    collision: [
      [0, 0],
      [1, 1],
    ],
  });
  const oak: (0 | 1)[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 1, 0],
  ];
  o('tree_oak', drawOak(9, false), { overheadRows: 2, collision: oak });
  o('tree_oak_autumn', drawOak(19, true), { overheadRows: 2, collision: oak });
  o('tree_grand', drawGrandTree(), {
    overheadRows: 3,
    collision: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 1, 1, 0],
    ],
  });
  o('stump', drawStump(), { collision: [[1]] });
  o('mushrooms', drawMushrooms(), { collision: [[0]] });
  o('fern', drawFern(), { collision: [[0]] });
  o('reeds', drawReeds(), { collision: [[0]] });
  o('standing_stone', drawStandingStone(), { overheadRows: 1, collision: [[0], [1]] });
  o('campfire', drawCampfire(false), { collision: [[1]] });
  atlas.add('campfire_lit', drawCampfire(true));
  atlas.lit.set('campfire_0_0', 'campfire_lit');
  o('birdhouse', drawBirdhouse(), { overheadRows: 1, collision: [[0], [1]] });
  o('duck_house', drawDuckHouse(), { collision: [[1, 1]] });
  o('sign_forest', drawSign(['WHISPER', 'WOODS'], P.woodDark, P.wood, P.white), {
    collision: [
      [0, 0, 0, 0, 0],
      [0, 1, 0, 1, 0],
    ],
  });

  // post row
  o('notice_board', drawNoticeBoard(), {
    overheadRows: 1,
    collision: [
      [0, 0],
      [1, 1],
    ],
  });
  o('post_box', drawPostBox(), { overheadRows: 1, collision: [[0], [1]] });
  atlas.addBuilding('post_office', {
    w: 7,
    h: 4,
    roof: ROOF_POST,
    wall: P.wallCream,
    wallDark: P.wallCreamDark,
    doorCol: 3,
    doorColor: ROOF_POST.base,
    windows: [8, 88],
    sign: 'POST OFFICE',
    awning: ['#f2c94c', ROOF_POST.light],
    chimney: true,
  });
  atlas.addBuilding('house_laude', {
    w: 5,
    h: 4,
    roof: ROOF_OCHRE,
    wall: P.wallGrey,
    wallDark: P.wallGreyDark,
    doorCol: 2,
    doorColor: '#5a7a4a',
    windows: [8, 60],
    chimney: true,
  });
  atlas.addBuilding('house_franzi', {
    w: 5,
    h: 4,
    roof: ROOF_ROSE,
    wall: P.wallWhite,
    wallDark: P.wallWhiteDark,
    doorCol: 2,
    doorColor: '#c46a7e',
    windows: [8, 60],
  });
}
