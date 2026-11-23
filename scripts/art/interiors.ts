import { PixelCanvas, type Color } from './canvas.ts';
import { P } from './palette.ts';
import { TILE, type ObjectDef, type TileAtlas } from './tiles.ts';
import type { InteriorObject, InteriorTemplate, Point } from '../../src/shared/types.ts';

/**
 * Interior templates (spec v2 §2.3): small separate tile maps that share the village tileset.
 * Rows 0-1 are the back wall, column 0 / width-1 the side walls, the last row the front wall with
 * the door (exit) in the middle; the player appears on the tile just inside the door.
 */

const WALLS: Record<string, { base: Color; light: Color; dark: Color }> = {
  cream: { base: P.wallCream, light: '#f3d49e', dark: P.wallCreamDark },
  blue: { base: '#9db8cf', light: '#b6cddf', dark: '#7f9ab2' },
  green: { base: '#a9c08e', light: '#bfd3a6', dark: '#8aa372' },
  rose: { base: '#dcaab0', light: '#ebc2c6', dark: '#c08a92' },
  purple: { base: '#a892b8', light: '#bea9cc', dark: '#8a759a' },
};

function tile(): PixelCanvas {
  return new PixelCanvas(TILE, TILE);
}

function floorWood(): PixelCanvas {
  const c = tile();
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const board = Math.floor(y / 4);
      const seam = (x + board * 7) % 16 === 0;
      c.set(x, y, y % 4 === 3 || seam ? P.woodDark : y % 4 === 0 ? P.woodLight : P.wood);
    }
  return c;
}

function floorTile(a: Color, b: Color): PixelCanvas {
  const c = tile();
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) c.set(x, y, (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? a : b);
  c.hline(0, 15, 0, P.stoneMid);
  c.vline(0, 0, 15, P.stoneMid);
  c.hline(0, 15, 8, P.stoneMid);
  c.vline(8, 0, 15, P.stoneMid);
  return c;
}

function carpet(): PixelCanvas {
  const c = tile();
  c.rect(0, 0, TILE, TILE, '#9a4a5a');
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if ((x + y) % 8 === 0) c.set(x, y, '#b86272');
  c.set(4, 4, P.flowerYellow);
  c.set(12, 12, P.flowerYellow);
  return c;
}

function wallTop(w: { base: Color; light: Color; dark: Color }): PixelCanvas {
  const c = tile();
  c.rect(0, 0, TILE, TILE, w.base);
  c.rect(0, 0, TILE, 3, P.woodDarker);
  c.hline(0, 15, 3, P.woodDark);
  for (let x = 2; x < TILE; x += 6) c.vline(x, 5, 15, w.light);
  return c;
}

function wallLow(w: { base: Color; light: Color; dark: Color }): PixelCanvas {
  const c = tile();
  c.rect(0, 0, TILE, TILE, w.base);
  for (let x = 2; x < TILE; x += 6) c.vline(x, 0, 10, w.light);
  c.rect(0, 11, TILE, 4, P.woodLight);
  c.hline(0, 15, 11, P.wood);
  c.hline(0, 15, 15, P.woodDarker);
  return c;
}

function wallSide(): PixelCanvas {
  const c = tile();
  c.rect(0, 0, TILE, TILE, P.woodDarker);
  c.rect(5, 0, 6, TILE, P.woodDark);
  c.vline(6, 0, 15, P.wood);
  return c;
}

function wallFront(): PixelCanvas {
  const c = tile();
  c.rect(0, 0, TILE, TILE, P.woodDarker);
  c.rect(0, 2, TILE, 6, P.woodDark);
  c.hline(0, 15, 3, P.wood);
  return c;
}

function doorMat(floor: PixelCanvas): PixelCanvas {
  const c = tile();
  c.blit(floor, 0, 0);
  c.rect(2, 4, 12, 9, P.red);
  c.rect(3, 5, 10, 7, P.redLight);
  c.hline(4, 11, 8, P.white);
  c.outline(P.outline);
  return c;
}

