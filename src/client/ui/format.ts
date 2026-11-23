import type { Memory, MemoryKind, PlanBlock } from '../../shared/types.ts';
import { PLAYER_ID } from '../../shared/types.ts';
import { dayOf, formatClock, minuteOfDay } from '../../shared/time.ts';

export { formatClock };

/** "Day 1" for the first game day (day index 0). */
export function formatDay(t: number): string {
  return `Day ${dayOf(t) + 1}`;
}

/** "today 16:00", "tomorrow 10:00" or "Day 4 16:00", relative to `now`. */
export function formatWhen(t: number, now: number): string {
  const d = dayOf(t) - dayOf(now);
  const day = d === 0 ? 'today' : d === 1 ? 'tomorrow' : formatDay(t);
  return `${day} ${formatClock(t)}`;
}

/** Day vs. night for the HUD dot; matches the renderer's dusk/dawn window. */
export function isNight(t: number): boolean {
  const m = minuteOfDay(t);
  return m >= 19 * 60 || m < 6 * 60;
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US').replace(/,/g, '');
}

const PROVIDER_LABEL: Record<string, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI-compatible API',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  mock: 'mock provider',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

/** Ollama and the mock run on this machine; the others are remote APIs. */
export function isLocalProvider(provider: string, baseUrl?: string): boolean {
  if (provider === 'ollama' || provider === 'mock') return true;
  return !!baseUrl && /\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(baseUrl);
}

const MEMORY_EMOJI: Record<MemoryKind, string> = {
  observation: '👀',
  conversation: '💬',
  heard: '👂',
  reflection: '💭',
  plan: '🗓️',
  note: '📮',
  event: '🎉',
  summary: '📜',
};

export function memoryEmoji(kind: MemoryKind): string {
  return MEMORY_EMOJI[kind] ?? '•';
}

/** Whether a memory is about the player ("KNOWS ABOUT YOU"). */
export function isAboutPlayer(
  m: Pick<Memory, 'text' | 'meta' | 'kind'>,
  playerName: string | undefined,
): boolean {
  if (m.meta.heardFrom === PLAYER_ID || m.meta.toldTo?.includes(PLAYER_ID)) return true;
  if (m.kind === 'note' && m.meta.noteId) return true;
  if (!playerName) return false;
  return m.text.toLowerCase().includes(playerName.toLowerCase());
}

/** Index of the plan block that covers the given minute of day, or -1. */
export function currentBlockIndex(blocks: PlanBlock[], t: number): number {
  const m = minuteOfDay(t);
  return blocks.findIndex((b) => m >= b.start && m < b.end);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
