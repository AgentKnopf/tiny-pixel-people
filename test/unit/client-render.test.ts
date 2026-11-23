import { describe, expect, it } from 'vitest';
import { createPlaceholderMap } from '../../src/server/sim/placeholder.ts';
import { bubbleAlpha, layoutBubbles, wrapText } from '../../src/client/render/bubbles.ts';
import { Camera, containZoom, fitZoom } from '../../src/client/render/camera.ts';
import { eventEmoji, isFestive } from '../../src/client/render/effects.ts';
import { doorHitBox, hitTest } from '../../src/client/render/hit.ts';
import { nightFactor, tintColor, useLitTiles } from '../../src/client/render/lighting.ts';
import { findScene, listScenes, sceneRectPx } from '../../src/client/render/scenes.ts';
import {
  FRAME_H,
  FRAME_W,
  SHEET_H,
  SHEET_W,
  feetPoint,
  pickFrame,
  placeholderSheet,
  spriteTopLeft,
  spriteUrl,
} from '../../src/client/render/sprites.ts';
import { tileSource } from '../../src/client/render/tiles.ts';
import type { LoadedTileset } from '../../src/client/render/assets.ts';
import type { VillageEvent } from '../../src/shared/types.ts';

describe('camera', () => {
  it('fits the 48×30 town at 2× in the reference 1440×754 viewport, cropping the edges', () => {
    expect(fitZoom(768, 480, 1440, 754)).toBe(2);
    // Retina: twice the device pixels → twice the zoom.
    expect(fitZoom(768, 480, 2880, 1508)).toBe(4);
    // Too small to round up.
    expect(fitZoom(768, 480, 1000, 500)).toBe(1);
    // Home scene (16×12 tiles) zooms in to 4×, like reference frame 03.
    expect(fitZoom(256, 192, 1440, 754)).toBe(4);
    expect(fitZoom(0, 10, 100, 100)).toBe(1);
  });

  it('shows the whole 48×30 town in the overview, at an integer zoom when it nearly fills', () => {
    expect(containZoom(768, 480, 1440, 800)).toBeCloseTo(800 / 480);
    expect(containZoom(768, 480, 1440, 754)).toBeCloseTo(754 / 480);
    // Retina 1440×800: 3× uses 90% of the height, so stay crisp.
    expect(containZoom(768, 480, 2880, 1600)).toBe(3);
    expect(containZoom(768, 480, 1536, 960)).toBe(2);
    // Smaller than the town: shrink below 1× rather than crop.
    expect(containZoom(768, 480, 640, 400)).toBeCloseTo(400 / 480);
  });

  it('frames the whole town with contain and steps to integer zooms from there', () => {
    const c = new Camera();
    c.setWorld(768, 480);
    for (const [w, h] of <[number, number][]>[
      [1440, 800],
      [1440, 754],
      [2880, 1600],
      [1024, 768],
    ]) {
      c.setViewport(w, h);
      c.frame({ x: 0, y: 0, w: 768, h: 480 }, true, true);
      const tl = c.screenToWorld({ x: 0, y: 0 });
      const br = c.screenToWorld({ x: w, y: h });
      expect(tl.x).toBeLessThanOrEqual(0.5);
      expect(tl.y).toBeLessThanOrEqual(0.5);
      expect(br.x).toBeGreaterThanOrEqual(767.5);
      expect(br.y).toBeGreaterThanOrEqual(479.5);
      expect(Number.isInteger(c.offsetX) && Number.isInteger(c.offsetY)).toBe(true);
    }
    c.setViewport(1440, 800);
    c.frame({ x: 0, y: 0, w: 768, h: 480 }, true, true);
    // Resizing keeps the whole town in view.
    c.setViewport(1440, 754);
    expect(c.zoom).toBeCloseTo(754 / 480);
    c.zoomBy(1);
    expect(c.zoom).toBe(2);
    c.frame({ x: 0, y: 0, w: 768, h: 480 }, true, true);
    c.zoomBy(-1);
    expect(c.zoom).toBe(1);
  });

  it('frames rects, clamps to the world and snaps offsets to whole art pixels', () => {
    const c = new Camera();
    c.setWorld(768, 480);
    c.setViewport(1440, 754);
    c.frame({ x: 0, y: 288, w: 256, h: 192 }, true);
    expect(c.zoom).toBe(4);
    // Clamped so the left edge of the map is at the left of the screen.
    expect(c.screenToWorld({ x: 0, y: 0 }).x).toBeCloseTo(0, 0);
    expect(c.visibleRect().y + c.visibleRect().h).toBeLessThanOrEqual(480 + 1);
    c.panBy(3, 7);
    expect(c.follow).toBeNull();
    expect(c.offsetX % c.zoom).toBe(Math.round(c.viewW / 2) % c.zoom);
    expect(Number.isInteger(c.offsetX) && Number.isInteger(c.offsetY)).toBe(true);
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const c = new Camera();
    c.setWorld(768, 480);
    c.setViewport(1440, 754);
    c.frame({ x: 0, y: 0, w: 768, h: 480 }, true);
    const anchor = { x: 700, y: 400 };
    const before = c.screenToWorld(anchor);
    c.zoomBy(1, anchor);
    expect(c.zoom).toBe(3);
    const after = c.screenToWorld(anchor);
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  });

  it('eases toward the target and re-frames the followed rect on resize', () => {
    const c = new Camera();
    c.setWorld(768, 480);
    c.setViewport(1440, 754);
    c.frame({ x: 0, y: 0, w: 768, h: 480 }, true);
    c.frame({ x: 0, y: 288, w: 256, h: 192 });
    expect(c.update(16)).toBe(true);
    for (let i = 0; i < 200; i++) c.update(16);
    expect(c.x).toBe(c.tx);
    c.setViewport(2880, 1508);
    expect(c.zoom).toBe(8);
  });

  it('round-trips screen and world coordinates', () => {
    const c = new Camera();
    c.setWorld(768, 480);
    c.setViewport(1000, 700);
    c.frame({ x: 100, y: 100, w: 300, h: 200 }, true);
    const w = { x: 250, y: 180 };
    const s = c.worldToScreen(w);
    expect(c.screenToWorld(s)).toEqual(w);
  });
});

