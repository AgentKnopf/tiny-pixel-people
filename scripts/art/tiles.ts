import { PixelCanvas, drawText, mix, rng, textWidth, type Color } from './canvas.ts';
import { P, ROOFS, type RoofStyle } from './palette.ts';
import {
  drawBirdBath,
  drawCushion,
  drawDoorNote,
  drawFlag,
  drawLantern,
  drawStringLights,
  drawVase,
  drawWelcomeRug,
} from './decor.ts';

export const TILE = 16;

/** Neighbour bits used by autotiles: a set bit means the neighbour on that side is the same terrain. */
export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;

export type Layer = 'ground' | 'decor' | 'overhead';

export interface ObjectDef {
  /** Size in tiles. */
  w: number;
  h: number;
  /** Tile names, row-major, per layer; null = nothing on that layer at that cell. */
  layers: Partial<Record<Layer, (string | null)[][]>>;
  /** Row-major 0/1 per cell. */
  collision: (0 | 1)[][];
  /** Cell offsets of interest, e.g. the door. */
  anchors?: Record<string, { x: number; y: number }>;
}

export class TileAtlas {
  readonly tiles: { name: string; canvas: PixelCanvas }[] = [];
  readonly index = new Map<string, number>();
  readonly lit = new Map<string, string>();
  readonly objects: Record<string, ObjectDef> = {};

  add(name: string, canvas: PixelCanvas): string {
    if (this.index.has(name)) throw new Error(`duplicate tile ${name}`);
    this.index.set(name, this.tiles.length);
    this.tiles.push({ name, canvas });
    return name;
  }

  /** Slices a multi-tile drawing into cells named `${prefix}_${x}_${y}`, skipping fully transparent cells. */
  addSliced(prefix: string, canvas: PixelCanvas): (string | null)[][] {
    const rows: (string | null)[][] = [];
    for (let ty = 0; ty < canvas.height / TILE; ty++) {
      const row: (string | null)[] = [];
      for (let tx = 0; tx < canvas.width / TILE; tx++) {
        const cell = canvas.crop(tx * TILE, ty * TILE, TILE, TILE);
        const empty = !cell.data.some((v, i) => i % 4 === 3 && v > 0);
        row.push(empty ? null : this.add(`${prefix}_${tx}_${ty}`, cell));
      }
      rows.push(row);
    }
    return rows;
  }

  /** Slices a drawing into tiles and records it as an object; rows above overheadRows go to the overhead layer. */
  addObject(
    name: string,
    canvas: PixelCanvas,
    opts: { overheadRows?: number; collision: (0 | 1)[][]; anchors?: ObjectDef['anchors'] },
  ): ObjectDef {
    const cells = this.addSliced(name, canvas);
    const over = opts.overheadRows ?? 0;
    const def: ObjectDef = {
      w: canvas.width / TILE,
      h: canvas.height / TILE,
      layers: {
        overhead: cells.map((row, y) => row.map((n) => (y < over ? n : null))),
        decor: cells.map((row, y) => row.map((n) => (y >= over ? n : null))),
      },
      collision: opts.collision,
    };
    if (opts.anchors) def.anchors = opts.anchors;
    this.objects[name] = def;
    return def;
  }

  /** Adds a building (day + lit-window variants); everything is blocked except the door cell. */
  addBuilding(name: string, spec: BuildingSpec): ObjectDef {
    const day = this.addSliced(name, drawBuilding(spec, false));
    const lit = this.addSliced(`${name}_lit`, drawBuilding(spec, true));
    day.forEach((row, y) =>
      row.forEach((n, x) => {
        const l = lit[y]![x];
        if (n && l) this.lit.set(n, l);
      }),
    );
    const roofRows = Math.floor((spec.h * (spec.roofFraction ?? ROOF_FRACTION) * TILE) / TILE);
    const collision = Array.from({ length: spec.h }, (_, y) =>
      Array.from({ length: spec.w }, (_, x) => (y === spec.h - 1 && x === spec.doorCol ? 0 : 1) as 0 | 1),
    );
    const def: ObjectDef = {
      w: spec.w,
      h: spec.h,
      layers: {
        overhead: day.map((row, y) => row.map((n) => (y < roofRows ? n : null))),
        decor: day.map((row, y) => row.map((n) => (y >= roofRows ? n : null))),
      },
      collision,
      anchors: { door: { x: spec.doorCol, y: spec.h - 1 } },
    };
    this.objects[name] = def;
    return def;
  }

