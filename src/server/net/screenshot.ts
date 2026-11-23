import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { encodePng } from '../../../scripts/art/png.ts';
import type { Facing, Point, WorldMap } from '../../shared/types.ts';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Decodes 8-bit RGB/RGBA non-interlaced PNGs (what scripts/art writes). */
export function decodePng(buf: Uint8Array): RgbaImage {
  const b = Buffer.from(buf);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colorType = data[9]!;
      if (depth !== 8 || (colorType !== 6 && colorType !== 2) || data[12] !== 0)
        throw new Error(`unsupported PNG format (depth ${depth}, color type ${colorType})`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= bpp ? px[row + x - bpp]! : 0;
      const up = y > 0 ? px[row - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? px[row - stride + x - bpp]! : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = v;
          break;
        case 1:
          out = v + a;
          break;
        case 2:
          out = v + up;
          break;
        case 3:
          out = v + ((a + up) >> 1);
          break;
        case 4: {
          const p = a + up - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - c);
          out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      px[row + x] = out & 0xff;
    }
  }
  if (bpp === 4) return { width, height, data: px };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    data[j] = px[i]!;
    data[j + 1] = px[i + 1]!;
    data[j + 2] = px[i + 2]!;
    data[j + 3] = 255;
  }
  return { width, height, data };
}

/** Source-over blit of a `w`×`h` region of `src` at (sx, sy) to `dst` at (dx, dy). */
function blit(
  dst: RgbaImage,
  src: RgbaImage,
  sx: number,
  sy: number,
  w: number,
  h: number,
  dx: number,
  dy: number,
) {
  for (let y = 0; y < h; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height || sy + y >= src.height) continue;
    for (let x = 0; x < w; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width || sx + x >= src.width) continue;
      const si = ((sy + y) * src.width + sx + x) * 4;
      const alpha = src.data[si + 3]!;
      if (alpha === 0) continue;
      const di = (ty * dst.width + tx) * 4;
      if (alpha === 255) {
        dst.data[di] = src.data[si]!;
        dst.data[di + 1] = src.data[si + 1]!;
        dst.data[di + 2] = src.data[si + 2]!;
        dst.data[di + 3] = 255;
        continue;
      }
      const t = alpha / 255;
      for (let k = 0; k < 3; k++)
        dst.data[di + k] = Math.round(src.data[si + k]! * t + dst.data[di + k]! * (1 - t));
      dst.data[di + 3] = Math.max(dst.data[di + 3]!, alpha);
    }
  }
}

export interface ScreenshotFigure {
  pos: Point;
  facing: Facing;
  /** Sprite key as in villagers.json ("characters/villager-01.png", "villager-01"). */
  sprite: string;
}

const FRAME_W = 16;
const FRAME_H = 24;
const ROW: Record<Facing, number> = { down: 0, left: 1, right: 2, up: 3 };

/**
 * Server-side map picture: tile layers from the tileset PNGs, characters (idle frame) y-sorted,
 * then the overhead layer. No lighting, bubbles or UI.
 */
export class ScreenshotRenderer {
  private readonly root: string;
  private readonly images = new Map<string, RgbaImage | null>();
  private base: RgbaImage | null = null;
  private overhead: RgbaImage | null = null;

  constructor(
    private readonly map: WorldMap,
    assetsDir = 'assets',
  ) {
    this.root = resolve(assetsDir);
  }

  /** Throws when the tileset images are missing. */
  render(figures: ScreenshotFigure[], scale = 1): Buffer {
    this.prepare();
    const img: RgbaImage = { ...this.base!, data: new Uint8Array(this.base!.data) };
    const sorted = [...figures].sort((a, b) => a.pos.y - b.pos.y);
    const ts = this.map.tileSize;
    for (const f of sorted) {
      const sheet = this.image(spritePath(f.sprite));
      if (!sheet) continue;
      const dx = Math.round(f.pos.x * ts);
      const dy = Math.round(f.pos.y * ts) - (FRAME_H - ts);
      blit(img, sheet, 0, ROW[f.facing] * FRAME_H, FRAME_W, FRAME_H, dx, dy);
    }
    blit(img, this.overhead!, 0, 0, img.width, img.height, 0, 0);
    const out = scale > 1 ? upscale(img, scale) : img;
    return encodePng(out.width, out.height, out.data);
  }

  private prepare(): void {
    if (this.base) return;
    const { width, height, tileSize } = this.map;
    const make = (): RgbaImage => ({
      width: width * tileSize,
      height: height * tileSize,
      data: new Uint8Array(width * height * tileSize * tileSize * 4),
    });
    const base = make();
    const overhead = make();
    const sets = this.map.tilesets.map((t) => {
      const image = this.image(t.image);
      if (!image) throw new Error(`tileset ${t.image} not found in ${this.root}`);
      return { ...t, image, count: t.columns * Math.floor(image.height / t.tileSize) };
    });
    const draw = (dst: RgbaImage, layer: number[]) => {
      for (let i = 0; i < layer.length; i++) {
        const t = layer[i]!;
        if (t < 0) continue;
        const set = sets.find((s) => t >= s.firstIndex && t < s.firstIndex + s.count);
        if (!set) continue;
        const local = t - set.firstIndex;
        blit(
          dst,
          set.image,
          (local % set.columns) * set.tileSize,
          Math.floor(local / set.columns) * set.tileSize,
          set.tileSize,
          set.tileSize,
          (i % width) * tileSize,
          Math.floor(i / width) * tileSize,
        );
      }
    };
    draw(base, this.map.layers.ground);
    draw(base, this.map.layers.decor);
    draw(overhead, this.map.layers.overhead);
    this.base = base;
    this.overhead = overhead;
  }

  private image(key: string): RgbaImage | null {
    if (this.images.has(key)) return this.images.get(key)!;
    const path = join(this.root, normalize(key).replace(/^([/\\]|\.\.)+/, ''));
    let img: RgbaImage | null = null;
    if (path.startsWith(this.root) && existsSync(path)) {
      try {
        img = decodePng(readFileSync(path));
      } catch {
        img = null;
      }
    }
    this.images.set(key, img);
    return img;
  }
}

function spritePath(key: string): string {
  const k = key.replace(/^\/+/, '').replace(/^assets\//, '');
  if (k.endsWith('.png')) return k;
  if (k.includes('/')) return `${k}.png`;
  return `characters/${k}.png`;
}

function upscale(src: RgbaImage, s: number): RgbaImage {
  const w = src.width * s;
  const h = src.height * s;
  const data = new Uint8Array(w * h * 4);
  const view = new Uint32Array(data.buffer);
  const from = new Uint32Array(src.data.buffer, src.data.byteOffset, src.width * src.height);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / s) * src.width;
    for (let x = 0; x < w; x++) view[y * w + x] = from[sy + Math.floor(x / s)]!;
  }
  return { width: w, height: h, data };
}
