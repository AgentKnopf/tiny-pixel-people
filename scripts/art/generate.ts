/**
 * Generates every art asset from code so the art stays reproducible and reviewable:
 *   npm run art
 * Outputs go to assets/ (served at /assets by Vite) and preview renders to docs/art/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PixelCanvas, type Rgba } from './canvas.ts';
import {
  CHARACTERS,
  DIRECTIONS,
  FRAME,
  FRAME_H,
  FRAMES_PER_DIRECTION,
  drawCharacterSheet,
  drawPetSheet,
} from './characters.ts';
import { ICON, ICONS as ICONS_V1, drawGlow, drawIcon } from './icons.ts';
import { ICONS_V2 } from './icons-v2.ts';
import { buildVillage, type MapBuilder } from './map.ts';
import type { ItemDef, Location, WorldMap } from '../../src/shared/types.ts';
import { encodePng } from './png.ts';
import { ANIMALS, ANIMAL_FRAMES, ANIMAL_ROWS, CROW_FRAMES, crow, drawAnimalSheet } from './animals.ts';
import { buildVillageV2 } from './map-v2.ts';
import {
  CAROUSEL_FRAMES,
  FERRIS_FRAMES,
  TRAIN_PIECE,
  TRAIN_ROWS,
  drawCarouselSheet,
  drawCoasterCarSheet,
  drawFerrisSheet,
  drawIceCreamSheet,
  drawTrainSheet,
} from './rides.ts';
import { TILE, buildAtlas, type TileAtlas } from './tiles.ts';
import { extendAtlasV2 } from './v2-tiles.ts';
import { addInteriorTiles } from './interiors.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TILE_COLUMNS = 16;
const ICON_COLUMNS = 8;
const dupIcons = Object.keys(ICONS_V2).filter((n) => n in ICONS_V1);
if (dupIcons.length) throw new Error(`duplicate icons ${dupIcons.join(', ')}`);
/** v2 icons come after the v1 ones so existing icon indices stay stable. */
const ICONS = { ...ICONS_V1, ...ICONS_V2 };

export type ArtFiles = Map<string, string | Buffer>;

let files: ArtFiles = new Map();

function write(rel: string, data: string | Buffer): void {
  files.set(rel, data);
}