  id(name: string): number {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`unknown tile ${name}`);
    return i;
  }

  sheet(columns: number): PixelCanvas {
    const rows = Math.ceil(this.tiles.length / columns);
    const out = new PixelCanvas(columns * TILE, rows * TILE);
    this.tiles.forEach((t, i) => out.blit(t.canvas, (i % columns) * TILE, Math.floor(i / columns) * TILE));
    return out;
  }
}

function tile(): PixelCanvas {
  return new PixelCanvas(TILE, TILE);
}

// ---------------------------------------------------------------- ground

export function drawGrass(c: PixelCanvas, seed: number, flowers: number, tufts: number): void {
  const r = rng(seed);
  c.rect(0, 0, TILE, TILE, P.grass);
  for (let i = 0; i < 10; i++)
    c.set(Math.floor(r() * 16), Math.floor(r() * 16), mix(P.grass, P.grassLight, 0.5));
  for (let i = 0; i < tufts; i++) {
    const x = 1 + Math.floor(r() * 13);
    const y = 2 + Math.floor(r() * 12);
    c.set(x, y, P.grassDark);
    c.set(x + 2, y, P.grassDark);
    c.set(x + 1, y + 1, P.grassDark);
    c.set(x + 1, y - 1, P.grassLight);
  }
  const fc = [P.flowerWhite, P.flowerPink, P.flowerYellow, P.flowerBlue];
  for (let i = 0; i < flowers; i++) {
    const x = 1 + Math.floor(r() * 14);
    const y = 1 + Math.floor(r() * 14);
    c.set(x, y, fc[Math.floor(r() * fc.length)]!);
    c.set(x, y + 1, P.grassDarker);
  }
}

export interface TerrainStyle {
  fill: (c: PixelCanvas, x: number, y: number, r: () => number) => Color;
  edge: Color;
  /** Optional second ring inside the edge (e.g. stone rim highlight). */
  rim?: Color;
  inset: number;
}

/** Draws a terrain autotile over grass. Open sides (bit clear) fade into grass with a slightly irregular edge. */
export function terrainTile(style: TerrainStyle, mask: number, seed: number): PixelCanvas {
  const c = tile();
  drawGrass(c, seed * 7 + mask, 0, 1);
  const r = rng(seed * 131 + mask);
  const jitter = (pos: number, side: number) => ((pos * 7 + side * 13 + seed) % 5 === 0 ? 1 : 0);
  const inside = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return true;
    const e = style.inset;
    if (!(mask & N) && y < e + jitter(x, 1)) return false;
    if (!(mask & S) && TILE - 1 - y < e + jitter(x, 2)) return false;
    if (!(mask & W) && x < e + jitter(y, 3)) return false;
    if (!(mask & E) && TILE - 1 - x < e + jitter(y, 4)) return false;
    const rad = 4;
    const corner = (open1: boolean, open2: boolean, dx: number, dy: number) =>
      open1 && open2 && dx < rad && dy < rad && (rad - dx) ** 2 + (rad - dy) ** 2 > rad * rad;
    if (corner(!(mask & N), !(mask & W), x - e, y - e)) return false;
    if (corner(!(mask & N), !(mask & E), TILE - 1 - e - x, y - e)) return false;
    if (corner(!(mask & S), !(mask & W), x - e, TILE - 1 - e - y)) return false;
    if (corner(!(mask & S), !(mask & E), TILE - 1 - e - x, TILE - 1 - e - y)) return false;
    return true;
  };
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (!inside(x, y)) continue;
      const border = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      const border2 =
        !border && (!inside(x - 2, y) || !inside(x + 2, y) || !inside(x, y - 2) || !inside(x, y + 2));
      if (border) c.set(x, y, style.edge);
      else if (border2 && style.rim) c.set(x, y, style.rim);
      else c.set(x, y, style.fill(c, x, y, r));
    }
  }
  return c;
}

const PATH: TerrainStyle = {
  inset: 2,
  edge: P.pathEdge,
  fill: (_c, x, y, r) => {
    const v = r();
    if (v < 0.06) return P.pathDark;
    if (v < 0.2) return P.pathLight;
    return (x * 3 + y * 5) % 11 === 0 ? P.pathEdge : P.path;
  },
};

const SAND: TerrainStyle = {
  inset: 1,
  edge: P.stoneDark,
  rim: P.stone,
  fill: (_c, _x, _y, r) => (r() < 0.08 ? P.sandDark : P.sand),
};

const WATER: TerrainStyle = {
  inset: 1,
  edge: P.stoneDark,
  rim: P.stone,
  fill: (_c, x, y) => {
    if ((y % 6 === 2 && (x + y) % 8 < 3) || (y % 6 === 5 && (x + y * 3) % 9 < 2)) return P.waterLight;
    return y % 7 === 0 ? P.waterDeep : P.water;
  },
};

