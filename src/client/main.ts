import type { ServerMessage } from '../shared/protocol.ts';
import { formatClock } from '../shared/time.ts';
import type { WorldMap } from '../shared/types.ts';
import { connect } from './net.ts';

// Skeleton client: draws the collision grid and locations. WP4 replaces this with the real renderer.
const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const ctx = canvas.getContext('2d')!;
const clockEl = document.querySelector<HTMLElement>('#clock')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
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

function onMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'hello':
      map = msg.map;
      clockEl.textContent = formatClock(msg.snapshot.time);
      statusEl.textContent = `connected · ${msg.llm.provider}/${msg.llm.model}`;
      draw();
      break;
    case 'tick':
      clockEl.textContent = formatClock(msg.time);
      break;
    default:
      break;
  }
}

connect(onMessage, (s) => (statusEl.textContent = s));
