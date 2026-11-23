import type { Point, Rect } from '../../shared/types.ts';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 12;

/**
 * Largest integer zoom (device px per art px) that shows `rw`×`rh` art px in a `vw`×`vh` viewport.
 * Rounds up instead when that still shows at least `minVisible` of the rect on both axes, which
 * matches the reference overview: the whole town at 2× with the edges cropped.
 */
export function fitZoom(rw: number, rh: number, vw: number, vh: number, minVisible = 0.6): number {
  if (rw <= 0 || rh <= 0 || vw <= 0 || vh <= 0) return MIN_ZOOM;
  const ratio = Math.min(vw / rw, vh / rh);
  const lo = Math.floor(ratio);
  const hi = Math.ceil(ratio);
  let z = lo;
  if (hi !== lo && vw / (rw * hi) >= minVisible && vh / (rh * hi) >= minVisible) z = hi;
  return clampZoom(z);
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z)));
}

/**
 * Orthographic camera over the world in art pixels. `zoom` is an integer number of device pixels
 * per art pixel and the view offset is snapped to whole art pixels, so tiles stay crisp.
 */
export class Camera {
  /** Current centre (art px). */
  x = 0;
  y = 0;
  /** Target centre the camera eases to. */
  tx = 0;
  ty = 0;
  zoom = 2;
  viewW = 1;
  viewH = 1;
  worldW = 1;
  worldH = 1;
  /** Rect (art px) the camera keeps framed on resize until the user pans or zooms. */
  follow: Rect | null = null;

  setWorld(w: number, h: number): void {
    this.worldW = w;
    this.worldH = h;
  }

  setViewport(w: number, h: number): void {
    const changed = w !== this.viewW || h !== this.viewH;
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    if (changed && this.follow) this.frame(this.follow, true);
  }

  /** Frame an art-px rect at its fit zoom; eases unless `instant`. */
  frame(rect: Rect, instant = false): void {
    this.follow = rect;
    this.zoom = fitZoom(rect.w, rect.h, this.viewW, this.viewH);
    this.tx = rect.x + rect.w / 2;
    this.ty = rect.y + rect.h / 2;
    this.clampTarget();
    if (instant) {
      this.x = this.tx;
      this.y = this.ty;
    }
  }

  centerOn(p: Point, instant = false): void {
    this.follow = null;
    this.tx = p.x;
    this.ty = p.y;
    this.clampTarget();
    if (instant) {
      this.x = this.tx;
      this.y = this.ty;
    }
  }

  /** Change zoom by `delta` steps, keeping the art point under `anchor` (device px) in place. */
  zoomBy(delta: number, anchor?: Point): void {
    const next = clampZoom(this.zoom + delta);
    if (next === this.zoom) return;
    this.follow = null;
    const a = anchor ?? { x: this.viewW / 2, y: this.viewH / 2 };
    const before = this.screenToWorld(a);
    this.zoom = next;
    const dx = (a.x - this.viewW / 2) / next;
    const dy = (a.y - this.viewH / 2) / next;
    this.x = this.tx = before.x - dx;
    this.y = this.ty = before.y - dy;
    this.clampTarget();
    this.x = this.tx;
    this.y = this.ty;
  }

  /** Pan by a device-pixel drag delta. */
  panBy(dx: number, dy: number): void {
    this.follow = null;
    this.tx -= dx / this.zoom;
    this.ty -= dy / this.zoom;
    this.clampTarget();
    this.x = this.tx;
    this.y = this.ty;
  }

  /** Ease toward the target; returns true while still moving. */
  update(dtMs: number): boolean {
    const k = 1 - Math.exp(-Math.max(0, dtMs) / 140);
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
    if (Math.abs(this.tx - this.x) < 0.25 && Math.abs(this.ty - this.y) < 0.25) {
      this.x = this.tx;
      this.y = this.ty;
      return false;
    }
    return true;
  }

  private clampTarget(): void {
    const halfW = this.viewW / 2 / this.zoom;
    const halfH = this.viewH / 2 / this.zoom;
    this.tx = this.worldW <= halfW * 2 ? this.worldW / 2 : clamp(this.tx, halfW, this.worldW - halfW);
    this.ty = this.worldH <= halfH * 2 ? this.worldH / 2 : clamp(this.ty, halfH, this.worldH - halfH);
  }

  /** Device-pixel translation for drawing, snapped to whole art pixels. */
  get offsetX(): number {
    return Math.round(this.viewW / 2) - Math.round(this.x) * this.zoom;
  }

  get offsetY(): number {
    return Math.round(this.viewH / 2) - Math.round(this.y) * this.zoom;
  }

  worldToScreen(p: Point): Point {
    return { x: p.x * this.zoom + this.offsetX, y: p.y * this.zoom + this.offsetY };
  }

  screenToWorld(p: Point): Point {
    return { x: (p.x - this.offsetX) / this.zoom, y: (p.y - this.offsetY) / this.zoom };
  }

  /** Visible world rect in art px. */
  visibleRect(): Rect {
    const tl = this.screenToWorld({ x: 0, y: 0 });
    return { x: tl.x, y: tl.y, w: this.viewW / this.zoom, h: this.viewH / this.zoom };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
