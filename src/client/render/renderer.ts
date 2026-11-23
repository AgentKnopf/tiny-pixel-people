import {
  PLAYER_HOME_ID,
  PLAYER_ID,
  type AnimalId,
  type Facing,
  type InteriorTemplate,
  type Location,
  type LocationId,
  type Point,
  type VillagerId,
  type WorldMap,
} from '../../shared/types.ts';
import { entityPos, isMoving, type AnimalView, type Entity, type GameStore } from '../state.ts';
import {
  FLY_LIFT,
  animalHitBox,
  animalTopLeft,
  animationFor,
  isAerial,
  pickAnimalColumn,
  type AnimalSheetInfo,
} from './animals.ts';
import { Assets, type Drawable, type LightSpot, type TileObject, type LoadedTileset } from './assets.ts';
import { layoutBubbles, bubbleAlpha, wrapText } from './bubbles.ts';
import { Camera, fitZoom } from './camera.ts';
import { drawConfetti, drawRain, eventEmoji, isFestive } from './effects.ts';
import { hitTest, spriteHitBox, type HitResult } from './hit.ts';
import {
  interiorBlocked,
  interiorFor,
  interiorLayout,
  objectAt,
  objectRects,
  residentSpots,
  toInterior,
  type InteriorLayout,
} from './interior.ts';
import { nightFactor, tintColor, useLitTiles } from './lighting.ts';
import { DEFAULT_SCENE_ID, OVERVIEW_SCENE_ID, findScene, sceneRectPx } from './scenes.ts';
import {
  FRAME_H,
  FRAME_W,
  feetPoint,
  hashString,
  pickFrame,
  spriteTopLeft,
  type PlaceholderKind,
} from './sprites.ts';
import {
  CAR_TILES,
  TRAIN_CARS,
  coasterCars,
  rideFrame,
  ridingIds,
  traceLoop,
  trackMasks,
  trainPose,
  type VehicleSheet,
} from './rides.ts';
import { TileLayers, tileSource } from './tiles.ts';

export const WORLD_FONT = '"Departure Mono", ui-monospace, Menlo, Consolas, monospace';
const BG = '#85aa4e';
const OUTLINE = '#272618';
const BUBBLE_FILL = '#fffaea';
const TAG_FILL = '#3c2b17';
const TAG_TEXT = '#fbf0d9';
const ACCENT = '#f2c94c';
/** Real ms for a full click (no drag) and the drag threshold in CSS px. */
const DRAG_THRESHOLD = 5;

export interface RendererEvents {
  villager: VillagerId;
  animal: AnimalId;
  /** `canEnter`: the location has an interior (houses, hotel, post office). */
  door: { houseId: LocationId; canEnter: boolean };
  /** Clickable interior furniture, e.g. `keep_cupboard` in the post office. */
  object: { id: string; locationId: LocationId };
  noticeBoard: null;
  ground: { tile: Point; blocked: boolean };
  player: null;
  scene: string;
  /** The user dragged or wheel-zoomed away from the current scene. */
  userPan: null;
}

type Handler<K extends keyof RendererEvents> = (payload: RendererEvents[K]) => void;

interface Drawn {
  id: string;
  pos: Point;
  entity: Entity;
  name: string;
  sheet: Drawable;
  kind: PlaceholderKind;
  hidden: boolean;
}

interface DrawnAnimal {
  id: AnimalId;
  view: AnimalView;
  pos: Point;
  image: Drawable;
  info: AnimalSheetInfo;
  aerial: boolean;
  lift: number;
}

export interface RendererOptions {
  assets?: Assets;
  /** Defaults to window.devicePixelRatio. */
  dpr?: () => number;
}

/**
 * Canvas world renderer: tiles, characters, bubbles, name tags, day/night, effects, camera and
 * pointer input. Reads everything from the `GameStore`; emits clicks through `on()`.
 */
export class WorldRenderer {
  readonly camera = new Camera();
  readonly assets: Assets;
  sceneId: string = DEFAULT_SCENE_ID;
  /** Villager (or player) the camera keeps centred on, until the user pans or picks a scene. */
  followId: string | null = null;
  private ctx: CanvasRenderingContext2D;
  private layers: TileLayers | null = null;
  private loops: Map<LocationId, Point[]> | null = null;
  private insideGlide: Glide | null = null;
  private loopsFor: TileLayers | null = null;
  private map: WorldMap | null = null;
  private tilesetsFor: WorldMap | null = null;
  private raf = 0;
  private last = 0;
  private handlers = new Map<keyof RendererEvents, Set<(payload: unknown) => void>>();
  private pointer: {
    id: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null = null;
  private hover: HitResult = { kind: 'none' };
  private ro: ResizeObserver | null = null;
  private cleanup: (() => void)[] = [];
  private dpr: () => number;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly store: GameStore,
    opts: RendererOptions = {},
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.assets = opts.assets ?? new Assets(() => this.invalidateLayers());
    this.dpr = opts.dpr ?? (() => window.devicePixelRatio || 1);
    void this.assets.loadCommon();
    this.bindInput();
  }

  on<K extends keyof RendererEvents>(event: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    const h = fn as (payload: unknown) => void;
    set.add(h);
    return () => set.delete(h);
  }

