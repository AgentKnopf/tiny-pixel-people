import type { VillageEvent, WorldEvent } from '../../shared/types.ts';
import { hashString } from './sprites.ts';

/** Diagonal 1-art-px rain streaks over the visible screen, animated by real time. */
export function drawRain(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  zoom: number,
  now: number,
): void {
  const count = Math.round((w * h) / (zoom * zoom * 260));
  const len = 5 * zoom;
  const speed = 0.35 * zoom; // device px per ms
  ctx.save();
  ctx.strokeStyle = 'rgba(190, 220, 255, 0.55)';
  ctx.lineWidth = Math.max(1, Math.floor(zoom / 2));
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const hx = hashString(`r${i}`);
    const span = h + len * 2;
    const phase = ((hx >>> 8) % 1000) / 1000;
    const y = ((now * speed + phase * span) % span) - len;
    const x = ((hx % 10007) / 10007) * (w + h * 0.3) - y * 0.3;
    ctx.moveTo(x, y);
    ctx.lineTo(x - len * 0.3, y + len);
  }
  ctx.stroke();
  ctx.restore();
}

const CONFETTI = ['#f2c94c', '#e872b8', '#7cc6f2', '#8fd16a', '#f08a4b', '#fffaea'];

/** Confetti falling over a rect (device px), looping every few seconds. */
export function drawConfetti(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  zoom: number,
  now: number,
  seed: string,
): void {
  const n = 40;
  const s = Math.max(2, Math.round(zoom * 1.5));
  for (let i = 0; i < n; i++) {
    const hh = hashString(`${seed}:${i}`);
    const period = 2500 + (hh % 2000);
    const t = ((now + ((hh >>> 6) % period)) % period) / period;
    const x = rect.x + ((hh % 997) / 997) * rect.w + Math.sin(t * 6.28 + i) * 3 * zoom;
    const y = rect.y - 10 * zoom + t * (rect.h + 10 * zoom);
    ctx.globalAlpha = t > 0.85 ? (1 - t) / 0.15 : 1;
    ctx.fillStyle = CONFETTI[i % CONFETTI.length]!;
    ctx.fillRect(Math.round(x), Math.round(y), s, s * (i % 2 === 0 ? 1 : 2));
  }
  ctx.globalAlpha = 1;
}

/** Marker emoji floating over a running event's location. */
export function eventEmoji(ev: Pick<VillageEvent, 'title' | 'description'>): string {
  const s = `${ev.title} ${ev.description}`.toLowerCase();
  if (/birthday/.test(s)) return '🎂';
  if (/bake|cake|pie|bread|cookie/.test(s)) return '🍰';
  if (/party|dance|celebrat/.test(s)) return '🎉';
  if (/music|concert|sing|band/.test(s)) return '🎵';
  if (/picnic/.test(s)) return '🧺';
  if (/market|fair|sale/.test(s)) return '🛍';
  if (/book|read|story/.test(s)) return '📚';
  return '🎪';
}

/** Whether a running village event should rain confetti (parties and birthdays). */
export function isFestive(ev: VillageEvent, worldEvents: Iterable<WorldEvent>): boolean {
  for (const we of worldEvents) {
    if ((we.kind === 'party' || we.kind === 'birthday') && we.data['villageEventId'] === ev.id) return true;
  }
  return /party|birthday|celebrat/i.test(ev.title);
}
