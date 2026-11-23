import type { Rect } from '../../shared/types.ts';

export type Measure = (text: string) => number;

/**
 * Wrap `text` into at most `maxLines` lines no wider than `maxWidth`; the last line gets `…` when
 * text is cut. Words longer than a line are broken by characters.
 */
export function wrapText(text: string, maxWidth: number, measure: Measure, maxLines = 2): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  let i = 0;
  let truncated = false;
  while (i < words.length) {
    const word = words[i]!;
    const candidate = cur ? `${cur} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      cur = candidate;
      i++;
      continue;
    }
    if (!cur) {
      // Single word wider than the line: hard-break it.
      let cut = word.length - 1;
      while (cut > 1 && measure(word.slice(0, cut)) > maxWidth) cut--;
      lines.push(word.slice(0, cut));
      words[i] = word.slice(cut);
    } else {
      lines.push(cur);
      cur = '';
    }
    if (lines.length === maxLines) {
      truncated = true;
      break;
    }
  }
  if (!truncated && cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    truncated = true;
  }
  if (truncated && lines.length > 0)
    lines[lines.length - 1] = ellipsize(lines[lines.length - 1]!, maxWidth, measure);
  return lines;
}

function ellipsize(line: string, maxWidth: number, measure: Measure): string {
  let s = line;
  while (s.length > 0 && measure(`${s}…`) > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

export interface BubbleBox {
  id: string;
  /** Anchor: the point the tail points at (top of the speaker's head), screen px. */
  ax: number;
  ay: number;
  w: number;
  h: number;
  /** Laid-out box, screen px. */
  x: number;
  y: number;
}

function overlaps(a: Rect, b: Rect, pad: number): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/**
 * Place bubbles centred above their anchors, nudging a bubble up when it would overlap one placed
 * before it, then keep each on screen. Bubbles lower on screen are placed first so the nudged ones
 * stack upward.
 */
export function layoutBubbles(
  boxes: Omit<BubbleBox, 'x' | 'y'>[],
  view: { w: number; h: number },
  gap: number,
  margin = 4,
): BubbleBox[] {
  const sorted = [...boxes].sort((a, b) => b.ay - a.ay);
  const placed: BubbleBox[] = [];
  for (const b of sorted) {
    const box: BubbleBox = { ...b, x: Math.round(b.ax - b.w / 2), y: Math.round(b.ay - gap - b.h) };
    box.x = Math.min(view.w - margin - box.w, Math.max(margin, box.x));
    for (let guard = 0; guard < placed.length + 1; guard++) {
      const hit = placed.find((p) => overlaps(box, p, 1));
      if (!hit) break;
      box.y = hit.y - box.h - 2;
    }
    box.y = Math.max(margin, Math.min(view.h - margin - box.h, box.y));
    placed.push(box);
  }
  return placed;
}

/** Opacity for a bubble `age` ms into its `dur` ms life: fades out over the last 300 ms. */
export function bubbleAlpha(age: number, dur: number, fadeMs = 300): number {
  if (age < 0 || age >= dur) return 0;
  return Math.min(1, (dur - age) / fadeMs);
}
