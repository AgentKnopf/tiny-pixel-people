import type { InteriorTemplate, LocationId, Point, WorldMap } from '../../shared/types.ts';
import { containZoom } from './camera.ts';

/** Interior template of a location: its `interiorId`, else a template with the location's id. */
export function interiorFor(map: WorldMap, locationId: LocationId): InteriorTemplate | null {
  const list = map.interiors ?? [];
  const loc = map.locations.find((l) => l.id === locationId);
  const id = loc?.interiorId ?? (locationId === 'hotel' ? 'hotel_lobby' : locationId);
  return list.find((t) => t.id === id) ?? null;
}

export interface InteriorLayout {
  /** Device px per art px. */
  zoom: number;
  /** Device-px top-left of the interior's tile (0, 0). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The interior centred on screen, filling at most `share` of the viewport (crisp zoom when possible). */
export function interiorLayout(
  tpl: InteriorTemplate,
  tileSize: number,
  viewW: number,
  viewH: number,
  share = 0.7,
): InteriorLayout {
  const rw = tpl.width * tileSize;
  const rh = tpl.height * tileSize;
  const zoom = containZoom(rw, rh, viewW * share, viewH * share, 0.75);
  const w = Math.round(rw * zoom);
  const h = Math.round(rh * zoom);
  return { zoom, x: Math.round((viewW - w) / 2), y: Math.round((viewH - h) / 2), w, h };
}

/** Device px → interior art px, or null outside the interior. */
export function toInterior(layout: InteriorLayout, p: Point): Point | null {
  if (p.x < layout.x || p.y < layout.y || p.x >= layout.x + layout.w || p.y >= layout.y + layout.h)
    return null;
  return { x: (p.x - layout.x) / layout.zoom, y: (p.y - layout.y) / layout.zoom };
}

/**
 * Residents placed on the template's spots in id order (stable while they stay). Extra residents
 * stand in a row by the entry.
 */
export function residentSpots(tpl: InteriorTemplate, ids: string[]): Map<string, Point> {
  const out = new Map<string, Point>();
  const sorted = [...ids].sort();
  sorted.forEach((id, i) => {
    const spot = tpl.spots[i];
    if (spot) out.set(id, spot);
    else {
      const k = i - tpl.spots.length;
      const x = Math.min(
        tpl.width - 1,
        Math.max(0, tpl.entry.x + (k % 2 === 0 ? -(k / 2 + 1) : (k + 1) / 2)),
      );
      out.set(id, { x, y: tpl.entry.y });
    }
  });
  return out;
}

/**
 * Click rect (tiles) of each interior object: the bounding box of the template tiles named
 * `<id>_…` (a 2×2 cupboard spans x 11–12, y 1–2). Without tile names: the `pos` tile and the one
 * above it.
 */
export function objectRects(
  tpl: InteriorTemplate,
  names: Map<number, string>,
): Map<string, { x: number; y: number; w: number; h: number }> {
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const o of tpl.objects ?? []) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const layer of [tpl.layers.decor, tpl.layers.overhead, tpl.layers.ground]) {
      for (let i = 0; i < layer.length; i++) {
        const name = names.get(layer[i] ?? -1);
        if (!name?.startsWith(`${o.id}_`)) continue;
        const x = i % tpl.width;
        const y = Math.floor(i / tpl.width);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    out.set(
      o.id,
      x1 >= x0
        ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
        : { x: o.pos.x, y: o.pos.y - 1, w: 1, h: 2 },
    );
  }
  return out;
}

/** Clickable furniture under an interior tile. */
export function objectAt(
  tpl: InteriorTemplate,
  tile: Point,
  names: Map<number, string> = new Map(),
): string | null {
  for (const [id, r] of objectRects(tpl, names)) {
    if (tile.x >= r.x && tile.x < r.x + r.w && tile.y >= r.y && tile.y < r.y + r.h) return id;
  }
  return null;
}
export function interiorBlocked(tpl: InteriorTemplate, tile: Point): boolean {
  if (tile.x < 0 || tile.y < 0 || tile.x >= tpl.width || tile.y >= tpl.height) return true;
  return tpl.collision[tile.y * tpl.width + tile.x] === 1;
}