describe('day/night lighting', () => {
  it('is day from 07:00 to 18:00, night from 20:00 to 05:00, and fades in between', () => {
    expect(nightFactor(12 * 60)).toBe(0);
    expect(nightFactor(7 * 60)).toBe(0);
    expect(nightFactor(22 * 60)).toBe(1);
    expect(nightFactor(3 * 60)).toBe(1);
    expect(nightFactor(19 * 60)).toBeCloseTo(0.5);
    expect(nightFactor(6 * 60)).toBeCloseTo(0.5);
    expect(nightFactor(18.5 * 60)).toBeLessThan(nightFactor(19.5 * 60));
    // Absolute game minutes on later days.
    expect(nightFactor(3 * 1440 + 22 * 60)).toBe(1);
  });

  it('tints toward the night multiply colour and swaps lit tiles past half-night', () => {
    expect(tintColor(0, false)).toEqual([255, 255, 255]);
    expect(tintColor(1, false)).toEqual([107, 128, 148]);
    expect(tintColor(0, true)[0]).toBeLessThan(255);
    expect(useLitTiles(0.4)).toBe(false);
    expect(useLitTiles(0.6)).toBe(true);
  });
});

describe('speech bubbles', () => {
  const measure = (s: string) => s.length * 6;

  it('wraps to two lines and ellipsizes the rest', () => {
    expect(wrapText('Hello there', 120, measure)).toEqual(['Hello there']);
    const lines = wrapText(
      'Did you hear? The mayor cat is named Biscuit and it is very fluffy indeed',
      120,
      measure,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(120);
    expect(
      wrapText('Supercalifragilisticexpialidocious', 60, measure, 2).every((l) => measure(l) <= 60),
    ).toBe(true);
    expect(wrapText('   ', 60, measure)).toEqual([]);
  });

  it('nudges overlapping bubbles apart and keeps them on screen', () => {
    const boxes = [
      { id: 'a', ax: 100, ay: 200, w: 80, h: 30 },
      { id: 'b', ax: 110, ay: 205, w: 80, h: 30 },
      { id: 'c', ax: 5, ay: 10, w: 80, h: 30 },
    ];
    const placed = layoutBubbles(boxes, { w: 800, h: 600 }, 6);
    const a = placed.find((p) => p.id === 'a')!;
    const b = placed.find((p) => p.id === 'b')!;
    const c = placed.find((p) => p.id === 'c')!;
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    expect(overlap).toBe(false);
    expect(c.x).toBeGreaterThanOrEqual(4);
    expect(c.y).toBeGreaterThanOrEqual(4);
  });

  it('fades over the last 300 ms', () => {
    expect(bubbleAlpha(0, 5000)).toBe(1);
    expect(bubbleAlpha(4850, 5000)).toBeCloseTo(0.5);
    expect(bubbleAlpha(5000, 5000)).toBe(0);
  });
});

describe('sprites', () => {
  it('anchors a villager on tile (tx, ty) at (tx*16, ty*16 - 8) per the art README', () => {
    expect(spriteTopLeft({ x: 3, y: 5 }, 16)).toEqual({ x: 48, y: 72 });
    expect(feetPoint({ x: 3, y: 5 }, 16)).toEqual({ x: 56, y: 94 });
  });

  it('walks at 8 fps and bobs when idle', () => {
    expect(pickFrame('left', true, 0).row).toBe(1);
    expect([0, 125, 250, 375].map((t) => pickFrame('down', true, t).col)).toEqual([0, 1, 2, 3]);
    expect(pickFrame('up', false, 0)).toEqual({ col: 0, row: 3, bob: 0 });
    expect(pickFrame('up', false, 600).bob).toBe(-1);
    expect(pickFrame('up', false, 600, 0, true).bob).toBe(0);
  });

  it('resolves sprite keys to asset URLs', () => {
    expect(spriteUrl('villager-01')).toBe('/characters/villager-01.png');
    expect(spriteUrl('characters/ada.png')).toBe('/characters/ada.png');
    expect(spriteUrl('assets/characters/ada.png')).toBe('/characters/ada.png');
    expect(spriteUrl('characters/ada')).toBe('/characters/ada.png');
  });

  it('draws deterministic placeholder sheets with every frame filled', () => {
    for (const kind of ['villager', 'player', 'stranger', 'pet'] as const) {
      const px = placeholderSheet('ada', kind);
      expect(px.length).toBe(SHEET_W * SHEET_H * 4);
      expect(placeholderSheet('ada', kind)).toEqual(px);
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          let opaque = 0;
          for (let y = 0; y < FRAME_H; y++) {
            for (let x = 0; x < FRAME_W; x++) {
              if (px[((row * FRAME_H + y) * SHEET_W + col * FRAME_W + x) * 4 + 3]! > 0) opaque++;
            }
          }
          expect(opaque).toBeGreaterThan(30);
        }
      }
    }
    expect(placeholderSheet('ada')).not.toEqual(placeholderSheet('bo'));
  });
});

