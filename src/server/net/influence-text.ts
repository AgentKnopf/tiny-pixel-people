/**
 * Free-text cleaner for text that reaches villagers' memories and prompts (specs/influence-api-v2.md
 * §5). Line mode (the default) gives one line; paragraph mode keeps line breaks, for letters.
 */

/** C0/C1 controls (line breaks and tabs are mapped first), zero-width, bidi and other invisible format characters. */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
const LINE_BREAKS = /\r\n|[\r\n\u0085\u2028\u2029]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const MAX_LINES = 12;
/**
 * Line starts that a prompt could read as structure: a numbered memory line, a list item, a heading,
 * a quote or a role label such as `System:`. `1. ` becomes `1 - `; the others are removed.
 */
const MARKERS: [RegExp, string][] = [
  [/^(\d{1,3})[.)](?: |$)/, '$1 - '],
  [/^(?:[-*•]|#{1,6}|>)(?: |$)/, ''],
  [/^[A-Za-z ]{1,20}:(?: |$)/, ''],
];

export interface CleanTextOptions {
  /** Keep line breaks (letters): at most 12 lines, one blank line at most between paragraphs. */
  paragraphs?: boolean;
}

export type CleanTextResult =
  { ok: true; text: string } | { ok: false; reason: 'not_string' | 'empty' | 'too_long' };

/**
 * NFC, invisible and control characters removed, whitespace collapsed, `"` to `'`, then the length
 * is checked in UTF-16 code units after cleaning (a line break counts as 1).
 */
export function cleanText(raw: unknown, max: number, opts: CleanTextOptions = {}): CleanTextResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_string' };
  const s = raw.replace(LONE_SURROGATE, '').normalize('NFC').replace(LINE_BREAKS, '\n').replace(/\t/g, ' ');
  const text = (opts.paragraphs ? paragraphs(s) : line(s)).replace(/"/g, "'").normalize('NFC');
  if (text === '') return { ok: false, reason: 'empty' };
  if (text.length > max) return { ok: false, reason: 'too_long' };
  return { ok: true, text };
}

/** Line mode with the influence caps (spec §5). */
export function cleanInfluenceText(raw: unknown, max: number): CleanTextResult {
  return cleanText(raw, max);
}

function collapse(s: string): string {
  return s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

function line(s: string): string {
  return collapse(s.replace(/\n/g, ' '));
}

function unmark(s: string): string {
  // Bounded: each pass shortens the line or leaves it unchanged; "> - System: x" needs three.
  for (let i = 0; i < 8; i++) {
    let next = s;
    for (const [re, to] of MARKERS) next = next.replace(re, to).trim();
    if (next === s) return s;
    s = next;
  }
  return s;
}

function paragraphs(s: string): string {
  const lines: string[] = [];
  for (const raw of s.split('\n')) {
    const l = unmark(collapse(raw));
    if (l === '' && (lines.length === 0 || lines.at(-1) === '')) continue;
    lines.push(l);
  }
  while (lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_LINES) {
    const rest = lines.splice(MAX_LINES - 1).filter((l) => l !== '');
    lines.push(rest.join(' '));
  }
  return lines.join('\n');
}