function writePng(rel: string, c: PixelCanvas): void {
  write(rel, encodePng(c.width, c.height, c.data));
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Arrays of numbers on one line keep the map file readable in diffs. */
function mapJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replace(/\[\s+(-?\d+(?:,\s+-?\d+)*)\s+\]/g, (_m, inner: string) => `[${inner.replace(/\s+/g, ' ')}]`)}\n`;
}

function renderMap(
  atlas: TileAtlas,
  m: MapBuilder,
  night: boolean,
  sprites: { sheet: PixelCanvas; x: number; y: number; dir: number }[],
): PixelCanvas {
  const out = new PixelCanvas(m.width * TILE, m.height * TILE);
  const drawLayer = (layer: 'ground' | 'decor' | 'overhead') => {
    m.layers[layer].forEach((name, i) => {
      if (!name) return;
      const use = night && atlas.lit.has(name) ? atlas.lit.get(name)! : name;
      const t = atlas.tiles[atlas.id(use)]!;
      out.blit(t.canvas, (i % m.width) * TILE, Math.floor(i / m.width) * TILE);
    });
  };
  drawLayer('ground');
  drawLayer('decor');
  for (const s of [...sprites].sort((a, b) => a.y - b.y))
    out.blit(s.sheet, s.x * TILE, s.y * TILE - (FRAME_H - TILE), 0, s.dir * FRAME_H, FRAME, FRAME_H);
  drawLayer('overhead');
  if (night) {
    const litPixels = new Set<number>();
    m.layers.decor.forEach((name, i) => {
      if (!name || !atlas.lit.has(name)) return;
      const t = atlas.tiles[atlas.id(atlas.lit.get(name)!)]!;
      const ox = (i % m.width) * TILE;
      const oy = Math.floor(i / m.width) * TILE;
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          const [r, g, b] = t.canvas.get(x, y);
          if (r > 230 && g > 180 && b < 170) litPixels.add((oy + y) * out.width + ox + x);
        }
    });
    out.map((c, x, y) => {
      if (litPixels.has(y * out.width + x)) return c;
      return [Math.round(c[0] * 0.42), Math.round(c[1] * 0.5), Math.round(c[2] * 0.58), c[3]] as Rgba;
    });
    const glow = drawGlow(96);
    const small = drawGlow(40);
    for (const l of m.lights) {
      const g = l.kind === 'lamp' ? glow : small;
      const cx = l.x * TILE + 8;
      const cy = l.y * TILE + (l.kind === 'lamp' ? 6 : 8);
      out.blit(g, cx - g.width / 2, cy - g.height / 2);
    }
  }
  return out;
}

/** Builds every asset in memory; keys are repo-relative paths. */
export function buildArt(): ArtFiles {
  files = new Map();
  const atlas = buildAtlas();
  extendAtlasV2(atlas);
  addInteriorTiles(atlas);
  /** The v1 48×30 town is still built for the town previews below. */
  const { builder: m, scenes, decorations } = buildVillage(atlas);

  // tileset
  writePng('assets/tiles/village.png', atlas.sheet(TILE_COLUMNS));
  write(
    'assets/tiles/village.json',
    mapJson({
      image: 'tiles/village.png',
      tileSize: TILE,
      columns: TILE_COLUMNS,
      count: atlas.tiles.length,
      tiles: Object.fromEntries(atlas.index),
      lit: Object.fromEntries([...atlas.lit].map(([day, night]) => [atlas.id(day), atlas.id(night)])),
      objects: atlas.objects,
    }),
  );

  // characters
  const sheets = new Map<string, PixelCanvas>();
  for (const look of CHARACTERS) {
    const sheet = drawCharacterSheet(look);
    sheets.set(look.key, sheet);
    writePng(`assets/characters/${look.key}.png`, sheet);
  }
  const pet = drawPetSheet();
  writePng('assets/characters/pet-pip.png', pet);
  write(
    'assets/characters/index.json',
    json({
      frameWidth: FRAME,
      frameHeight: FRAME_H,
      anchor: { x: 8, y: 22 },
      framesPerDirection: FRAMES_PER_DIRECTION,
      rows: DIRECTIONS,
      walkFps: 8,
      idleFrame: 0,
      characters: [
        ...CHARACTERS.map((c) => ({
          sprite: `characters/${c.key}.png`,
          description: c.description,
          suggestedRole: c.suggestedRole,
        })),
        {
          sprite: 'characters/pet-pip.png',
          description: 'orange cat "Pip", the player pet',
          suggestedRole: 'pet',
        },
      ],
    }),
  );

  // ui icons
  const names = Object.keys(ICONS);
  const iconSheet = new PixelCanvas(ICON_COLUMNS * ICON, Math.ceil(names.length / ICON_COLUMNS) * ICON);
  names.forEach((n, i) =>
    iconSheet.blit(drawIcon(ICONS[n]!), (i % ICON_COLUMNS) * ICON, Math.floor(i / ICON_COLUMNS) * ICON),
  );
  writePng('assets/ui/icons.png', iconSheet);
  write(
    'assets/ui/icons.json',
    json({
      image: 'ui/icons.png',
      size: ICON,
      columns: ICON_COLUMNS,
      icons: Object.fromEntries(names.map((n, i) => [n, i])),
    }),
  );
  writePng('assets/ui/glow.png', drawGlow(64));

  const toIds = (layer: (string | null)[]) => layer.map((n) => (n ? atlas.id(n) : -1));
  const items: ItemDef[] = [
    { id: 'flower', name: 'Wild flower', emoji: '🌸', sprite: 'ui/icons.json#flower' },
    { id: 'apple', name: 'Apple', emoji: '🍎', sprite: 'ui/icons.json#apple' },
    { id: 'seed', name: 'Seed packet', emoji: '🌱', sprite: 'ui/icons.json#seed' },
    { id: 'gem', name: 'Shiny pebble', emoji: '💎', sprite: 'ui/icons.json#gem' },
    { id: 'bread', name: 'Bread', emoji: '🍞', sprite: 'ui/icons.json#bread' },
    { id: 'honey', name: 'Honey jar', emoji: '🍯', sprite: 'ui/icons.json#honey' },
  ];
  // the map (128×60): v1 town unchanged plus the new districts
  const v2 = buildVillageV2(atlas);
  const m2 = v2.builder;
  const worldMap: WorldMap = {
    width: m2.width,
    height: m2.height,
    tileSize: TILE,
    tilesets: [{ image: 'tiles/village.png', tileSize: TILE, columns: TILE_COLUMNS, firstIndex: 0 }],
    layers: {
      ground: toIds(m2.layers.ground),
      decor: toIds(m2.layers.decor),
      overhead: toIds(m2.layers.overhead),
    },
    collision: m2.collision,
    locations: v2.locations,
    scenes: v2.scenes,
    itemSpawns: v2.itemSpawns,
    districts: v2.districts,
    interiors: v2.interiors,
    railway: v2.railway,
  };
  write('assets/maps/village.json', mapJson(worldMap));
  // data/map/village.json is the same map; the sim owns its location names and owners, so those win.
  const dataPath = join(ROOT, 'data/map/village.json');
  const dataLocations = existsSync(dataPath)
    ? new Map((JSON.parse(readFileSync(dataPath, 'utf8')) as WorldMap).locations.map((l) => [l.id, l]))
    : new Map<string, Location>();
  write(
    'data/map/village.json',
    mapJson({
      ...worldMap,
      locations: worldMap.locations.map((l) => ({ ...l, ...dataLocations.get(l.id) })),
    }),
  );
  write(
    'assets/maps/village.meta.json',
    json({
      note: 'Suggested catalogues matching the art; sprite = "<sheet json>#<name>" or an object name in tiles/village.json.',
      lights: m2.lights,
      decorations: v2.decorations,
      items,
      pet: { name: 'Pip', species: 'cat', sprite: 'characters/pet-pip.png' },
    }),
  );
  {
    const pad = 8;
    const ws = v2.interiors.map((t) => t.width * TILE);
    const sheet = new PixelCanvas(
      ws.reduce((s, w) => s + w + pad, pad),
      Math.max(...v2.interiors.map((t) => t.height * TILE)) + pad * 2,
    );
    sheet.rect(0, 0, sheet.width, sheet.height, '#272618');
    let ox = pad;
    for (const t of v2.interiors) {
      for (const layer of ['ground', 'decor', 'overhead'] as const)
        t.layers[layer].forEach((id, i) => {
          if (id >= 0)
            sheet.blit(
              atlas.tiles[id]!.canvas,
              ox + (i % t.width) * TILE,
              pad + Math.floor(i / t.width) * TILE,
            );
        });
      ox += t.width * TILE + pad;
    }
    writePng('docs/art/interiors-x3.png', sheet.scaled(3));
  }
  // previews
  const demo = CHARACTERS.slice(0, 14).map((c, i) => {
    const loc = m.locations.find((l) => l.id === 'square')!;
    const spot = loc.spots![i % loc.spots!.length]!;
    return { sheet: sheets.get(c.key)!, x: i < 10 ? spot.x : 8 + i, y: i < 10 ? spot.y : 20, dir: i % 4 };
  });
  demo.push({ sheet: sheets.get('player')!, x: 4, y: 27, dir: 0 }, { sheet: pet, x: 5, y: 27, dir: 2 });
  writePng('docs/art/map-day.png', renderMap(atlas, m, false, demo).scaled(2));
  writePng('docs/art/map-night.png', renderMap(atlas, m, true, demo).scaled(2));
  writePng('docs/art/tileset-x2.png', atlas.sheet(TILE_COLUMNS).scaled(2));
  writePng('docs/art/icons-x4.png', iconSheet.scaled(4));
  const all = [...CHARACTERS.map((c) => sheets.get(c.key)!), pet];
  const charSheet = new PixelCanvas(
    all.length * (FRAME * FRAMES_PER_DIRECTION + 4),
    FRAME_H * DIRECTIONS.length,
  );
  all.forEach((s, i) => charSheet.blit(s, i * (FRAME * FRAMES_PER_DIRECTION + 4), 0));
  const bg = new PixelCanvas(charSheet.width, charSheet.height);
  bg.rect(0, 0, bg.width, bg.height, '#85aa4e');
  bg.blit(charSheet, 0, 0);
  writePng('docs/art/characters-x3.png', bg.scaled(3));

  // decorations and the zoomed "Your home" scene
  const decoNames = Object.keys(atlas.objects).filter((n) => n.startsWith('deco_'));
  const deco = new PixelCanvas(decoNames.length * 6 * TILE, 3 * TILE);
  deco.rect(0, 0, deco.width, deco.height, '#85aa4e');
  decoNames.forEach((n, i) => {
    const def = atlas.objects[n]!;
    for (const layer of ['decor', 'overhead'] as const)
      def.layers[layer]?.forEach((row, y) =>
        row.forEach((cell, x) => {
          if (cell)
            deco.blit(
              atlas.tiles[atlas.id(cell)]!.canvas,
              (i * 6 + 1 + x) * TILE,
              (1 + y - (def.h > 1 ? 1 : 0)) * TILE,
            );
        }),
      );
  });
  writePng('docs/art/decorations-x4.png', deco.scaled(4));
  const home = scenes.find((sc) => sc.id === 'home')!.rect;
  const decorated = renderMap(atlas, m, false, demo);
  for (const d of decorations) {
    const slot = m.locations.find((l) => l.id === 'player_home')!.decorSlots![d.slot]!;
    const def = atlas.objects[d.sprite]!;
    for (const layer of ['decor', 'overhead'] as const)
      def.layers[layer]?.forEach((row, y) =>
        row.forEach((cell, x) => {
          if (cell)
            decorated.blit(atlas.tiles[atlas.id(cell)]!.canvas, (slot.x + x) * TILE, (slot.y + y) * TILE);
        }),
      );
  }
  writePng(
    'docs/art/scene-home-decorated-x4.png',
    decorated.crop(home.x * TILE, home.y * TILE, home.w * TILE, home.h * TILE).scaled(4),
  );
  writePng(
    'docs/art/scene-home-x4.png',
    renderMap(atlas, m, false, demo)
      .crop(home.x * TILE, home.y * TILE, home.w * TILE, home.h * TILE)
      .scaled(4),
  );

  // animals
  const animalSheets: { key: string; sheet: PixelCanvas }[] = [];
  const animalIndex = ANIMALS.map(({ group, species, age, spec }) => {
    const sheet = drawAnimalSheet(spec);
    animalSheets.push({ key: spec.key, sheet });
    writePng(`assets/animals/${spec.key}.png`, sheet);
    return {
      key: spec.key,
      group,
      species,
      ...(age ? { age } : {}),
      sprite: `animals/${spec.key}.png`,
      frameWidth: spec.w,
      frameHeight: spec.h,
      anchor: { x: spec.w / 2, y: spec.h - 2 },
      description: spec.description,
    };
  });
  const crowSpec = crow();
  const crowSheet = drawAnimalSheet(crowSpec, 7);
  animalSheets.push({ key: 'crow', sheet: crowSheet });
  writePng('assets/animals/crow.png', crowSheet);
  write(
    'assets/animals/index.json',
    json({
      note: 'Side-view sheets: row 0 faces left, row 1 faces right; columns per "frames". Anchor = feet.',
      rows: ANIMAL_ROWS,
      frames: ANIMAL_FRAMES,
      fps: { idle: 2, walk: 6 },
      animals: [
        ...animalIndex,
        {
          key: 'crow',
          group: 'crow',
          species: 'crow',
          sprite: 'animals/crow.png',
          frameWidth: crowSpec.w,
          frameHeight: crowSpec.h,
          anchor: { x: crowSpec.w / 2, y: crowSpec.h - 2 },
          frames: CROW_FRAMES,
          description: crowSpec.description,
        },
      ],
    }),
  );

  // vehicles and rides
  const train = drawTrainSheet();
  const coasterCar = drawCoasterCarSheet();
  const ferris = drawFerrisSheet();
  const carousel = drawCarouselSheet();
  const iceCream = drawIceCreamSheet();
  writePng('assets/vehicles/train.png', train);
  writePng('assets/vehicles/coaster-car.png', coasterCar);
  writePng('assets/vehicles/ice-cream-truck.png', iceCream);
  writePng('assets/rides/ferris-wheel.png', ferris);
  writePng('assets/rides/carousel.png', carousel);
  write(
    'assets/vehicles/index.json',
    json({
      train: {
        sprite: 'vehicles/train.png',
        frameWidth: TRAIN_PIECE.w,
        frameHeight: TRAIN_PIECE.h,
        frames: 2,
        rows: [...TRAIN_ROWS.map((r) => `${r}_left`), ...TRAIN_ROWS.map((r) => `${r}_right`)],
        note: 'Draw engine then 3 carriages; bottom of the frame sits on the bottom of the rail row. Arriving trains move west (rows *_left).',
      },
      coasterCar: {
        sprite: 'vehicles/coaster-car.png',
        frameWidth: 16,
        frameHeight: 16,
        columns: ['east', 'south', 'west', 'north'],
      },
      iceCreamTruck: { sprite: 'vehicles/ice-cream-truck.png', frameWidth: 32, frameHeight: 16, frames: 2 },
      ferrisWheel: {
        sprite: 'rides/ferris-wheel.png',
        frameWidth: ferris.width / FERRIS_FRAMES,
        frameHeight: ferris.height,
        frames: FERRIS_FRAMES,
        object: 'ferris_wheel',
        note: 'Loop frames over the ferris_wheel map object (same size and origin).',
      },
      carousel: {
        sprite: 'rides/carousel.png',
        frameWidth: carousel.width / CAROUSEL_FRAMES,
        frameHeight: carousel.height,
        frames: CAROUSEL_FRAMES,
        object: 'carousel',
      },
    }),
  );
  {
    const gap = 4;
    const rows = animalSheets.map((a) => a.sheet);
    const wMax = Math.max(...rows.map((s) => s.width));
    const pv = new PixelCanvas(wMax * 2 + gap * 3, 0 + 1);
    void pv;
    const half = Math.ceil(rows.length / 2);
    const colH = (list: PixelCanvas[]) => list.reduce((s, r) => s + r.height + gap, gap);
    const left = rows.slice(0, half);
    const right = rows.slice(half);
    const out = new PixelCanvas(wMax * 2 + gap * 3, Math.max(colH(left), colH(right)));
    out.rect(0, 0, out.width, out.height, '#85aa4e');
    let y = gap;
    for (const s of left) {
      out.blit(s, gap, y);
      y += s.height + gap;
    }
    y = gap;
    for (const s of right) {
      out.blit(s, wMax + gap * 2, y);
      y += s.height + gap;
    }
    writePng('docs/art/animals-x3.png', out.scaled(3));
    const rides = new PixelCanvas(
      Math.max(train.width + coasterCar.width + iceCream.width + 16, ferris.width),
      train.height + ferris.height + carousel.height + 16,
    );
    rides.rect(0, 0, rides.width, rides.height, '#85aa4e');
    rides.blit(train, 0, 0);
    rides.blit(coasterCar, train.width + 8, 0);
    rides.blit(iceCream, train.width + 8, 24);
    rides.blit(ferris, 0, train.height + 8);
    rides.blit(carousel, 0, train.height + ferris.height + 12);
    writePng('docs/art/vehicles-rides-x2.png', rides.scaled(2));
  }

  writePng('docs/art/map-v2-day.png', renderMap(atlas, m2, false, []));
  writePng('docs/art/map-v2-night.png', renderMap(atlas, m2, true, []));

  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildArt();
  for (const [rel, data] of out) {
    const path = join(ROOT, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  console.log(`wrote ${out.size} files`);
}