const SOIL: TerrainStyle = {
  inset: 0,
  edge: P.soilDark,
  fill: (_c, x, y, r) => {
    if (y % 4 === 3) return P.soilDark;
    if (y % 4 === 0) return P.soilLight;
    return r() < 0.08 ? P.soilDark : (x + y) % 9 === 0 ? P.soilLight : P.soil;
  },
};

// ---------------------------------------------------------------- nature

function drawTree(kind: 'green' | 'autumn' | 'blossom'): PixelCanvas {
  const c = new PixelCanvas(32, 32);
  const pal = {
    green: [P.leafDarker, P.leafDark, P.leaf, P.leafLight, P.leafLighter],
    autumn: [P.autumnDarker, P.autumnDark, P.autumn, P.autumnLight, '#f7c46a'],
    blossom: ['#7a4a5c', '#b8648a', '#e08ab0', '#f0aac8', '#fbd0e0'],
  }[kind];
  const body = new PixelCanvas(32, 32);
  body.rect(14, 22, 4, 7, P.trunk);
  body.set(13, 28, P.trunk);
  body.set(18, 28, P.trunk);
  body.vline(17, 22, 28, mix(P.trunk, '#000000', 0.25));
  body.ellipse(16, 13, 13, 11, pal[1]!);
  body.ellipse(15, 12, 12, 10, pal[2]!);
  const r = rng(kind.length * 99);
  for (let i = 0; i < 9; i++) {
    const a = r() * Math.PI * 2;
    const d = 4 + r() * 6;
    body.ellipse(15 + Math.cos(a) * d, 12 + Math.sin(a) * d * 0.8, 3.2, 2.6, pal[i % 3 === 0 ? 1 : 2]!);
  }
  body.ellipse(11, 8, 5, 3.5, pal[3]!);
  body.ellipse(19, 6, 3.5, 2.5, pal[3]!);
  body.ellipse(10, 7, 2.5, 1.5, pal[4]!);
  body.ellipse(19, 18, 6, 2.5, pal[1]!);
  for (let i = 0; i < 14; i++) {
    const x = 5 + Math.floor(r() * 22);
    const y = 4 + Math.floor(r() * 16);
    if (body.alpha(x, y) && body.alpha(x, y + 1)) {
      body.set(x, y, pal[4]!);
      body.set(x, y + 1, pal[1]!);
    }
  }
  body.outline(P.outline);
  c.ellipse(16, 29.5, 8, 2.5, P.shadow);
  c.blit(body, 0, 0);
  return c;
}

