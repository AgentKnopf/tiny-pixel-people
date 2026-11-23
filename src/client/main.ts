import type { ServerMessage } from '../shared/protocol.ts';
import type { WorldMap } from '../shared/types.ts';
import { connect, type Connection } from './net.ts';
import { mountUi } from './ui/index.ts';

// Skeleton client: draws the collision grid and locations. WP4 replaces this with the real renderer.
const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const ctx = canvas.getContext('2d')!;
const SCALE = 2;

let map: WorldMap | null = null;

function draw(): void {
  if (!map) return;
  const ts = map.tileSize * SCALE;
  canvas.width = map.width * ts;
  canvas.height = map.height * ts;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      ctx.fillStyle = map.collision[y * map.width + x] ? '#3a3a3a' : '#4c9a4c';
      ctx.fillRect(x * ts, y * ts, ts, ts);
    }
  }
  ctx.font = '14px monospace';
  for (const loc of map.locations) {
    ctx.fillStyle = 'rgba(230, 200, 120, 0.5)';
    ctx.fillRect(loc.area.x * ts, loc.area.y * ts, loc.area.w * ts, loc.area.h * ts);
    ctx.fillStyle = '#000';
    ctx.fillText(loc.name, loc.area.x * ts + 4, loc.area.y * ts + 16);
  }
}

const frames = new Map<string, { x: number; y: number }>();

function onMessage(msg: ServerMessage): void {
  ui.handleMessage(msg);
  if (msg.type === 'hello') {
    map = msg.map;
    for (const v of msg.snapshot.villagers) frames.set(v.id, v.pos);
    draw();
  } else if (msg.type === 'tick') {
    for (const f of msg.villagers) frames.set(f.id, f);
  }
}

// Placeholder hit-testing until the real renderer lands: nearest villager within 1 tile, else a door.
canvas.addEventListener('click', (ev) => {
  if (!map) return;
  // The canvas is letterboxed by object-fit: contain.
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  const left = rect.left + (rect.width - canvas.width * scale) / 2;
  const top = rect.top + (rect.height - canvas.height * scale) / 2;
  const tx = ((ev.clientX - left) / (canvas.width * scale)) * map.width;
  const ty = ((ev.clientY - top) / (canvas.height * scale)) * map.height;
  let best: string | null = null;
  let bestD = 1;
  for (const [id, p] of frames) {
    const d = Math.hypot(p.x + 0.5 - tx, p.y + 0.5 - ty);
    if (d < bestD) [best, bestD] = [id, d];
  }
  if (best) return ui.selectVillager(best);
  const house = map.locations.find(
    (l) => l.door && Math.floor(tx) === l.door.x && Math.floor(ty) === l.door.y,
  );
  if (house) ui.openDoorNote(house.id);
});

let conn: Connection | null = null;
const ui = mountUi(document.querySelector<HTMLElement>('#ui')!, { send: (m) => conn?.send(m) });
conn = connect(onMessage, ui.setConnectionStatus);
