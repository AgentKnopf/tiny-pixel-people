import type { AnimalSpecies, AnimalStage, DecorationItem, ItemDef, TilesetRef } from '../../shared/types.ts';
import {
  placeholderAnimalSheet,
  resolveEntry,
  sheetInfo,
  type AnimalIndex,
  type AnimalSheetInfo,
} from './animals.ts';
import { placeholderSheet, SHEET_H, SHEET_W, spriteUrl, type PlaceholderKind } from './sprites.ts';

/** `tiles/village.json` sidecar (docs/art/README.md). */
export interface TilesetMeta {
  image: string;
  tileSize: number;
  columns: number;
  tiles: Record<string, number>;
  /** Day tile index → night (lit) variant. */
  lit: Record<string, number>;
  objects: Record<string, TileObject>;
}

export interface TileObject {
  w: number;
  h: number;
  layers: { decor?: (string | null)[][]; overhead?: (string | null)[][] };
  anchors?: Record<string, { x: number; y: number }>;
}

export interface IconSheetMeta {
  image: string;
  size: number;
  columns: number;
  icons: Record<string, number>;
}

export interface LightSpot {
  x: number;
  y: number;
  kind?: string;
}

/** `maps/village.meta.json`: night lights plus suggested client-side catalogues. */
export interface MapMeta {
  lights?: LightSpot[];
  decorations?: DecorationItem[];
  items?: ItemDef[];
  pet?: { name?: string; species?: string; sprite?: string };
}

export type Drawable = HTMLImageElement | HTMLCanvasElement;

export interface LoadedTileset {
  ref: TilesetRef;
  image: Drawable;
  meta: TilesetMeta | null;
}

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function loadJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    // The static server falls back to index.html for unknown paths.
    if (type.includes('text/html')) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Asset key ("tiles/village.png", served from the web root by Vite) → URL. */
export function assetUrl(key: string): string {
  return `/${key.replace(/^\/+/, '').replace(/^assets\//, '')}`;
}

export function sidecarUrl(imageKey: string): string {
  return assetUrl(imageKey.replace(/\.png$/, '.json'));
}

function canvasFromPixels(px: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const data = ctx.createImageData(w, h);
  data.data.set(px);
  ctx.putImageData(data, 0, 0);
  return c;
}

/**
 * Loads and caches art. Every getter returns something drawable right away: a procedural placeholder
 * until (or if never) the real PNG arrives. `onChange` fires when a real asset replaces a placeholder.
 */
export class Assets {
  tilesets: LoadedTileset[] = [];
  icons: { image: Drawable; meta: IconSheetMeta } | null = null;
  glow: Drawable | null = null;
  meta: MapMeta | null = null;
  animalIndex: AnimalIndex | null = null;
  private sheets = new Map<string, Drawable>();
  private images = new Map<string, Drawable | null>();
  private placeholders = new Map<string, { image: Drawable; info: AnimalSheetInfo }>();
  private infos = new Map<string, AnimalSheetInfo>();
  private pending = new Set<string>();

  constructor(private onChange: () => void = () => {}) {}

  async loadTilesets(refs: TilesetRef[]): Promise<void> {
    const loaded = await Promise.all(
      refs.map(async (ref): Promise<LoadedTileset | null> => {
        const [image, meta] = await Promise.all([
          loadImage(assetUrl(ref.image)),
          loadJson<TilesetMeta>(sidecarUrl(ref.image)),
        ]);
        return image ? { ref, image, meta } : null;
      }),
    );
    this.tilesets = loaded.filter((t): t is LoadedTileset => t !== null);
    this.onChange();
  }