function drawBush(seed: number, berries: Color | null): PixelCanvas {
  const c = tile();
  const b = tile();
  b.ellipse(8, 9, 7, 5.5, P.leafDark);
  b.ellipse(7.5, 8.5, 6, 4.5, P.leaf);
  b.ellipse(6, 7, 3, 2, P.leafLight);
  b.set(5, 6, P.leafLighter);
  if (berries) {
    const r = rng(seed);
    for (let i = 0; i < 4; i++) b.set(3 + Math.floor(r() * 10), 6 + Math.floor(r() * 6), berries);
  }
  b.outline(P.outline);
  c.ellipse(8, 14, 6, 1.5, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawFlowers(seed: number, colors: Color[]): PixelCanvas {
  const c = tile();
  const r = rng(seed);
  for (let i = 0; i < 6; i++) {
    const x = 2 + Math.floor(r() * 12);
    const y = 3 + Math.floor(r() * 10);
    const col = colors[i % colors.length]!;
    c.vline(x, y + 1, y + 2, P.cropDark);
    c.set(x - 1, y, col);
    c.set(x + 1, y, col);
    c.set(x, y - 1, col);
    c.set(x, y + 1, col);
    c.set(x, y, P.flowerYellow);
  }
  return c;
}

function drawRock(): PixelCanvas {
  const c = tile();
  const b = tile();
  b.ellipse(8, 10, 5, 3.5, P.stoneMid);
  b.ellipse(7, 9, 3.5, 2.2, P.stone);
  b.set(6, 8, '#ffffff');
  b.outline(P.outline);
  c.ellipse(8, 13.5, 5, 1.2, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawLilyPad(): PixelCanvas {
  const c = tile();
  c.ellipse(6, 7, 3, 2, '#5c9a4a');
  c.set(6, 6, P.water);
  c.set(7, 6, P.water);
  c.ellipse(11, 11, 2.2, 1.5, '#5c9a4a');
  c.set(11, 10, P.flowerPink);
  return c;
}

// ---------------------------------------------------------------- props

function fenceTile(mask: number): PixelCanvas {
  const c = tile();
  const f = tile();
  const rail = (x0: number, x1: number) => {
    f.hline(x0, x1, 6, P.woodLight);
    f.hline(x0, x1, 7, P.wood);
    f.hline(x0, x1, 10, P.woodLight);
    f.hline(x0, x1, 11, P.wood);
  };
  if (mask & W) rail(0, 7);
  if (mask & E) rail(8, 15);
  if (mask & N) f.rect(7, 0, 2, 6, P.wood);
  if (mask & S) f.rect(7, 10, 2, 6, P.wood);
  f.rect(6, 3, 4, 11, P.wood);
  f.vline(6, 3, 13, P.woodLight);
  f.hline(6, 9, 3, P.woodLight);
  f.outline(P.woodDarker);
  c.blit(f, 0, 0);
  return c;
}

function drawLamp(): PixelCanvas {
  const c = new PixelCanvas(16, 32);
  const b = new PixelCanvas(16, 32);
  b.rect(7, 10, 2, 19, P.metal);
  b.vline(7, 10, 28, P.metalLight);
  b.rect(5, 28, 6, 2, P.metal);
  b.rect(4, 3, 8, 7, P.windowLit);
  b.rect(5, 4, 3, 3, P.windowLitLight);
  b.hline(3, 12, 2, P.metal);
  b.hline(5, 10, 1, P.metal);
  b.hline(4, 11, 10, P.metal);
  b.outline(P.outline);
  c.ellipse(8, 30.5, 4, 1.2, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawBench(): PixelCanvas {
  const c = new PixelCanvas(32, 16);
  const b = new PixelCanvas(32, 16);
  b.rect(3, 2, 26, 3, P.woodLight);
  b.hline(3, 28, 4, P.wood);
  b.rect(3, 7, 26, 4, P.wood);
  b.hline(3, 28, 7, P.woodLight);
  b.rect(4, 5, 2, 2, P.woodDark);
  b.rect(26, 5, 2, 2, P.woodDark);
  b.rect(4, 11, 2, 3, P.woodDarker);
  b.rect(26, 11, 2, 3, P.woodDarker);
  b.outline(P.outline);
  c.ellipse(16, 14, 13, 1.5, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawCrate(): PixelCanvas {
  const c = tile();
  const b = tile();
  b.rect(2, 3, 12, 11, P.wood);
  b.rect(3, 4, 10, 9, P.woodLight);
  b.rect(4, 5, 8, 7, P.wood);
  for (let i = 0; i < 8; i++) b.set(4 + i, 5 + Math.floor(i * 0.9), P.woodLight);
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

function drawBarrel(): PixelCanvas {
  const c = tile();
  const b = tile();
  b.rect(3, 2, 10, 12, P.wood);
  b.ellipse(8, 3, 5, 1.5, P.woodLight);
  b.vline(4, 4, 13, P.woodLight);
  b.hline(3, 12, 5, P.metal);
  b.hline(3, 12, 11, P.metal);
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

function drawFlowerPot(color: Color): PixelCanvas {
  const c = tile();
  const b = tile();
  b.rect(4, 9, 8, 5, P.redDark);
  b.hline(3, 12, 9, P.red);
  b.ellipse(8, 6, 4.5, 3.5, P.leaf);
  b.set(6, 5, color);
  b.set(9, 4, color);
  b.set(10, 7, color);
  b.set(7, 7, color);
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

function drawMailbox(): PixelCanvas {
  const c = tile();
  const b = tile();
  b.rect(7, 8, 2, 7, P.woodDark);
  b.rect(4, 3, 8, 6, P.red);
  b.hline(4, 11, 3, P.redLight);
  b.rect(11, 1, 1, 4, P.flowerYellow);
  b.outline(P.outline);
  c.blit(b, 0, 0);
  return c;
}

function drawWell(): PixelCanvas {
  const c = new PixelCanvas(32, 32);
  const b = new PixelCanvas(32, 32);
  b.rect(5, 3, 22, 3, ROOFS.red!.base);
  b.hline(5, 26, 3, ROOFS.red!.light);
  b.rect(7, 6, 2, 14, P.woodDark);
  b.rect(23, 6, 2, 14, P.woodDark);
  b.ellipse(16, 21, 10, 5, P.stoneMid);
  b.ellipse(16, 20, 8, 3, P.waterDeep);
  b.rect(6, 20, 20, 7, P.stoneMid);
  for (let x = 6; x < 26; x += 4) b.vline(x, 21, 26, P.stoneDark);
  b.hline(6, 25, 23, P.stoneDark);
  b.outline(P.outline);
  c.ellipse(16, 28.5, 11, 2, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawStall(canopy: Color, canopyLight: Color): PixelCanvas {
  const c = new PixelCanvas(32, 32);
  const b = new PixelCanvas(32, 32);
  b.rect(4, 18, 24, 9, P.wood);
  b.hline(4, 27, 18, P.woodLight);
  b.rect(5, 27, 2, 3, P.woodDarker);
  b.rect(25, 27, 2, 3, P.woodDarker);
  b.ellipse(10, 17, 3, 2, P.flowerYellow);
  b.ellipse(16, 17, 3, 2, P.redLight);
  b.ellipse(22, 17, 3, 2, P.crop);
  b.vline(15, 8, 17, P.woodDark);
  b.vline(16, 8, 17, P.woodDark);
  b.ellipse(16, 8, 14, 6, canopy);
  for (let x = 2; x < 30; x++)
    for (let y = 2; y < 14; y++)
      if (b.alpha(x, y) && Math.floor((x - 2) / 4) % 2 === 1 && y < 13) b.set(x, y, canopyLight);
  b.rect(2, 8, 28, 6, [0, 0, 0, 0]);
  for (let x = 2; x < 30; x++) {
    const col = Math.floor((x - 2) / 4) % 2 === 1 ? canopyLight : canopy;
    for (let y = 8; y < 12 + (x % 4 < 2 ? 1 : 0); y++) b.set(x, y, col);
  }
  b.outline(P.outline);
  c.ellipse(16, 30, 13, 1.5, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawFountain(): PixelCanvas {
  const c = new PixelCanvas(48, 48);
  const b = new PixelCanvas(48, 48);
  b.ellipse(24, 27, 21, 15, P.stoneDark);
  b.ellipse(24, 26, 20, 14, P.stone);
  b.ellipse(24, 27, 17, 11, P.waterDeep);
  b.ellipse(24, 26, 16, 10, P.water);
  for (let i = 0; i < 6; i++) b.hline(14 + i * 3, 16 + i * 3, 22 + (i % 3) * 4, P.waterLight);
  b.ellipse(24, 26, 5, 3.5, P.stoneDark);
  b.ellipse(24, 25, 4, 2.5, P.stone);
  b.rect(22, 12, 4, 13, P.stone);
  b.vline(22, 12, 24, '#ffffff');
  b.vline(25, 12, 24, P.stoneMid);
  b.ellipse(24, 12, 6, 2.5, P.stoneMid);
  b.ellipse(24, 11, 5, 1.8, P.water);
  b.vline(24, 4, 10, P.waterFoam);
  b.set(23, 5, P.waterFoam);
  b.set(25, 5, P.waterFoam);
  b.set(21, 7, P.waterLight);
  b.set(27, 7, P.waterLight);
  b.set(20, 9, P.waterLight);
  b.set(28, 9, P.waterLight);
  b.outline(P.outline);
  c.ellipse(24, 30, 22, 15, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawSign(lines: string[]): PixelCanvas {
  const w = 80;
  const c = new PixelCanvas(w, 32);
  const b = new PixelCanvas(w, 32);
  b.rect(10, 18, 3, 12, P.woodDark);
  b.rect(w - 13, 18, 3, 12, P.woodDark);
  b.rect(4, 3, w - 8, 17, P.wood);
  b.rect(5, 4, w - 10, 15, P.woodLight);
  b.hline(5, w - 6, 11, P.wood);
  lines.forEach((line, i) =>
    drawText(b, Math.floor((w - textWidth(line)) / 2), 5 + i * 7, line, P.woodDarker),
  );
  b.outline(P.outline);
  c.ellipse(w / 2, 30, w / 2 - 6, 1.5, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function drawShed(): PixelCanvas {
  const c = new PixelCanvas(32, 32);
  const b = new PixelCanvas(32, 32);
  b.rect(3, 12, 26, 18, P.wood);
  for (let x = 4; x < 29; x += 3) b.vline(x, 13, 29, P.woodDark);
  b.rect(11, 18, 10, 12, P.woodDarker);
  b.rect(12, 19, 8, 11, P.woodDark);
  b.set(18, 24, P.flowerYellow);
  for (let y = 1; y <= 12; y++) {
    const inset = Math.max(0, 6 - Math.floor(y / 2));
    b.hline(1 + inset, 30 - inset, y, y % 3 === 0 ? ROOFS.green!.dark : ROOFS.green!.base);
  }
  b.hline(1, 30, 12, ROOFS.green!.dark);
  b.outline(P.outline);
  c.ellipse(16, 30.5, 14, 1.5, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

function cropTile(kind: 'sprout' | 'cabbage' | 'wheat' | 'carrot' | 'pumpkin'): PixelCanvas {
  const c = tile();
  for (const [x, y] of [
    [3, 2],
    [11, 2],
    [3, 10],
    [11, 10],
  ] as const) {
    switch (kind) {
      case 'sprout':
        c.set(x, y + 3, P.cropDark);
        c.set(x - 1, y + 2, P.crop);
        c.set(x + 1, y + 2, P.crop);
        break;
      case 'cabbage':
        c.ellipse(x + 0.5, y + 2.5, 2.5, 2, P.cropDark);
        c.ellipse(x + 0.5, y + 2, 1.6, 1.3, '#a8d06a');
        break;
      case 'wheat':
        c.vline(x, y, y + 4, P.wheatDark);
        c.vline(x + 1, y - 1, y + 3, P.wheat);
        c.set(x - 1, y + 1, P.wheat);
        break;
      case 'carrot':
        c.set(x, y + 1, P.crop);
        c.set(x + 1, y, P.crop);
        c.set(x - 1, y, P.crop);
        c.rect(x - 1, y + 2, 3, 2, '#e8782f');
        break;
      case 'pumpkin':
        c.ellipse(x + 0.5, y + 3, 2.8, 2, P.autumn);
        c.set(x, y + 3, P.autumnDark);
        c.set(x, y, P.cropDark);
        break;
    }
  }
  return c;
}

// ---------------------------------------------------------------- buildings

export interface BuildingSpec {
  w: number;
  h: number;
  roof: RoofStyle;
  wall: Color;
  wallDark: Color;
  doorCol: number;
  doorColor?: Color;
  windows: number[];
  windowWidth?: number;
  sign?: string;
  awning?: [Color, Color];
  chimney?: boolean;
  goods?: boolean;
  /** Extra rows of windows above the ground floor (hotel). */
  upperWindows?: number[];
  roofFraction?: number;
}

const ROOF_FRACTION = 0.53;

export function drawBuilding(spec: BuildingSpec, lit: boolean): PixelCanvas {
  const W = spec.w * TILE;
  const H = spec.h * TILE;
  const c = new PixelCanvas(W, H);
  const b = new PixelCanvas(W, H);
  const roofH = Math.round(H * (spec.roofFraction ?? ROOF_FRACTION));
  const wallTop = roofH;
  // wall
  b.rect(1, wallTop - 2, W - 2, H - wallTop + 1, spec.wall);
  for (let y = wallTop + 3; y < H - 3; y += 4) b.hline(1, W - 2, y, spec.wallDark);
  b.rect(1, H - 3, W - 2, 2, P.stoneMid);
  b.hline(1, W - 2, H - 3, P.stone);
  b.vline(1, wallTop, H - 4, spec.wallDark);
  b.vline(W - 2, wallTop, H - 4, spec.wallDark);
  // windows
  const ww = spec.windowWidth ?? 12;
  const windowRows: [number, number[]][] = [[H - 24, spec.windows]];
  if (spec.upperWindows) windowRows.push([H - 42, spec.upperWindows]);
  for (const [wy, xs] of windowRows)
    for (const wx of xs) {
      b.rect(wx - 1, wy - 1, ww + 2, 12, P.white);
      b.rect(wx, wy, ww, 10, lit ? P.windowLit : P.glass);
      b.rect(wx + 1, wy + 1, 3, 3, lit ? P.windowLitLight : P.glassLight);
      b.vline(wx + Math.floor(ww / 2), wy, wy + 9, P.white);
      b.hline(wx, wx + ww - 1, wy + 5, P.white);
      b.hline(wx - 2, wx + ww + 1, wy + 11, P.woodDark);
      if (spec.goods && !lit) {
        b.ellipse(wx + 3, wy + 8, 2, 1.2, P.wheat);
        b.ellipse(wx + ww - 4, wy + 8, 2, 1.2, P.autumnLight);
      }
    }
  // door
  const dx = spec.doorCol * TILE + 3;
  const dy = H - 16;
  b.rect(dx - 1, dy - 1, 12, 15, P.woodDarker);
  b.rect(dx, dy, 10, 14, spec.doorColor ?? P.wood);
  b.vline(dx + 5, dy + 1, dy + 13, P.woodDark);
  b.hline(dx, dx + 9, dy, P.woodLight);
  b.set(dx + 7, dy + 8, P.flowerYellow);
  b.rect(dx - 2, H - 2, 14, 1, P.stoneDark);
  // awning
  if (spec.awning) {
    const [a1, a2] = spec.awning;
    for (let x = 2; x < W - 2; x++) {
      const col = Math.floor(x / 5) % 2 === 0 ? a1 : a2;
      const depth = x % 5 === 2 ? 6 : 5;
      for (let y = wallTop; y < wallTop + depth; y++) b.set(x, y, col);
    }
  }
  // roof
  for (let y = 0; y < roofH; y++) {
    const t = y / roofH;
    const inset = Math.round((1 - t) * 5);
    const shade = y < 3 ? spec.roof.light : y % 4 === 3 ? spec.roof.dark : spec.roof.base;
    b.hline(inset, W - 1 - inset, y, shade);
    if (y % 4 !== 3 && y > 2) {
      for (let x = inset + (Math.floor(y / 4) % 2) * 3; x < W - inset; x += 6) b.set(x, y, spec.roof.dark);
    }
  }
  b.hline(0, W - 1, roofH - 1, spec.roof.dark);
  b.hline(0, W - 1, roofH - 2, spec.roof.dark);
  b.hline(5, W - 6, 0, mix(spec.roof.light, '#ffffff', 0.25));
  if (spec.chimney) {
    b.rect(W - 18, 0, 7, 9, P.stoneMid);
    b.hline(W - 19, W - 11, 0, P.stoneDark);
    b.vline(W - 18, 1, 8, P.stone);
  }
  if (spec.sign) {
    const tw = textWidth(spec.sign);
    const sx = Math.floor((W - tw) / 2) - 3;
    const sy = roofH - 12;
    b.rect(sx, sy, tw + 6, 9, P.white);
    b.hline(sx, sx + tw + 5, sy + 8, P.wallCreamDark);
    drawText(b, sx + 3, sy + 2, spec.sign, P.redDark);
  }
  b.outline(P.outline);
  c.rect(2, H - 1, W - 2, 1, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

// ---------------------------------------------------------------- atlas

export const HOUSE_COLORS = ['brown', 'blue', 'teal', 'purple', 'red', 'green', 'slate'] as const;

export const BUILDINGS: Record<string, BuildingSpec> = {
  ...Object.fromEntries(
    HOUSE_COLORS.map((color, i) => [
      `house_${color}`,
      {
        w: 5,
        h: 4,
        roof: ROOFS[color]!,
        wall: i % 3 === 1 ? P.wallGrey : i % 3 === 2 ? P.wallWhite : P.wallCream,
        wallDark: i % 3 === 1 ? P.wallGreyDark : i % 3 === 2 ? P.wallWhiteDark : P.wallCreamDark,
        doorCol: 2,
        windows: [8, 60],
        chimney: i % 2 === 0,
      } satisfies BuildingSpec,
    ]),
  ),
  bakery: {
    w: 9,
    h: 4,
    roof: ROOFS.red!,
    wall: P.wallWhite,
    wallDark: P.wallWhiteDark,
    doorCol: 4,
    windows: [12, 40, 92, 118],
    windowWidth: 14,
    sign: 'BAKERY',
    awning: [P.red, P.white],
    chimney: true,
    goods: true,
  },
  shop: {
    w: 7,
    h: 4,
    roof: ROOFS.blue!,
    wall: P.wallCream,
    wallDark: P.wallCreamDark,
    doorCol: 3,
    windows: [10, 82],
    windowWidth: 16,
    sign: 'SHOP',
    awning: [ROOFS.blue!.light, P.white],
    goods: true,
  },
};

export function buildAtlas(): TileAtlas {
  const atlas = new TileAtlas();
  const g = (name: string, seed: number, flowers: number, tufts: number) => {
    const c = tile();
    drawGrass(c, seed, flowers, tufts);
    atlas.add(name, c);
  };
  g('grass_0', 11, 0, 1);
  g('grass_1', 23, 0, 3);
  g('grass_2', 37, 0, 2);
  g('grass_3', 41, 2, 2);
  g('grass_4', 53, 3, 1);
  g('grass_5', 67, 0, 0);

  const terrains: [string, TerrainStyle][] = [
    ['path', PATH],
    ['sand', SAND],
    ['water', WATER],
    ['soil', SOIL],
  ];
  terrains.forEach(([name, style], ti) => {
    for (let mask = 0; mask < 16; mask++) atlas.add(`${name}_${mask}`, terrainTile(style, mask, 5 + ti));
  });

  for (let mask = 0; mask < 16; mask++) atlas.add(`fence_${mask}`, fenceTile(mask));

  const addObject = atlas.addObject.bind(atlas);

  addObject('tree_green', drawTree('green'), {
    overheadRows: 1,
    collision: [
      [0, 0],
      [1, 1],
    ],
  });
  addObject('tree_autumn', drawTree('autumn'), {
    overheadRows: 1,
    collision: [
      [0, 0],
      [1, 1],
    ],
  });
  addObject('tree_blossom', drawTree('blossom'), {
    overheadRows: 1,
    collision: [
      [0, 0],
      [1, 1],
    ],
  });
  addObject('bush', drawBush(1, null), { collision: [[1]] });
  addObject('bush_berries', drawBush(2, P.redLight), { collision: [[1]] });
  addObject('bush_flowers', drawBush(3, P.flowerWhite), { collision: [[1]] });
  addObject('flowers_pink', drawFlowers(4, [P.flowerPink, P.flowerWhite]), { collision: [[0]] });
  addObject('flowers_yellow', drawFlowers(5, [P.flowerYellow, P.flowerWhite]), { collision: [[0]] });
  addObject('flowers_blue', drawFlowers(6, [P.flowerBlue, P.flowerPink]), { collision: [[0]] });
  addObject('rock', drawRock(), { collision: [[1]] });
  addObject('lilypad', drawLilyPad(), { collision: [[1]] });
  addObject('lamp', drawLamp(), { overheadRows: 1, collision: [[0], [1]] });
  addObject('bench', drawBench(), { collision: [[0, 0]] });
  addObject('crate', drawCrate(), { collision: [[1]] });
  addObject('barrel', drawBarrel(), { collision: [[1]] });
  addObject('flowerpot_pink', drawFlowerPot(P.flowerPink), { collision: [[1]] });
  addObject('flowerpot_yellow', drawFlowerPot(P.flowerYellow), { collision: [[1]] });
  addObject('mailbox', drawMailbox(), { collision: [[1]] });
  addObject('well', drawWell(), {
    overheadRows: 1,
    collision: [
      [0, 0],
      [1, 1],
    ],
  });
  addObject('stall_red', drawStall(P.red, P.white), {
    overheadRows: 1,
    collision: [
      [0, 0],
      [1, 1],
    ],
  });
  addObject('stall_blue', drawStall(ROOFS.blue!.base, P.white), {
    overheadRows: 1,
    collision: [
      [0, 0],
      [1, 1],
    ],
  });
  addObject('fountain', drawFountain(), {
    collision: [
      [0, 1, 0],
      [1, 1, 1],
      [1, 1, 1],
    ],
  });
  addObject('sign_town', drawSign(['TINY PIXEL', 'PEOPLE']), {
    collision: [
      [0, 0, 0, 0, 0],
      [0, 1, 0, 1, 0],
    ],
  });
  addObject('shed', drawShed(), {
    overheadRows: 1,
    collision: [
      [0, 0],
      [1, 1],
    ],
  });
  for (const kind of ['sprout', 'cabbage', 'wheat', 'carrot', 'pumpkin'] as const) {
    addObject(`crop_${kind}`, cropTile(kind), { collision: [[0]] });
  }

  // decorations (reference "Decorate your cottage")
  addObject('deco_rug', drawWelcomeRug(), { collision: [[0, 0]] });
  addObject('deco_cushion', drawCushion(), { collision: [[0]] });
  addObject('deco_vase', drawVase(), { collision: [[1]] });
  addObject('deco_lantern', drawLantern(false), { collision: [[1]] });
  atlas.add('deco_lantern_lit', drawLantern(true));
  atlas.lit.set('deco_lantern_0_0', 'deco_lantern_lit');
  addObject('deco_flowerpots', drawFlowerPot(P.flowerPink), { collision: [[1]] });
  addObject('deco_bench', drawBench(), { collision: [[0, 0]] });
  addObject('deco_string_lights', drawStringLights(), { overheadRows: 1, collision: [[1, 0, 0, 0, 1]] });
  addObject('deco_mailbox', drawMailbox(), { collision: [[1]] });
  addObject('deco_flag', drawFlag(), { overheadRows: 1, collision: [[0], [1]] });
  addObject('deco_birdbath', drawBirdBath(), { collision: [[1]] });
  addObject('door_note', drawDoorNote(), { collision: [[0]] });

  for (const [name, spec] of Object.entries(BUILDINGS)) atlas.addBuilding(name, spec);
  return atlas;
}