/** Draws on a w×h tile canvas with a 1px outline and a soft floor shadow. */
function obj(w: number, h: number, draw: (b: PixelCanvas) => void): PixelCanvas {
  const c = new PixelCanvas(w * TILE, h * TILE);
  const b = new PixelCanvas(w * TILE, h * TILE);
  draw(b);
  b.outline(P.outline);
  c.ellipse((w * TILE) / 2, h * TILE - 2, (w * TILE) / 2 - 2, 1.5, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

const drawBed = (quilt: Color, light: Color) =>
  obj(1, 2, (b) => {
    b.rect(1, 2, 14, 28, P.woodDark);
    b.rect(2, 3, 12, 6, P.white);
    b.rect(3, 4, 10, 4, P.flowerWhite);
    b.rect(2, 10, 12, 18, quilt);
    b.hline(2, 13, 10, light);
    for (let y = 14; y < 28; y += 5) b.hline(3, 12, y, light);
    b.rect(1, 28, 14, 2, P.woodDarker);
  });

const drawTable = () =>
  obj(2, 2, (b) => {
    b.rect(2, 6, 28, 14, P.woodLight);
    b.rect(2, 18, 28, 3, P.wood);
    b.rect(4, 21, 3, 8, P.woodDark);
    b.rect(25, 21, 3, 8, P.woodDark);
    b.rect(9, 8, 14, 8, P.white);
    b.rect(13, 9, 6, 4, P.red);
    b.set(15, 8, P.leafLight);
  });

const drawChair = () =>
  obj(1, 1, (b) => {
    b.rect(4, 1, 8, 6, P.wood);
    b.rect(3, 7, 10, 3, P.woodLight);
    b.rect(4, 10, 2, 5, P.woodDark);
    b.rect(10, 10, 2, 5, P.woodDark);
  });

const drawStove = () =>
  obj(1, 2, (b) => {
    b.rect(2, 6, 12, 24, P.metal);
    b.rect(3, 7, 10, 3, P.metalLight);
    b.rect(4, 16, 8, 8, '#2c2c32');
    b.rect(5, 19, 6, 4, P.autumn);
    b.rect(6, 0, 3, 6, P.metal);
  });

const drawShelf = () =>
  obj(2, 2, (b) => {
    b.rect(1, 2, 30, 28, P.woodDark);
    for (const y of [4, 13, 22]) {
      b.rect(2, y, 28, 7, P.woodDarker);
      b.hline(2, 29, y + 7, P.woodLight);
    }
    const books: Color[] = [P.red, P.flowerBlue, P.flowerYellow, P.leafLight, P.flowerPink];
    for (let i = 0; i < 9; i++) b.rect(3 + i * 3, 5 + (i % 3) * 9, 2, 6, books[i % books.length]!);
  });

const drawRug = (a: Color, bColor: Color) =>
  obj(2, 2, (b) => {
    b.ellipse(16, 16, 14, 11, a);
    b.ellipse(16, 16, 10, 7, bColor);
    b.ellipse(16, 16, 5, 3, a);
  });

const drawPlant = () =>
  obj(1, 1, (b) => {
    b.rect(4, 9, 8, 6, P.autumnDark);
    b.hline(4, 11, 9, P.autumn);
    b.ellipse(8, 6, 5, 4, P.leaf);
    b.ellipse(7, 5, 3, 2, P.leafLight);
  });

const drawWindow = () => {
  const c = tile();
  c.rect(2, 2, 12, 9, P.woodDarker);
  c.rect(3, 3, 10, 7, P.glass);
  c.rect(4, 4, 3, 2, P.glassLight);
  c.vline(8, 3, 9, P.woodDarker);
  c.hline(3, 12, 6, P.woodDarker);
  c.rect(1, 11, 14, 2, P.woodLight);
  return c;
};

const drawPicture = () => {
  const c = tile();
  c.rect(4, 3, 8, 7, P.wheatDark);
  c.rect(5, 4, 6, 5, P.waterLight);
  c.rect(5, 7, 6, 2, P.leafLight);
  c.set(9, 5, P.flowerYellow);
  return c;
};

const drawCounter = (w: number, top: Color, front: Color) =>
  obj(w, 1, (b) => {
    b.rect(0, 2, w * TILE, 4, top);
    b.rect(0, 6, w * TILE, 9, front);
    for (let x = 6; x < w * TILE; x += 12) b.vline(x, 7, 14, P.woodDarker);
  });

const drawKeepCupboard = () =>
  obj(2, 2, (b) => {
    b.rect(1, 1, 30, 30, '#6a4a7a');
    b.rect(2, 2, 28, 4, '#8a6a9a');
    b.rect(3, 7, 12, 22, '#58406a');
    b.rect(17, 7, 12, 22, '#58406a');
    for (let y = 9; y < 28; y += 4)
      for (const x of [4, 18]) {
        b.rect(x, y, 10, 2, '#e8d8b0');
        b.set(x + 4, y, P.red);
      }
    b.rect(14, 15, 4, 3, P.flowerYellow);
    b.set(15, 3, P.flowerYellow);
    b.set(16, 3, P.flowerYellow);
  });

const drawMailbags = () =>
  obj(1, 1, (b) => {
    b.ellipse(5, 10, 4, 5, '#b49a6a');
    b.ellipse(11, 11, 4, 4, '#a08858');
    b.rect(3, 4, 4, 2, '#8a7448');
    b.rect(5, 9, 3, 2, P.white);
  });

const drawSorter = () =>
  obj(2, 2, (b) => {
    b.rect(1, 2, 30, 28, P.wood);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 5; x++) {
        b.rect(3 + x * 6, 4 + y * 6, 4, 4, P.woodDarker);
        if ((x + y) % 2) b.rect(3 + x * 6, 6 + y * 6, 4, 2, P.white);
      }
  });

const drawSofa = (a: Color, l: Color) =>
  obj(2, 1, (b) => {
    b.rect(1, 2, 30, 7, a);
    b.rect(0, 6, 32, 7, a);
    b.rect(3, 6, 12, 4, l);
    b.rect(17, 6, 12, 4, l);
    b.rect(2, 13, 2, 2, P.woodDarker);
    b.rect(28, 13, 2, 2, P.woodDarker);
  });

const drawStairs = () =>
  obj(2, 2, (b) => {
    for (let i = 0; i < 6; i++) {
      b.rect(2 + i * 2, 2 + i * 5, 28 - i * 4, 5, i % 2 ? P.woodLight : P.wood);
      b.hline(2 + i * 2, 29 - i * 2, 6 + i * 5, P.woodDark);
    }
    b.rect(0, 0, 2, 32, P.woodDarker);
    b.rect(30, 0, 2, 32, P.woodDarker);
  });

const drawBell = () =>
  obj(1, 1, (b) => {
    b.ellipse(8, 10, 4, 3, P.wheat);
    b.rect(7, 5, 2, 2, P.wheatDark);
  });

const drawClock = () => {
  const c = tile();
  c.ellipse(8, 7, 5, 5, P.woodDark);
  c.ellipse(8, 7, 4, 4, P.white);
  c.vline(8, 4, 7, P.outline);
  c.hline(8, 10, 7, P.outline);
  return c;
};

/** Adds the interior floors, walls and furniture to the atlas (after every outdoor tile). */
export function addInteriorTiles(atlas: TileAtlas): void {
  const wood = floorWood();
  atlas.add('int_floor_wood', wood);
  atlas.add('int_floor_tile', floorTile(P.stone, P.wallWhite));
  atlas.add('int_floor_carpet', carpet());
  for (const [k, w] of Object.entries(WALLS)) {
    atlas.add(`int_wall_${k}_top`, wallTop(w));
    atlas.add(`int_wall_${k}_low`, wallLow(w));
  }
  atlas.add('int_wall_side', wallSide());
  atlas.add('int_wall_front', wallFront());
  atlas.add('int_door_wood', doorMat(wood));
  atlas.add('int_door_tile', doorMat(floorTile(P.stone, P.wallWhite)));
  atlas.add('int_door_carpet', doorMat(carpet()));
  atlas.add('int_window', drawWindow());
  atlas.add('int_picture', drawPicture());
  atlas.add('int_clock', drawClock());
  const o = atlas.addObject.bind(atlas);
  o('int_bed_blue', drawBed('#5c7fb0', '#7698c6'), { collision: [[1], [1]] });
  o('int_bed_red', drawBed(P.red, P.redLight), { collision: [[1], [1]] });
  o('int_bed_green', drawBed('#5f8a45', '#78a656'), { collision: [[1], [1]] });
  o('int_table', drawTable(), {
    collision: [
      [1, 1],
      [1, 1],
    ],
  });
  o('int_chair', drawChair(), { collision: [[0]] });
  o('int_stove', drawStove(), { collision: [[1], [1]] });
  o('int_shelf', drawShelf(), {
    collision: [
      [1, 1],
      [1, 1],
    ],
  });
  o('int_rug_red', drawRug(P.red, P.flowerYellow), {
    collision: [
      [0, 0],
      [0, 0],
    ],
  });
  o('int_rug_blue', drawRug('#5c7fb0', P.white), {
    collision: [
      [0, 0],
      [0, 0],
    ],
  });
  o('int_plant', drawPlant(), { collision: [[1]] });
  o('int_counter_post', drawCounter(4, '#5a86bc', P.wood), { collision: [[1, 1, 1, 1]] });
  o('int_counter_hotel', drawCounter(4, P.woodLight, '#7a5a8c'), { collision: [[1, 1, 1, 1]] });
  o('keep_cupboard', drawKeepCupboard(), {
    collision: [
      [1, 1],
      [1, 1],
    ],
  });
  o('int_mailbags', drawMailbags(), { collision: [[1]] });
  o('int_sorter', drawSorter(), {
    collision: [
      [1, 1],
      [1, 1],
    ],
  });
  o('int_sofa', drawSofa('#7a5a8c', '#9372a6'), { collision: [[0, 0]] });
  o('int_stairs', drawStairs(), {
    collision: [
      [1, 1],
      [1, 1],
    ],
  });
  o('int_bell', drawBell(), { collision: [[0]] });
}

class InteriorBuilder {
  readonly ground: string[];
  readonly decor: (string | null)[];
  readonly overhead: (string | null)[];
  readonly collision: (0 | 1)[];
  readonly objects: InteriorObject[] = [];
  readonly exit: Point;
  readonly entry: Point;

  constructor(
    private readonly atlas: TileAtlas,
    readonly width: number,
    readonly height: number,
    floor: 'wood' | 'tile' | 'carpet',
    wall: keyof typeof WALLS,
  ) {
    const n = width * height;
    this.ground = new Array<string>(n);
    this.decor = new Array<string | null>(n).fill(null);
    this.overhead = new Array<string | null>(n).fill(null);
    this.collision = new Array<0 | 1>(n).fill(0);
    this.exit = { x: Math.floor(width / 2), y: height - 1 };
    this.entry = { x: this.exit.x, y: height - 2 };
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let t = `int_floor_${floor}`;
        let blocked = false;
        if (x === 0 || x === width - 1) [t, blocked] = ['int_wall_side', true];
        else if (y === 0) [t, blocked] = [`int_wall_${wall}_top`, true];
        else if (y === 1) [t, blocked] = [`int_wall_${wall}_low`, true];
        else if (y === height - 1)
          [t, blocked] = x === this.exit.x ? [`int_door_${floor}`, false] : ['int_wall_front', true];
        this.ground[i] = t;
        this.collision[i] = blocked ? 1 : 0;
      }
  }

  /** Wall decoration on the lower back-wall row. */
  wall(name: string, x: number): void {
    this.decor[this.width + x] = name;
  }

  place(name: string, x: number, y: number, interactive = false): ObjectDef {
    const def = this.atlas.objects[name];
    if (!def) throw new Error(`unknown interior object ${name}`);
    for (let dy = 0; dy < def.h; dy++)
      for (let dx = 0; dx < def.w; dx++) {
        const i = (y + dy) * this.width + x + dx;
        const d = def.layers.decor?.[dy]?.[dx];
        const o = def.layers.overhead?.[dy]?.[dx];
        if (d) this.decor[i] = d;
        if (o) this.overhead[i] = o;
        if (def.collision[dy]![dx]) this.collision[i] = 1;
      }
    if (interactive) this.objects.push({ id: name, pos: { x, y: y + def.h - 1 } });
    return def;
  }

  build(id: string, name: string, spots: Point[]): InteriorTemplate {
    const ids = (layer: (string | null)[]) => layer.map((n) => (n ? this.atlas.id(n) : -1));
    const t: InteriorTemplate = {
      id,
      name,
      width: this.width,
      height: this.height,
      layers: { ground: ids(this.ground), decor: ids(this.decor), overhead: ids(this.overhead) },
      collision: this.collision,
      entry: this.entry,
      exit: this.exit,
      spots,
    };
    if (this.objects.length) t.objects = this.objects;
    return t;
  }
}