  private emit<K extends keyof RendererEvents>(event: K, payload: RendererEvents[K]): void {
    for (const fn of this.handlers.get(event) ?? []) fn(payload);
  }

  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro?.disconnect();
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
  }

  // ---------- Camera API (used by the toolbar, dock and Map modal) ----------

  showScene(id: string, instant = false): boolean {
    const map = this.store.map;
    if (!map) {
      this.sceneId = id;
      return false;
    }
    const scene = findScene(map, id);
    if (!scene) return false;
    this.followId = null;
    this.sceneId = scene.id;
    const rect = sceneRectPx(scene, map.tileSize);
    const wholeMap = rect.w >= map.width * map.tileSize && rect.h >= map.height * map.tileSize;
    // Overviews show their whole rect (fractional zoom allowed); close-up scenes may crop edges.
    const contain = wholeMap || scene.id === DEFAULT_SCENE_ID || scene.id === OVERVIEW_SCENE_ID;
    this.camera.frame(rect, instant, contain);
    this.emit('scene', scene.id);
    return true;
  }

  zoomIn(): void {
    this.camera.zoomBy(1);
  }

  zoomOut(): void {
    this.camera.zoomBy(-1);
  }

  /** Frame the whole map (the toolbar's fit button): the `overview` scene, or the plaza on v1 maps. */
  fit(): void {
    const map = this.store.map;
    const hasOverview = !!map?.scenes.some((s) => s.id === OVERVIEW_SCENE_ID);
    this.showScene(hasOverview ? OVERVIEW_SCENE_ID : DEFAULT_SCENE_ID);
  }

  /** Pan to a villager (or the player) and keep following it; false when it is unknown. */
  followVillager(id: VillagerId): boolean {
    const map = this.store.map;
    if (!map || !this.store.positionOf(id, performance.now())) return false;
    this.followId = id;
    this.ensureCloseZoom(map);
    this.trackFollow(performance.now(), map);
    return true;
  }

  /** Pan to a tile. */
  focusTile(tile: Point): void {
    const map = this.store.map;
    if (!map) return;
    this.followId = null;
    this.ensureCloseZoom(map);
    this.camera.centerOn({ x: (tile.x + 0.5) * map.tileSize, y: (tile.y + 0.5) * map.tileSize });
  }

  /** Close-ups use at least the zoom of a ~20×12 tile scene. */
  private ensureCloseZoom(map: WorldMap): void {
    const target = fitZoom(20 * map.tileSize, 12 * map.tileSize, this.camera.viewW, this.camera.viewH);
    if (this.camera.zoom < target) this.camera.zoomTo(target);
  }

  private trackFollow(now: number, map: WorldMap): void {
    if (!this.followId) return;
    const p = this.store.positionOf(this.followId, now);
    if (!p) {
      this.followId = null;
      return;
    }
    const feet = feetPoint(p, map.tileSize);
    this.camera.centerOn({ x: feet.x, y: feet.y - 8 });
  }

  private userMovedCamera(): void {
    this.followId = null;
    this.emit('userPan', null);
  }

  /** What is under a client (CSS px) point. */
  hitAt(clientX: number, clientY: number): HitResult {
    const map = this.store.map;
    if (!map) return { kind: 'none' };
    const r = this.canvas.getBoundingClientRect();
    const scale = this.canvas.width / Math.max(1, r.width);
    const device = { x: (clientX - r.left) * scale, y: (clientY - r.top) * scale };
    const interior = this.interiorView(map);
    if (interior) return this.interiorHit(map, interior, device);
    const world = this.camera.screenToWorld(device);
    const now = performance.now();
    const villagers = this.collect(now, map)
      .filter((d) => !d.hidden && d.kind !== 'pet' && d.id !== PLAYER_ID)
      .map((d) => ({ id: d.id, pos: d.pos }));
    const animals = this.collectAnimals(now, map, null).map((a) => ({
      id: a.id,
      box: animalHitBox(a.pos, map.tileSize, a.info, a.lift),
      y: a.pos.y + (a.aerial ? 1000 : 0),
    }));
    const pe = this.store.playerEntity;
    const riding = ridingIds(this.store.rides.values()).has(PLAYER_ID);
    return hitTest(
      map,
      world,
      villagers,
      pe && !riding ? { id: PLAYER_ID, pos: entityPos(pe, now) } : null,
      animals,
    );
  }

  /** Whether the player can walk into a location (it has an interior). */
  canEnter(locationId: LocationId): boolean {
    const loc = this.store.map?.locations.find((l) => l.id === locationId);
    if (!loc) return false;
    if (loc.interiorId) return true;
    return (loc.id === 'hotel' || loc.id === 'post_office') && !!this.store.map?.interiors?.length;
  }

  // ---------- Frame ----------

  private invalidateLayers(): void {
    this.layers = null;
  }

  private syncMap(): WorldMap | null {
    const map = this.store.map;
    if (!map) return null;
    if (map !== this.map) {
      const first = this.map === null;
      this.map = map;
      this.layers = null;
      this.camera.setWorld(map.width * map.tileSize, map.height * map.tileSize);
      if (!findScene(map, this.sceneId)) this.sceneId = DEFAULT_SCENE_ID;
      this.showScene(this.sceneId, first);
    }
    if (this.tilesetsFor !== map) {
      this.tilesetsFor = map;
      if (map.tilesets.length > 0) void this.assets.loadTilesets(map.tilesets);
    }
    if (!this.layers) this.layers = new TileLayers(map, this.assets.tilesets);
    return map;
  }

  private resize(): void {
    const dpr = this.dpr();
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.camera.setViewport(w, h);
  }

  frame(now: number): void {
    const dt = Math.min(100, now - this.last);
    this.last = now;
    this.resize();
    const map = this.syncMap();
    if (map) this.trackFollow(now, map);
    this.camera.update(dt);
    this.draw(now, map);
  }

  private collect(now: number, map: WorldMap): Drawn[] {
    const out: Drawn[] = [];
    const homes = new Map(map.locations.map((l) => [l.id, l]));
    const riding = ridingIds(this.store.rides.values());
    for (const e of this.store.villagers.values()) {
      const prof = this.store.profiles.get(e.id);
      const pos = entityPos(e, now);
      const home = prof ? homes.get(prof.homeId) : undefined;
      out.push({
        id: e.id,
        pos,
        entity: e,
        name: prof?.name ?? e.id,
        sheet: this.assets.sheet(prof?.sprite ?? '', e.id, prof?.transient ? 'stranger' : 'villager'),
        kind: prof?.transient ? 'stranger' : 'villager',
        hidden: riding.has(e.id) || (e.status === 'sleeping' && !!home && inArea(pos, home, 1)),
      });
    }
    const pe = this.store.playerEntity;
    const player = this.store.player;
    // Inside a building the player is drawn in the interior view only.
    if (pe && player && !player.inside) {
      out.push({
        id: PLAYER_ID,
        pos: entityPos(pe, now),
        entity: pe,
        name: `★ ${player.name}`,
        sheet: this.assets.sheet('characters/player.png', PLAYER_ID, 'player'),
        kind: 'player',
        hidden: riding.has(PLAYER_ID),
      });
    }
    const pet = this.store.petEntity;
    if (pet && player) {
      out.push({
        id: 'pet',
        pos: entityPos(pet, now),
        entity: pet,
        name: player.pet.name,
        sheet: this.assets.sheet(this.assets.meta?.pet?.sprite ?? 'characters/pet-pip.png', 'pet', 'pet'),
        kind: 'pet',
        hidden: false,
      });
    }
    return out;
  }

  /** Animals to draw; `view` (art px) culls those far off screen. */
  private collectAnimals(
    now: number,
    map: WorldMap,
    view: { x: number; y: number; w: number; h: number } | null,
  ): DrawnAnimal[] {
    const out: DrawnAnimal[] = [];
    const ts = map.tileSize;
    const pad = 3;
    for (const view_ of this.store.animals.values()) {
      const pos = entityPos(view_.e, now);
      if (
        view &&
        (pos.x * ts < view.x - pad * ts ||
          pos.y * ts < view.y - pad * ts ||
          pos.x * ts > view.x + view.w + pad * ts ||
          pos.y * ts > view.y + view.h + pad * ts)
      )
        continue;
      const s = view_.state;
      const sheet = this.assets.animalSheet(s.species, s.stage, hashString(s.id));
      const aerial = isAerial(s.species);
      out.push({
        id: s.id,
        view: view_,
        pos,
        image: sheet.image,
        info: sheet.info,
        aerial,
        lift: s.status === 'flying' ? FLY_LIFT : 0,
      });
    }
    return out;
  }

  private drawAnimal(a: DrawnAnimal, now: number, ts: number): void {
    const { ctx } = this;
    const { info } = a;
    const s = a.view.state;
    const moving = isMoving(a.view.e, now);
    const emoting = this.store.bubbles.has(a.id);
    const anim = animationFor(s.status, moving, emoting);
    const col = pickAnimalColumn(info, anim, now, hashString(a.id) % 1000);
    const row = info.rows[a.view.side];
    const tl = animalTopLeft(a.pos, ts, info);
    const w = Math.round(info.w * info.scale);
    const h = Math.round(info.h * info.scale);
    if (!a.aerial || a.lift > 0) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      const sw = Math.max(4, Math.round(w * 0.5));
      ctx.fillRect(tl.x + Math.round((w - sw) / 2), tl.y + h - 2 + (a.lift > 0 ? 0 : 0), sw, 2);
    }
    ctx.drawImage(a.image, col * info.w, row * info.h, info.w, info.h, tl.x, tl.y - a.lift, w, h);
  }

  /** Draws the visible chunks of a static layer in screen px, edges rounded so chunks never seam. */
  private drawLayer(which: 'below' | 'above', lit: boolean, ts: number, budget: { builds: number }): void {
    const { ctx, camera } = this;
    if (!this.layers) return;
    const z = camera.zoom;
    const ox = camera.offsetX;
    const oy = camera.offsetY;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    for (const ref of this.layers.visible(camera.visibleRect())) {
      const c = this.layers.chunkBudgeted(which, lit, ref, budget);
      const x0 = Math.round(ox + ref.x * ts * z);
      const y0 = Math.round(oy + ref.y * ts * z);
      const x1 = Math.round(ox + (ref.x + ref.w) * ts * z);
      const y1 = Math.round(oy + (ref.y + ref.h) * ts * z);
      ctx.drawImage(c, 0, 0, c.width, c.height, x0, y0, x1 - x0, y1 - y0);
    }
    ctx.setTransform(z, 0, 0, z, ox, oy);
    ctx.imageSmoothingEnabled = false;
  }

  private draw(now: number, map: WorldMap | null): void {
    const { ctx, canvas, camera } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = map ? BG : '#1b1b24';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!map || !this.layers) return;

    const z = camera.zoom;
    const gameTime = this.store.gameTimeAt(now);
    const night = nightFactor(gameTime);
    const lit = useLitTiles(night);
    const ts = map.tileSize;
    const drawn = this.collect(now, map).filter((d) => !d.hidden);
    const animals = this.collectAnimals(now, map, camera.visibleRect());

    // World pass in art px.
    const budget = { builds: 2 };
    this.drawLayer('below', lit, ts, budget);
    const decos = this.placedDecorations(map);
    for (const d of decos) this.drawDecoration(d, 'decor', lit, ts);
    this.drawItems(map, now);
    this.drawDoorNotes(map, now, 'paper');

    const sorted: { y: number; c?: Drawn; a?: DrawnAnimal; fn?: () => void }[] = drawn.map((c) => ({
      y: c.pos.y,
      c,
    }));
    for (const a of animals) if (!a.aerial) sorted.push({ y: a.pos.y, a });
    this.pushVehicles(sorted, map, now, gameTime, ts);
    sorted.sort((p, q) => p.y - q.y);
    for (const s of sorted) {
      if (s.c) this.drawCharacter(s.c, now, ts);
      else if (s.a) this.drawAnimal(s.a, now, ts);
      else s.fn?.();
    }

    this.drawLayer('above', lit, ts, budget);
    for (const d of decos) this.drawDecoration(d, 'overhead', lit, ts);
    this.drawRideFrames(map, now, ts, lit);
    for (const a of animals) if (a.aerial) this.drawAnimal(a, now, ts);
    // Lighting and weather in screen px.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const raining = this.store.weather.state === 'rain';
    const [r, g, b] = tintColor(night, raining);
    if (r < 255 || g < 255 || b < 255) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (night > 0.05) this.drawGlows(map, decos, night);
    if (raining) drawRain(ctx, canvas.width, canvas.height, z, now);
    this.drawFestive(map, now);
    if (night > 0.05) this.drawMoon(night);

    // Overlays (crisp text) in screen px.
    this.drawDoorNotes(map, now, 'icon');
    this.drawDoorLetters(map, now);
    this.drawEventMarkers(map, now);
    this.drawSleepers(map, now);
    // Front-most first so its tag keeps its place; the selected villager and the player go first of all.
    const placed: Box[] = [];
    const rank = (d: Drawn) => (this.store.selectedId === d.id ? 2 : d.kind === 'player' ? 1 : 0);
    const labelOrder = [...drawn].sort((p, q) => rank(q) - rank(p) || q.pos.y - p.pos.y);
    for (const d of labelOrder) this.drawLabels(d, now, ts, placed);
    this.drawBubbles(drawn, animals, now, ts);

    const interior = this.interiorView(map);
    if (interior) {
      // Entering: centre the dimmed world on the building so the view reads as "inside it".
      if (!this.insideGlide && interior.loc.door) {
        this.followId = null;
        this.camera.centerOn({ x: (interior.loc.door.x + 0.5) * ts, y: interior.loc.door.y * ts }, true);
      }
      this.drawInterior(map, interior, now, lit);
    } else this.insideGlide = null;
  }

  // ---------- Rides and the train ----------

  /** Closed coaster loops per ride location, traced from the track tiles once tilesets load. */
  private coasterLoops(map: WorldMap): Map<LocationId, Point[]> {
    if (this.loops && this.loopsFor === this.layers) return this.loops;
    const loops = new Map<LocationId, Point[]>();
    const names = this.assets.tileNames();
    if (names.size > 0) {
      for (const loc of map.locations) {
        if (loc.kind !== 'ride') continue;
        const masks = trackMasks(map, names, loc.area);
        const loop = masks.size > 0 ? traceLoop(masks, map.width, loc.entry) : null;
        if (loop) loops.set(loc.id, loop);
      }
    }
    this.loops = loops;
    this.loopsFor = this.layers;
    return loops;
  }

  /** Coaster cars and the train join the y-sort so villagers walk behind and in front of them. */
  private pushVehicles(
    sorted: { y: number; fn?: () => void }[],
    map: WorldMap,
    now: number,
    gameTime: number,
    ts: number,
  ): void {
    const { ctx } = this;
    const vehicles = this.assets.vehicles;
    const car = vehicles?.coasterCar;
    const carImg = car ? this.assets.image(car.sprite) : null;
    for (const [id, loop] of this.coasterLoops(map)) {
      for (const c of coasterCars(loop, this.store.rides.get(id), now)) {
        sorted.push({
          y: c.pos.y,
          fn: () => {
            const x = Math.round(c.pos.x * ts);
            const y = Math.round(c.pos.y * ts);
            if (car && carImg) {
              const col = Math.max(0, (car.columns ?? []).indexOf(c.heading));
              ctx.drawImage(carImg, col * car.frameWidth, 0, car.frameWidth, car.frameHeight, x, y, ts, ts);
            } else {
              ctx.fillStyle = OUTLINE;
              ctx.fillRect(x + 2, y + 4, ts - 4, ts - 7);
              ctx.fillStyle = '#d6463a';
              ctx.fillRect(x + 3, y + 5, ts - 6, ts - 9);
            }
          },
        });
      }
    }
    const pose = trainPose(this.store.train, gameTime, map);
    if (!pose) return;
    const train = vehicles?.train;
    const img = train ? this.assets.image(train.sprite) : null;
    sorted.push({
      y: pose.row,
      fn: () => {
        const fh = train?.frameHeight ?? 2 * ts;
        const fw = train?.frameWidth ?? CAR_TILES * ts;
        const y = (pose.row + 1) * ts - fh;
        const frames = train?.frames ?? 1;
        const col = pose.moving ? Math.floor(now / 160) % frames : 0;
        const rows = train?.rows ?? [];
        const carRows = ['engine_left', 'carriage_red_left', 'carriage_green_left', 'carriage_blue_left'];
        for (let k = 0; k < TRAIN_CARS; k++) {
          const x = Math.round((pose.x + k * CAR_TILES) * ts);
          if (x > map.width * ts || x + fw < 0) continue;
          const row = rows.indexOf(carRows[k]!);
          if (train && img && row >= 0) {
            ctx.drawImage(img, col * fw, row * fh, fw, fh, x, y, fw, fh);
          } else {
            ctx.fillStyle = OUTLINE;
            ctx.fillRect(x + 1, y + 8, fw - 2, fh - 10);
            ctx.fillStyle = k === 0 ? '#3b3f5c' : ['#c8463a', '#4a8a4a', '#3a6ab0'][(k - 1) % 3]!;
            ctx.fillRect(x + 2, y + 9, fw - 4, fh - 13);
          }
        }
      },
    });
  }

  /** Ferris wheel and carousel frames over their map objects while running. */
  private drawRideFrames(map: WorldMap, now: number, ts: number, lit: boolean): void {
    const v = this.assets.vehicles;
    if (!v) return;
    const anims: [VehicleSheet | undefined, number][] = [
      [v.ferrisWheel, 4],
      [v.carousel, 6],
    ];
    for (const [sheet, fps] of anims) {
      if (!sheet?.object) continue;
      const loc = map.locations.find((l) => l.id === sheet.object);
      if (!loc) continue;
      const frame = rideFrame(this.store.rides.get(loc.id), sheet.frames ?? 1, fps, now);
      if (frame === null) continue;
      const img = this.assets.image(sheet.sprite);
      if (!img) continue;
      const cols = Math.max(1, Math.floor(img.width / sheet.frameWidth));
      const sx = (frame % cols) * sheet.frameWidth;
      const sy = Math.floor(frame / cols) * sheet.frameHeight;
      const { frameWidth: w, frameHeight: h } = sheet;
      // The static object tiles would show through the frame's transparent parts (double gondolas), so
      // the ground under the object is repainted first.
      const { x: ax, y: ay } = loc.area;
      const tw = Math.ceil(w / ts);
      const th = Math.ceil(h / ts);
      for (let y = ay; y < Math.min(map.height, ay + th); y++) {
        for (let x = ax; x < Math.min(map.width, ax + tw); x++) {
          const src = tileSource(this.assets.tilesets, map.layers.ground[y * map.width + x] ?? -1, lit);
          if (src)
            this.ctx.drawImage(src.ts.image, src.sx, src.sy, src.size, src.size, x * ts, y * ts, ts, ts);
        }
      }
      this.ctx.drawImage(img, sx, sy, w, h, ax * ts, ay * ts, w, h);
    }
  }

  // ---------- Interiors ----------

  /** Interior view state while the player is inside, else null. */
  private interiorView(
    map: WorldMap,
  ): { tpl: InteriorTemplate; loc: Location; layout: InteriorLayout } | null {
    const inside = this.store.player?.inside;
    if (!inside) return null;
    const tpl = interiorFor(map, inside.locationId);
    const loc = map.locations.find((l) => l.id === inside.locationId);
    if (!tpl || !loc) return null;
    return { tpl, loc, layout: interiorLayout(tpl, map.tileSize, this.canvas.width, this.canvas.height) };
  }

  /** Villagers who are in the building: standing (not walking) at it, and at home or in a public one. */
  private residentsOf(loc: Location, now: number): VillagerId[] {
    const out: VillagerId[] = [];
    const isHome = loc.kind === 'house';
    for (const e of this.store.villagers.values()) {
      if (e.status === 'walking' || isMoving(e, now)) continue;
      const prof = this.store.profiles.get(e.id);
      if (isHome && prof?.homeId !== loc.id) continue;
      if (!isHome && loc.id === 'hotel' && !prof?.visitor && !this.store.visitors.has(e.id)) continue;
      if (inArea(entityPos(e, now), loc, 1)) out.push(e.id);
    }
    return out;
  }

  /** Player position inside, gliding between `inside.pos` updates. */
  private insidePos(now: number): { pos: Point; moving: boolean; facing: Facing } {
    const target = this.store.player?.inside?.pos ?? { x: 0, y: 0 };
    const g = this.insideGlide;
    if (!g || g.to.x !== target.x || g.to.y !== target.y) {
      const from = g ? glideAt(g, now) : target;
      const dx = target.x - from.x;
      const dy = target.y - from.y;
      const facing: Facing =
        dx === 0 && dy === 0
          ? (g?.facing ?? 'up')
          : Math.abs(dx) >= Math.abs(dy)
            ? dx > 0
              ? 'right'
              : 'left'
            : dy > 0
              ? 'down'
              : 'up';
      this.insideGlide = {
        from,
        to: { ...target },
        t0: now,
        durMs: Math.min(1500, Math.hypot(dx, dy) * 220),
        facing,
      };
    }
    const cur = this.insideGlide!;
    return { pos: glideAt(cur, now), moving: now - cur.t0 < cur.durMs, facing: cur.facing };
  }

  private interiorHit(
    map: WorldMap,
    view: { tpl: InteriorTemplate; loc: Location; layout: InteriorLayout },
    device: Point,
  ): HitResult {
    const p = toInterior(view.layout, device);
    if (!p) return { kind: 'none' };
    const ts = map.tileSize;
    const spots = residentSpots(view.tpl, this.residentsOf(view.loc, performance.now()));
    const byY = [...spots].sort((a, b) => b[1].y - a[1].y);
    for (const [id, pos] of byY) if (inRect(p, spriteHitBox(pos, ts))) return { kind: 'villager', id };
    const tile = { x: Math.floor(p.x / ts), y: Math.floor(p.y / ts) };
    const obj = objectAt(view.tpl, tile, this.assets.tileNames());
    if (obj) return { kind: 'object', id: obj, locationId: view.loc.id };
    return { kind: 'ground', tile, blocked: interiorBlocked(view.tpl, tile) };
  }

  private drawInteriorTiles(
    tpl: InteriorTemplate,
    layer: 'ground' | 'decor' | 'overhead',
    lit: boolean,
    ts: number,
  ): void {
    const tilesets = this.assets.tilesets;
    const data = tpl.layers[layer];
    for (let y = 0; y < tpl.height; y++) {
      for (let x = 0; x < tpl.width; x++) {
        const src = tileSource(tilesets, data[y * tpl.width + x] ?? -1, lit);
        if (src) this.ctx.drawImage(src.ts.image, src.sx, src.sy, src.size, src.size, x * ts, y * ts, ts, ts);
        else if (layer === 'ground' && tilesets.length === 0) {
          this.ctx.fillStyle = tpl.collision[y * tpl.width + x] === 1 ? '#7a5a3a' : '#d8b48a';
          this.ctx.fillRect(x * ts, y * ts, ts, ts);
        }
      }
    }
  }

  /** The interior as its own view over the dimmed world (spec v2 §13). */
  private drawInterior(
    map: WorldMap,
    view: { tpl: InteriorTemplate; loc: Location; layout: InteriorLayout },
    now: number,
    lit: boolean,
  ): void {
    const { ctx, canvas } = this;
    const { tpl, loc, layout } = view;
    const ts = map.tileSize;
    const z = layout.zoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(16, 14, 24, 0.62)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const b = Math.max(2, Math.round(2 * z));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(layout.x, layout.y + b, layout.w + b * 2, layout.h + b * 2);
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(layout.x - b, layout.y - b, layout.w + b * 2, layout.h + b * 2);

    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.x, layout.y, layout.w, layout.h);
    ctx.clip();
    ctx.setTransform(z, 0, 0, z, layout.x, layout.y);
    ctx.imageSmoothingEnabled = false;
    this.drawInteriorTiles(tpl, 'ground', lit, ts);
    this.drawInteriorTiles(tpl, 'decor', lit, ts);

    const people: Drawn[] = [];
    for (const [id, pos] of residentSpots(tpl, this.residentsOf(loc, now))) {
      const e = this.store.villagers.get(id);
      if (!e) continue;
      const prof = this.store.profiles.get(id);
      const still: Entity = {
        ...e,
        fromX: pos.x,
        toX: pos.x,
        fromY: pos.y,
        toY: pos.y,
        t0: 0,
        durMs: 0,
        facing: 'down',
        lastMovedAt: 0,
        status: e.status === 'sleeping' ? 'sleeping' : 'idle',
      };
      const kind: PlaceholderKind = prof?.transient ? 'stranger' : 'villager';
      people.push({
        id,
        pos,
        entity: still,
        name: prof?.name ?? id,
        sheet: this.assets.sheet(prof?.sprite ?? '', id, kind),
        kind,
        hidden: false,
      });
    }
    const pe = this.store.playerEntity;
    const player = this.store.player;
    if (pe && player) {
      const me = this.insidePos(now);
      // A glide that is still under way, so drawCharacter picks the walk cycle.
      const walker: Entity = {
        ...pe,
        fromX: me.pos.x,
        toX: me.pos.x,
        fromY: me.pos.y,
        toY: me.pos.y,
        t0: me.moving ? now - 1 : 0,
        durMs: me.moving ? 1000 : 0,
        lastMovedAt: me.moving ? now : 0,
        facing: me.facing,
        status: me.moving ? 'walking' : 'idle',
      };
      people.push({
        id: PLAYER_ID,
        pos: me.pos,
        entity: walker,
        name: `★ ${player.name}`,
        sheet: this.assets.sheet('characters/player.png', PLAYER_ID, 'player'),
        kind: 'player',
        hidden: false,
      });
    }
    people.sort((p, q) => p.pos.y - q.pos.y);
    for (const d of people) this.drawCharacter(d, now, ts);
    this.drawInteriorTiles(tpl, 'overhead', lit, ts);
    ctx.restore();

    // Labels and markers in screen px.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const toScreen = (p: Point) => ({ x: layout.x + p.x * z, y: layout.y + p.y * z });
    const rects = objectRects(tpl, this.assets.tileNames());
    for (const o of tpl.objects ?? []) {
      const rr = rects.get(o.id) ?? { x: o.pos.x, y: o.pos.y - 1, w: 1, h: 2 };
      const p = toScreen({ x: (rr.x + rr.w / 2) * ts, y: rr.y * ts });
      const bounce = Math.round(Math.abs(Math.sin(now / 300)) * 2 * z);
      const size = Math.round(10 * z);
      if (!this.drawIcon(o.id === 'keep_cupboard' ? 'keep' : 'star', p.x, p.y - bounce, size))
        this.emojiAt('📒', p.x, p.y - bounce, size);
    }
    const px = Math.max(Math.round(11 * this.dpr()), Math.round(5.5 * z));
    ctx.font = `${px}px ${WORLD_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const d of people) {
      const feet = toScreen(feetPoint(d.pos, ts));
      const w = Math.ceil(ctx.measureText(d.name).width) + Math.round(px * 0.6);
      const hh = Math.round(px * 1.35);
      const x = Math.round(feet.x - w / 2);
      const y = Math.round(feet.y + z);
      const selected = this.store.selectedId === d.id;
      pill(ctx, x, y, w, hh, Math.round(px / 3), selected ? ACCENT : TAG_FILL);
      ctx.fillStyle = selected ? OUTLINE : TAG_TEXT;
      ctx.fillText(d.name, x + w / 2, y + hh / 2 + 1);
    }
    const tw = Math.ceil(ctx.measureText(loc.name).width) + px;
    const th = Math.round(px * 1.6);
    const ty = layout.y - b - th - Math.round(z);
    pill(ctx, Math.round(layout.x + layout.w / 2 - tw / 2), ty, tw, th, Math.round(px / 3), TAG_FILL);
    ctx.fillStyle = TAG_TEXT;
    ctx.fillText(loc.name, Math.round(layout.x + layout.w / 2), ty + th / 2 + 1);
  }

  // ---------- Characters ----------
  private drawCharacter(d: Drawn, now: number, ts: number): void {
    const { ctx } = this;
    const moving = isMoving(d.entity, now);
    const pick = pickFrame(
      d.entity.facing,
      moving,
      now,
      hashString(d.id) % 1000,
      d.entity.status === 'sleeping',
    );
    const tl = spriteTopLeft(d.pos, ts);
    // Soft oval shadow under the feet.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(tl.x + 4, tl.y + FRAME_H - 3, FRAME_W - 8, 2);
    ctx.fillRect(tl.x + 5, tl.y + FRAME_H - 4, FRAME_W - 10, 4);
    ctx.drawImage(
      d.sheet,
      pick.col * FRAME_W,
      pick.row * FRAME_H,
      FRAME_W,
      FRAME_H,
      tl.x,
      tl.y + pick.bob,
      FRAME_W,
      FRAME_H,
    );
  }

  private fontPx(artPx: number, minCss: number): number {
    return Math.max(Math.round(minCss * this.dpr()), Math.round(artPx * this.camera.zoom));
  }

  private drawLabels(d: Drawn, now: number, ts: number, placed: Box[]): void {
    const { ctx, camera } = this;
    const feet = camera.worldToScreen(feetPoint(d.pos, ts));
    const top = camera.worldToScreen(spriteTopLeft(d.pos, ts));
    if (
      feet.x < -200 ||
      feet.y < -200 ||
      feet.x > this.canvas.width + 200 ||
      feet.y > this.canvas.height + 200
    )
      return;
    const z = camera.zoom;
    const selected = this.store.selectedId === d.id;
    if (d.kind !== 'pet') {
      const px = this.fontPx(5.5, 11);
      ctx.font = `${px}px ${WORLD_FONT}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const w = Math.ceil(ctx.measureText(d.name).width) + Math.round(px * 0.6);
      const h = Math.round(px * 1.35);
      const x = Math.round(feet.x - w / 2);
      const y = placeLabel({ x, y: Math.round(feet.y + z), w, h }, placed, z < 1.5 && mayDrop(selected, d));
      if (y !== null) {
        pill(ctx, x, y, w, h, Math.round(px / 3), selected ? ACCENT : TAG_FILL);
        ctx.fillStyle = selected ? OUTLINE : TAG_TEXT;
        ctx.fillText(d.name, x + w / 2, y + h / 2 + 1);
      }
    }
    // Activity emote at the top-right of the head.
    const e = d.entity;
    const emoteSize = Math.round(8 * z * 0.8);
    const ex = top.x + Math.round(12 * z);
    const ey = top.y + Math.round(2 * z);
    if (e.status === 'talking' && this.drawIcon('chat', ex, ey, emoteSize)) {
      // drawn
    } else if (e.status === 'sleeping') {
      if (!this.drawIcon('zzz', ex, ey, emoteSize)) this.emojiAt('💤', ex, ey, emoteSize);
    } else if (e.emoji && d.kind !== 'pet') {
      this.emojiAt(e.emoji, ex, ey, emoteSize);
    }
    if (selected) {
      const bob = Math.floor(now / 300) % 2 === 0 ? 0 : z;
      const cx = Math.round(top.x + 8 * z);
      const cy = Math.round(top.y + bob - z);
      ctx.fillStyle = OUTLINE;
      tri(ctx, cx, cy + z, 4 * z, 3 * z);
      ctx.fillStyle = ACCENT;
      tri(ctx, cx, cy, 3 * z, 2 * z);
    }
  }

  private emojiAt(emoji: string, x: number, y: number, size: number): void {
    const { ctx } = this;
    ctx.font = `${size}px ${WORLD_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000';
    ctx.fillText(emoji, x, y);
  }

  /** Draw a UI icon centred at (x, y), `size` device px; false when the icon sheet lacks it. */
  private drawIcon(name: string, x: number, y: number, size: number): boolean {
    const ic = this.assets.icon(name);
    if (!ic) return false;
    const s = Math.max(ic.size, Math.round(size / ic.size) * ic.size);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(
      ic.image,
      ic.sx,
      ic.sy,
      ic.size,
      ic.size,
      Math.round(x - s / 2),
      Math.round(y - s / 2),
      s,
      s,
    );
    return true;
  }

  private drawBubbles(drawn: Drawn[], animals: DrawnAnimal[], now: number, ts: number): void {
    const { ctx, camera } = this;
    const z = camera.zoom;
    const heads = new Map<string, Point>();
    for (const d of drawn) heads.set(d.id, { x: feetPoint(d.pos, ts).x, y: spriteTopLeft(d.pos, ts).y + 4 });
    for (const a of animals) {
      const tl = animalTopLeft(a.pos, ts, a.info);
      heads.set(a.id, { x: tl.x + (a.info.w * a.info.scale) / 2, y: tl.y - a.lift + 2 });
    }
    const px = this.fontPx(5.5, 11);
    ctx.font = `${px}px ${WORLD_FONT}`;
    const measure = (s: string) => ctx.measureText(s).width;
    const padX = Math.round(px * 0.6);
    const padY = Math.round(px * 0.35);
    const lineH = Math.round(px * 1.2);
    const maxW = Math.max(120 * this.dpr(), 96 * z);
    const boxes: (Parameters<typeof layoutBubbles>[0][number] & { lines: string[]; alpha: number })[] = [];
    for (const b of this.store.activeBubbles(now)) {
      const anchor = heads.get(b.speakerId);
      if (!anchor) continue;
      const head = camera.worldToScreen(anchor);
      if (
        head.x < -maxW ||
        head.x > this.canvas.width + maxW ||
        head.y < 0 ||
        head.y > this.canvas.height + 40 * z
      )
        continue;
      const lines = wrapText(b.text, maxW, measure, 2);
      const w = Math.ceil(Math.max(...lines.map(measure))) + padX * 2;
      const h = lines.length * lineH + padY * 2;
      boxes.push({
        id: b.speakerId,
        ax: head.x,
        ay: head.y,
        w,
        h,
        lines,
        alpha: bubbleAlpha(now - b.startedAt, b.durMs),
      });
    }
    const tail = Math.max(3, Math.round(3 * z));
    const placed = layoutBubbles(boxes, { w: this.canvas.width, h: this.canvas.height }, tail + z);
    const border = Math.max(1, Math.round(z * 0.5));
    for (const p of placed) {
      const src = boxes.find((b) => b.id === p.id)!;
      ctx.globalAlpha = src.alpha;
      const r = Math.max(2, Math.round(2 * z));
      ctx.fillStyle = OUTLINE;
      roundRect(ctx, p.x - border, p.y - border, p.w + border * 2, p.h + border * 2, r + border);
      ctx.fill();
      // Tail only when the bubble still sits right above its speaker.
      const tx = Math.min(p.x + p.w - r - tail, Math.max(p.x + r + tail, p.ax));
      const attached = p.y + p.h + tail * 2 >= p.ay;
      if (attached) {
        ctx.beginPath();
        ctx.moveTo(tx - tail - border, p.y + p.h);
        ctx.lineTo(tx + tail + border, p.y + p.h);
        ctx.lineTo(tx, p.y + p.h + tail + border * 2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = BUBBLE_FILL;
      roundRect(ctx, p.x, p.y, p.w, p.h, r);
      ctx.fill();
      if (attached) {
        ctx.beginPath();
        ctx.moveTo(tx - tail, p.y + p.h - 1);
        ctx.lineTo(tx + tail, p.y + p.h - 1);
        ctx.lineTo(tx, p.y + p.h + tail);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = OUTLINE;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      src.lines.forEach((line, i) =>
        ctx.fillText(line, p.x + p.w / 2, p.y + padY + lineH * i + lineH / 2 + 1),
      );
    }
    ctx.globalAlpha = 1;
  }

  // ---------- World props ----------

  private placedDecorations(map: WorldMap): { tile: Point; object: string; emoji: string; id: string }[] {
    const player = this.store.player;
    if (!player || player.placedDecorations.length === 0) return [];
    const home = map.locations.find((l) => l.id === (player.homeId || PLAYER_HOME_ID));
    const slots = home?.decorSlots ?? [];
    const catalog = this.assets.meta?.decorations ?? [];
    const out: { tile: Point; object: string; emoji: string; id: string }[] = [];
    player.placedDecorations.forEach((id, i) => {
      const item = catalog.find((c) => c.id === id);
      const slot = slots[item?.slot ?? i];
      if (!slot) return;
      out.push({ tile: slot, object: item?.sprite ?? `deco_${id}`, emoji: item?.emoji ?? '✨', id });
    });
    return out;
  }

  private drawDecoration(
    d: { tile: Point; object: string; emoji: string },
    layer: 'decor' | 'overhead',
    lit: boolean,
    ts: number,
  ): void {
    const found = this.assets.object(d.object);
    if (found) {
      this.drawObject(found.obj, found.tileset, layer, d.tile, lit, ts);
      return;
    }
    if (layer !== 'decor') return;
    const { ctx } = this;
    ctx.font = `${ts - 4}px ${WORLD_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(d.emoji, d.tile.x * ts + ts / 2, d.tile.y * ts + ts / 2);
  }

  private drawObject(
    obj: TileObject,
    tileset: LoadedTileset,
    layer: 'decor' | 'overhead',
    at: Point,
    lit: boolean,
    ts: number,
  ): void {
    const rows = obj.layers[layer];
    if (!rows || !tileset.meta) return;
    rows.forEach((row, y) =>
      row.forEach((name, x) => {
        if (!name) return;
        const idx = tileset.meta!.tiles[name];
        if (idx === undefined) return;
        const src = tileSource([tileset], idx + tileset.ref.firstIndex, lit);
        if (!src) return;
        this.ctx.drawImage(
          src.ts.image,
          src.sx,
          src.sy,
          src.size,
          src.size,
          (at.x + x) * ts,
          (at.y + y) * ts,
          ts,
          ts,
        );
      }),
    );
  }

  private drawItems(map: WorldMap, now: number): void {
    const ts = map.tileSize;
    const defs = this.assets.meta?.items ?? [];
    for (const it of this.store.items) {
      const def = defs.find((d) => d.id === it.itemId);
      const bob = Math.floor((now + (hashString(it.id) % 1000)) / 600) % 2;
      const ic = this.assets.iconRef(def?.sprite) ?? this.assets.icon(it.itemId);
      const x = Math.round(it.pos.x * ts) + 2;
      const y = Math.round(it.pos.y * ts) + 1 - bob;
      if (ic) {
        this.ctx.drawImage(ic.image, ic.sx, ic.sy, ic.size, ic.size, x, y, ts - 4, ts - 4);
      } else {
        this.ctx.font = `${ts - 6}px ${WORLD_FONT}`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(def?.emoji ?? '✿', x + (ts - 4) / 2, y + (ts - 4) / 2);
      }
    }
  }

  /**
   * Letter markers over doors: a bouncing "new mail" icon on mailboxes with delivered, unread letters
   * and a letter icon at the post office while letters wait to be delivered.
   */
  private drawDoorLetters(map: WorldMap, now: number): void {
    const ts = map.tileSize;
    const z = this.camera.zoom;
    const marks = new Map<LocationId, 'mail_new' | 'letter'>();
    for (const box of this.store.lettersByMailbox().keys()) marks.set(box, 'mail_new');
    if (this.store.undeliveredLetters().length > 0 && !marks.has('post_office'))
      marks.set('post_office', 'letter');
    for (const [id, icon] of marks) {
      const loc = map.locations.find((l) => l.id === id);
      if (!loc?.door) continue;
      const hasNote = this.store
        .notesForHouse(id)
        .some((n) => n.status === 'unread' || n.status === 'replied');
      const bounce = icon === 'mail_new' ? Math.round(Math.abs(Math.sin(now / 250 + 1)) * 2 * z) : 0;
      const p = this.camera.worldToScreen({
        x: loc.door.x * ts + ts / 2 + (hasNote ? ts * 0.75 : 0),
        y: (loc.door.y - 1) * ts,
      });
      const size = Math.round(10 * z);
      if (!this.drawIcon(icon, p.x, p.y - bounce, size)) this.emojiAt('✉', p.x, p.y - bounce, size);
    }
  }

  /** Door markers: `paper` = the note pinned on the door (world pass), `icon` = the floating marker. */ private drawDoorNotes(
    map: WorldMap,
    now: number,
    pass: 'paper' | 'icon',
  ): void {
    const ts = map.tileSize;
    for (const loc of map.locations) {
      if (!loc.door) continue;
      const notes = this.store.notesForHouse(loc.id);
      if (notes.length === 0) continue;
      const toPlayer = loc.id === PLAYER_HOME_ID;
      const waiting = notes.some(
        (n) => n.status === 'unread' && (toPlayer ? n.authorId !== PLAYER_ID : true),
      );
      const replied = notes.some((n) => n.status === 'replied');
      if (!waiting && !replied) continue;
      if (pass === 'paper') {
        if (!waiting) continue;
        const obj = this.assets.object('door_note');
        if (obj) this.drawObject(obj.obj, obj.tileset, 'decor', loc.door, false, ts);
        else {
          this.ctx.fillStyle = OUTLINE;
          this.ctx.fillRect(loc.door.x * ts + 5, loc.door.y * ts + 1, 6, 6);
          this.ctx.fillStyle = BUBBLE_FILL;
          this.ctx.fillRect(loc.door.x * ts + 6, loc.door.y * ts + 2, 4, 4);
        }
        continue;
      }
      const z = this.camera.zoom;
      const bounce = waiting ? Math.round(Math.abs(Math.sin(now / 250)) * 2 * z) : 0;
      const p = this.camera.worldToScreen({ x: loc.door.x * ts + ts / 2, y: (loc.door.y - 1) * ts });
      const size = Math.round(10 * z);
      const name = waiting ? 'note' : 'reply';
      if (!this.drawIcon(name, p.x, p.y - bounce, size))
        this.emojiAt(waiting ? '📝' : '✉', p.x, p.y - bounce, size);
    }
  }

  /** A small "zzz" over the doors of homes with sleeping (hidden) villagers. */
  private drawSleepers(map: WorldMap, now: number): void {
    const ts = map.tileSize;
    const homes = new Map<string, Location>(map.locations.map((l) => [l.id, l]));
    const shown = new Set<string>();
    for (const e of this.store.villagers.values()) {
      if (e.status !== 'sleeping') continue;
      const prof = this.store.profiles.get(e.id);
      const home = prof ? homes.get(prof.homeId) : undefined;
      if (!home?.door || shown.has(home.id) || !inArea(entityPos(e, now), home, 1)) continue;
      shown.add(home.id);
      const z = this.camera.zoom;
      const drift = Math.round(((now / 80) % 8) * (z / 2));
      const p = this.camera.worldToScreen({ x: home.door.x * ts + ts, y: (home.door.y - 2) * ts });
      const size = Math.round(8 * z);
      if (!this.drawIcon('zzz', p.x, p.y - drift, size)) this.emojiAt('💤', p.x, p.y - drift, size);
    }
  }

  private drawEventMarkers(map: WorldMap, now: number): void {
    const { ctx } = this;
    const ts = map.tileSize;
    const z = this.camera.zoom;
    for (const ev of this.store.events.values()) {
      if (ev.status !== 'happening') continue;
      const loc = map.locations.find((l) => l.id === ev.locationId);
      if (!loc) continue;
      const bob = Math.round(Math.sin(now / 400) * z);
      const p = this.camera.worldToScreen({ x: (loc.area.x + loc.area.w / 2) * ts, y: loc.area.y * ts + 4 });
      const px = this.fontPx(4.5, 9);
      ctx.font = `${px}px ${WORLD_FONT}`;
      const label = `${eventEmoji(ev)} ${ev.title}`;
      const w = Math.ceil(ctx.measureText(label).width) + px;
      const h = Math.round(px * 1.6);
      const x = Math.round(p.x - w / 2);
      const y = Math.round(p.y + bob);
      pill(ctx, x, y, w, h, Math.round(h / 2), 'rgba(24, 32, 23, 0.88)');
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = Math.max(1, Math.round(z / 2));
      roundRect(ctx, x, y, w, h, Math.round(h / 2));
      ctx.stroke();
      ctx.fillStyle = '#fef7e5';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    }
  }

  private drawFestive(map: WorldMap, now: number): void {
    const ts = map.tileSize;
    for (const ev of this.store.events.values()) {
      if (ev.status !== 'happening' || !isFestive(ev, this.store.worldEvents.values())) continue;
      const loc = map.locations.find((l) => l.id === ev.locationId);
      if (!loc) continue;
      const tl = this.camera.worldToScreen({ x: loc.area.x * ts, y: loc.area.y * ts });
      const z = this.camera.zoom;
      drawConfetti(
        this.ctx,
        { x: tl.x, y: tl.y, w: loc.area.w * ts * z, h: loc.area.h * ts * z },
        z,
        now,
        ev.id,
      );
    }
  }

  private lights(map: WorldMap, decos: { tile: Point; id: string; object: string }[]): LightSpot[] {
    const fromMeta = this.layers?.hasArt ? this.assets.meta?.lights : undefined;
    const out: LightSpot[] = fromMeta ? [...fromMeta] : derivedLights(map);
    for (const d of decos)
      if (/lantern|string_lights/.test(d.object)) out.push({ x: d.tile.x, y: d.tile.y, kind: 'lamp' });
    return out;
  }

  /** Warm light pools, matching the art preview: normal blending, stepped (unsmoothed) glow sprite. */
  private drawGlows(
    map: WorldMap,
    decos: { tile: Point; id: string; object: string }[],
    night: number,
  ): void {
    const { ctx, camera } = this;
    const ts = map.tileSize;
    const z = camera.zoom;
    ctx.globalAlpha = night;
    for (const l of this.lights(map, decos)) {
      const lamp = l.kind !== 'window';
      const r = (lamp ? 3 : 1.25) * ts * z;
      const c = camera.worldToScreen({ x: l.x * ts + ts / 2, y: l.y * ts + (lamp ? 6 : 8) });
      if (c.x < -r || c.y < -r || c.x > this.canvas.width + r || c.y > this.canvas.height + r) continue;
      if (this.assets.glow) {
        ctx.drawImage(
          this.assets.glow,
          Math.round(c.x - r),
          Math.round(c.y - r),
          Math.round(r * 2),
          Math.round(r * 2),
        );
      } else {
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
        g.addColorStop(0, 'rgba(253, 230, 160, 0.55)');
        g.addColorStop(1, 'rgba(253, 230, 160, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawMoon(night: number): void {
    const { ctx } = this;
    const dpr = this.dpr();
    const x = Math.round(this.canvas.width / 2);
    const y = Math.round(40 * dpr);
    ctx.globalAlpha = night;
    if (!this.drawIcon('moon', x, y, Math.round(32 * dpr))) {
      ctx.fillStyle = '#e8e4d0';
      ctx.beginPath();
      ctx.arc(x, y, 9 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- Input ----------

  private bindInput(): void {
    const c = this.canvas;
    const scale = () => c.width / Math.max(1, c.getBoundingClientRect().width);
    const down = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      this.pointer = {
        id: ev.pointerId,
        x: ev.clientX,
        y: ev.clientY,
        startX: ev.clientX,
        startY: ev.clientY,
        dragging: false,
      };
      c.setPointerCapture?.(ev.pointerId);
    };
    const move = (ev: PointerEvent) => {
      const p = this.pointer;
      if (p && p.id === ev.pointerId) {
        if (!p.dragging && Math.hypot(ev.clientX - p.startX, ev.clientY - p.startY) > DRAG_THRESHOLD) {
          p.dragging = true;
          this.userMovedCamera();
        }
        if (p.dragging) {
          const s = scale();
          this.camera.panBy((ev.clientX - p.x) * s, (ev.clientY - p.y) * s);
          c.style.cursor = 'grabbing';
        }
        p.x = ev.clientX;
        p.y = ev.clientY;
        return;
      }
      this.hover = this.hitAt(ev.clientX, ev.clientY);
      const k = this.hover.kind;
      c.style.cursor = ['villager', 'animal', 'door', 'object', 'notice'].includes(k) ? 'pointer' : 'default';
    };
    const up = (ev: PointerEvent) => {
      const p = this.pointer;
      if (!p || p.id !== ev.pointerId) return;
      this.pointer = null;
      c.style.cursor = 'default';
      if (p.dragging) return;
      const hit = this.hitAt(ev.clientX, ev.clientY);
      switch (hit.kind) {
        case 'villager':
          this.emit('villager', hit.id);
          break;
        case 'animal':
          this.emit('animal', hit.id);
          break;
        case 'door':
          this.emit('door', { houseId: hit.houseId, canEnter: this.canEnter(hit.houseId) });
          break;
        case 'ground':
          this.emit('ground', { tile: hit.tile, blocked: hit.blocked });
          break;
        case 'player':
          this.emit('player', null);
          break;
        case 'object':
          this.emit('object', { id: hit.id, locationId: hit.locationId });
          break;
        case 'notice':
          this.emit('noticeBoard', null);
          break;
      }
    };
    const cancel = () => {
      this.pointer = null;
    };
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = c.getBoundingClientRect();
      const s = scale();
      this.userMovedCamera();
      this.camera.zoomBy(ev.deltaY < 0 ? 1 : -1, {
        x: (ev.clientX - r.left) * s,
        y: (ev.clientY - r.top) * s,
      });
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', cancel);
    c.addEventListener('wheel', wheel, { passive: false });
    c.style.touchAction = 'none';
    this.cleanup.push(() => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', cancel);
      c.removeEventListener('wheel', wheel);
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(c);
    }
  }
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function mayDrop(selected: boolean, d: { kind: PlaceholderKind }): boolean {
  return !selected && d.kind !== 'player';
}

/**
 * Top of a name tag that does not cover the tags already placed: the wanted spot, else up to two
 * rows lower. When still covered it is dropped if `droppable` (crowded overview), else drawn anyway.
 */
export function placeLabel(want: Box, placed: Box[], droppable: boolean): number | null {
  const gap = 1;
  const hits = (b: Box) =>
    placed.some((p) => b.x < p.x + p.w + gap && p.x < b.x + b.w + gap && b.y < p.y + p.h && p.y < b.y + b.h);
  for (let k = 0; k <= 2; k++) {
    const b = { ...want, y: want.y + k * (want.h + gap) };
    if (!hits(b)) {
      placed.push(b);
      return b.y;
    }
  }
  if (droppable) return null;
  placed.push(want);
  return want.y;
}

interface Glide {
  from: Point;
  to: Point;
  t0: number;
  durMs: number;
  facing: Facing;
}

function glideAt(g: Glide, now: number): Point {
  const t = g.durMs > 0 ? Math.min(1, (now - g.t0) / g.durMs) : 1;
  return { x: g.from.x + (g.to.x - g.from.x) * t, y: g.from.y + (g.to.y - g.from.y) * t };
}

function inRect(p: Point, b: { x: number; y: number; w: number; h: number }): boolean {
  return p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;
}

function inArea(p: Point, loc: Location, pad: number): boolean {
  const a = loc.area;
  return p.x >= a.x - pad && p.x < a.x + a.w + pad && p.y >= a.y - pad && p.y < a.y + a.h + pad;
}

/** Window lights next to each door, for maps without village.meta.json. */
function derivedLights(map: WorldMap): LightSpot[] {
  const out: LightSpot[] = [];
  for (const l of map.locations) {
    if (!l.door) continue;
    out.push(
      { x: l.area.x + 1, y: l.door.y - 1, kind: 'window' },
      { x: l.area.x + Math.min(l.area.w, 8) - 2, y: l.door.y - 1, kind: 'window' },
    );
  }
  return out;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function pill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
): void {
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
}

/** Downward-pointing triangle with its tip at (cx, cy + h). */
function tri(ctx: CanvasRenderingContext2D, cx: number, cy: number, halfW: number, h: number): void {
  ctx.beginPath();
  ctx.moveTo(cx - halfW, cy - h);
  ctx.lineTo(cx + halfW, cy - h);
  ctx.lineTo(cx, cy + h / 2);
  ctx.closePath();
  ctx.fill();
}