describe('hit testing', () => {
  const map = createPlaceholderMap();
  // player_home door is at tile (4, 26).

  it('prefers villagers, then doors, then ground', () => {
    const v = [{ id: 'ada', pos: { x: 10, y: 10 } }];
    expect(hitTest(map, { x: 10 * 16 + 8, y: 10 * 16 + 4 }, v, null)).toEqual({
      kind: 'villager',
      id: 'ada',
    });
    expect(hitTest(map, { x: 4 * 16 + 8, y: 26 * 16 + 8 }, v, null)).toEqual({
      kind: 'door',
      houseId: 'player_home',
    });
    // The tile above the door counts too (the door sprite is two tiles tall).
    expect(hitTest(map, { x: 4 * 16 + 8, y: 25 * 16 + 8 }, v, null)).toEqual({
      kind: 'door',
      houseId: 'player_home',
    });
    expect(hitTest(map, { x: 20 * 16 + 1, y: 5 * 16 + 1 }, v, null)).toEqual({
      kind: 'ground',
      tile: { x: 20, y: 5 },
      blocked: false,
    });
    expect(hitTest(map, { x: 1, y: 1 }, v, null)).toEqual({
      kind: 'ground',
      tile: { x: 0, y: 0 },
      blocked: true,
    });
    expect(hitTest(map, { x: -5, y: 1 }, v, null)).toEqual({ kind: 'none' });
    expect(
      hitTest(map, { x: 20 * 16 + 8, y: 20 * 16 + 4 }, [], { id: 'player', pos: { x: 20, y: 20 } }),
    ).toEqual({ kind: 'player' });
  });

  it('picks the front-most villager when sprites overlap', () => {
    const v = [
      { id: 'back', pos: { x: 10, y: 10 } },
      { id: 'front', pos: { x: 10, y: 10.5 } },
    ];
    expect(hitTest(map, { x: 168, y: 170 }, v, null)).toEqual({ kind: 'villager', id: 'front' });
  });

  it('door boxes cover the door tile and the one above', () => {
    expect(doorHitBox({ x: 4, y: 26 })).toEqual({ x: 4, y: 25, w: 1, h: 2 });
  });
});

