/**
 * Generates every art asset from code so the art stays reproducible and reviewable:
 *   npm run art
 * Outputs go to assets/ (served at /assets by Vite) and preview renders to docs/art/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { ICON, ICONS, drawGlow, drawIcon } from './icons.ts';
import { buildVillage, type MapBuilder } from './map.ts';
import type { ItemDef, WorldMap } from '../../src/shared/types.ts';
import { encodePng } from './png.ts';
import { TILE, buildAtlas, type TileAtlas } from './tiles.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TILE_COLUMNS = 16;
const ICON_COLUMNS = 8;

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
  const { builder: m, scenes, itemSpawns, decorations } = buildVillage(atlas);

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

  // map draft
  const toIds = (layer: (string | null)[]) => layer.map((n) => (n ? atlas.id(n) : -1));
  const worldMap: WorldMap = {
    width: m.width,
    height: m.height,
    tileSize: TILE,
    tilesets: [{ image: 'tiles/village.png', tileSize: TILE, columns: TILE_COLUMNS, firstIndex: 0 }],
    layers: {
      ground: toIds(m.layers.ground),
      decor: toIds(m.layers.decor),
      overhead: toIds(m.layers.overhead),
    },
    collision: m.collision,
    locations: m.locations,
    scenes,
    itemSpawns,
  };
  write('assets/maps/village.json', mapJson(worldMap));
  const items: ItemDef[] = [
    { id: 'flower', name: 'Wild flower', emoji: '🌸', sprite: 'ui/icons.json#flower' },
    { id: 'apple', name: 'Apple', emoji: '🍎', sprite: 'ui/icons.json#apple' },
    { id: 'seed', name: 'Seed packet', emoji: '🌱', sprite: 'ui/icons.json#seed' },
    { id: 'gem', name: 'Shiny pebble', emoji: '💎', sprite: 'ui/icons.json#gem' },
    { id: 'bread', name: 'Bread', emoji: '🍞', sprite: 'ui/icons.json#bread' },
    { id: 'honey', name: 'Honey jar', emoji: '🍯', sprite: 'ui/icons.json#honey' },
  ];
  write(
    'assets/maps/village.meta.json',
    json({
      note: 'Suggested catalogues matching the art; sprite = "<sheet json>#<name>" or an object name in tiles/village.json.',
      lights: m.lights,
      decorations,
      items,
      pet: { name: 'Pip', species: 'cat', sprite: 'characters/pet-pip.png' },
    }),
  );

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