/** House templates (cottage_a/b/c), the hotel lobby and the post office with the Keep cupboard. */
export function buildInteriors(atlas: TileAtlas): InteriorTemplate[] {
  const out: InteriorTemplate[] = [];

  // cottage_a: bed left, kitchen right, table in the middle
  {
    const b = new InteriorBuilder(atlas, 12, 8, 'wood', 'cream');
    b.wall('int_picture', 1);
    b.wall('int_window', 6);
    b.wall('int_window', 8);
    b.place('int_bed_blue', 1, 2);
    b.place('int_shelf', 3, 1);
    b.place('int_stove', 10, 1);
    b.place('int_table', 6, 3);
    b.place('int_chair', 5, 4);
    b.place('int_chair', 8, 4);
    b.place('int_rug_red', 2, 4);
    b.place('int_plant', 10, 6);
    out.push(b.build('cottage_a', 'Cosy cottage', [p(2, 3), p(5, 4), p(8, 4), p(3, 5)]));
  }
  // cottage_b: green walls, bed right, table left
  {
    const b = new InteriorBuilder(atlas, 12, 8, 'wood', 'green');
    b.wall('int_window', 2);
    b.wall('int_clock', 5);
    b.wall('int_window', 9);
    b.place('int_stove', 1, 1);
    b.place('int_table', 2, 3);
    b.place('int_chair', 4, 3);
    b.place('int_chair', 4, 4);
    b.place('int_shelf', 7, 1);
    b.place('int_bed_green', 10, 2);
    b.place('int_rug_blue', 7, 4);
    b.place('int_plant', 1, 6);
    out.push(b.build('cottage_b', 'Garden cottage', [p(9, 3), p(4, 3), p(4, 4), p(8, 5)]));
  }
  // cottage_c: rose walls, tile floor
  {
    const b = new InteriorBuilder(atlas, 12, 8, 'tile', 'rose');
    b.wall('int_picture', 2);
    b.wall('int_window', 5);
    b.wall('int_window', 9);
    b.place('int_bed_red', 1, 2);
    b.place('int_plant', 3, 2);
    b.place('int_sofa', 4, 5);
    b.place('int_table', 8, 3);
    b.place('int_chair', 7, 3);
    b.place('int_chair', 10, 4);
    b.place('int_stove', 10, 1);
    out.push(b.build('cottage_c', 'Rose cottage', [p(2, 4), p(7, 3), p(10, 4), p(4, 5)]));
  }
  // hotel lobby: reception desk, sofas, stairs up to the rooms
  {
    const b = new InteriorBuilder(atlas, 14, 8, 'carpet', 'purple');
    b.wall('int_window', 2);
    b.wall('int_clock', 6);
    b.wall('int_picture', 8);
    b.place('int_counter_hotel', 4, 3);
    b.place('int_bell', 6, 2);
    b.place('int_stairs', 11, 1);
    b.place('int_sofa', 1, 5);
    b.place('int_sofa', 9, 5);
    b.place('int_plant', 1, 2);
    b.place('int_plant', 12, 6);
    out.push(b.build('hotel_lobby', 'Hotel lobby', [p(5, 2), p(1, 5), p(2, 5), p(9, 5), p(10, 5), p(10, 3)]));
  }
  // post office: counter with Laude behind it, sorting shelves and the Keep cupboard
  {
    const b = new InteriorBuilder(atlas, 14, 8, 'tile', 'blue');
    b.wall('int_window', 4);
    b.wall('int_clock', 7);
    b.wall('int_window', 9);
    b.place('int_sorter', 1, 1);
    b.place('int_counter_post', 3, 3);
    b.place('int_mailbags', 8, 2);
    b.place('keep_cupboard', 11, 1, true);
    b.place('int_plant', 1, 6);
    b.place('int_rug_blue', 4, 5);
    out.push(b.build('post_office', 'Post office', [p(4, 2), p(5, 4), p(9, 4), p(10, 3)]));
  }
  return out;
}

const p = (x: number, y: number): Point => ({ x, y });