describe('scenes', () => {
  it('falls back to the whole map and derives home from player_home', () => {
    const map = createPlaceholderMap();
    expect(findScene(map, 'home')?.rect).toEqual({ x: 0, y: 20, w: 12, h: 10 });
    const bare = { ...map, scenes: [] };
    expect(listScenes(bare).map((s) => s.id)).toEqual(['plaza']);
    expect(findScene(bare, 'plaza')?.rect).toEqual({ x: 0, y: 0, w: 40, h: 30 });
    const home = findScene(bare, 'home')!;
    expect(home.rect.x).toBeGreaterThanOrEqual(0);
    expect(home.rect.y + home.rect.h).toBeLessThanOrEqual(30);
    expect(findScene(bare, 'nowhere')).toBeNull();
    expect(sceneRectPx(home, 16).w).toBe(home.rect.w * 16);
  });
});

describe('tiles', () => {
  it('maps global indices into tilesets and swaps lit variants', () => {
    const image = {} as HTMLCanvasElement;
    const sets: LoadedTileset[] = [
      {
        ref: { image: 'a.png', tileSize: 16, columns: 16, firstIndex: 0 },
        image,
        meta: { image: 'a.png', tileSize: 16, columns: 16, tiles: {}, lit: { '17': 18 }, objects: {} },
      },
      { ref: { image: 'b.png', tileSize: 16, columns: 4, firstIndex: 1000 }, image, meta: null },
    ];
    expect(tileSource(sets, -1, false)).toBeNull();
    expect(tileSource(sets, 17, false)).toMatchObject({ sx: 16, sy: 16 });
    expect(tileSource(sets, 17, true)).toMatchObject({ sx: 32, sy: 16 });
    expect(tileSource(sets, 1005, false)).toMatchObject({ sx: 16, sy: 16, ts: sets[1] });
  });
});

describe('event effects', () => {
  const ev = (title: string): VillageEvent => ({
    id: 'e1',
    title,
    description: '',
    hostId: 'a',
    locationId: 'square',
    start: 0,
    end: 1,
    invitees: [],
    accepted: [],
    declined: [],
    attendees: [],
    status: 'happening',
  });
  it('picks a marker emoji and confetti for festive events', () => {
    expect(eventEmoji(ev('Bake-off'))).toBe('🍰');
    expect(eventEmoji(ev("Mia's birthday"))).toBe('🎂');
    expect(eventEmoji(ev('Gathering'))).toBe('🎪');
    expect(isFestive(ev('Party at the plaza'), [])).toBe(true);
    expect(
      isFestive(ev('Town meeting'), [
        { id: 'w', kind: 'party', startedAt: 0, endsAt: null, data: { villageEventId: 'e1' } },
      ]),
    ).toBe(true);
    expect(isFestive(ev('Town meeting'), [])).toBe(false);
  });
});