  async loadCommon(): Promise<void> {
    const [iconMeta, glow, meta, animals] = await Promise.all([
      loadJson<IconSheetMeta>(assetUrl('ui/icons.json')),
      loadImage(assetUrl('ui/glow.png')),
      loadJson<MapMeta>(assetUrl('maps/village.meta.json')),
      loadJson<AnimalIndex>(assetUrl('animals/index.json')),
    ]);
    if (animals && Array.isArray(animals.animals)) this.animalIndex = animals;
    if (iconMeta) {
      const img = await loadImage(assetUrl(iconMeta.image));
      if (img) this.icons = { image: img, meta: iconMeta };
    }
    this.glow = glow;
    this.meta = meta;
    this.onChange();
  }

  /** Tileset object (`house_brown`, `deco_mailbox`, `door_note`…) by name, from any loaded tileset. */
  object(name: string): { obj: TileObject; tileset: LoadedTileset } | null {
    for (const ts of this.tilesets) {
      const obj = ts.meta?.objects[name];
      if (obj) return { obj, tileset: ts };
    }
    return null;
  }

  tileIndex(name: string): { index: number; tileset: LoadedTileset } | null {
    for (const ts of this.tilesets) {
      const i = ts.meta?.tiles[name];
      if (i !== undefined) return { index: i, tileset: ts };
    }
    return null;
  }

  /** Character sheet for a sprite key; placeholder (seeded by `seed`) while loading or on error. */
  sheet(key: string, seed: string, kind: PlaceholderKind = 'villager'): Drawable {
    const url = spriteUrl(key || `missing-${seed}`);
    const hit = this.sheets.get(url);
    if (hit) return hit;
    const ph = canvasFromPixels(placeholderSheet(seed, kind), SHEET_W, SHEET_H);
    this.sheets.set(url, ph);
    if (key && !this.pending.has(url)) {
      this.pending.add(url);
      void loadImage(url).then((img) => {
        if (img && img.width >= SHEET_W && img.height >= SHEET_H) this.sheets.set(url, img);
      });
    }
    return ph;
  }

  /**
   * Sheet for an animal (species, stage, and a seed that picks between variants such as bird and
   * bluebird). A procedural placeholder is returned until the PNG from animals/index.json loads.
   */
  animalSheet(
    species: AnimalSpecies,
    stage: AnimalStage | undefined,
    seed: number,
  ): { image: Drawable; info: AnimalSheetInfo } {
    const found = resolveEntry(this.animalIndex, species, stage, seed);
    if (found && this.animalIndex) {
      const url = assetUrl(found.entry.sprite);
      const img = this.images.get(url);
      if (img) {
        const ik = `${found.entry.key}@${found.scale}`;
        let info = this.infos.get(ik);
        if (!info) this.infos.set(ik, (info = sheetInfo(this.animalIndex, found.entry, found.scale)));
        return { image: img, info };
      }
      if (img === undefined) {
        this.images.set(url, null);
        void loadImage(url).then((loaded) => {
          if (loaded) this.images.set(url, loaded);
        });
      }
    }
    const young = stage === 'baby';
    const key = `${species}:${young ? 'y' : 'a'}`;
    let ph = this.placeholders.get(key);
    if (!ph) {
      const s = placeholderAnimalSheet(species, young);
      ph = { image: canvasFromPixels(s.px, s.w, s.h), info: s.info };
      this.placeholders.set(key, ph);
    }
    return ph;
  }

  /** Icon source rect by name (icons.json), or null when not available. */
  icon(name: string): { image: Drawable; sx: number; sy: number; size: number } | null {
    if (!this.icons) return null;
    const i = this.icons.meta.icons[name];
    if (i === undefined) return null;
    const { size, columns } = this.icons.meta;
    return { image: this.icons.image, sx: (i % columns) * size, sy: Math.floor(i / columns) * size, size };
  }

  /** Icon for a sprite reference like "ui/icons.json#flower". */
  iconRef(ref: string | undefined): ReturnType<Assets['icon']> {
    if (!ref) return null;
    const hash = ref.indexOf('#');
    return this.icon(hash >= 0 ? ref.slice(hash + 1) : ref);
  }
}
