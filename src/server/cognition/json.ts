/**
 * Tolerant JSON extraction for small local models: strips code fences and prose, takes the first
 * balanced object/array, repairs common mistakes (trailing commas, smart quotes, single quotes,
 * unquoted keys, Python literals).
 */
import { parseClock } from '../../shared/time.ts';

export function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(cleaned);
  const candidates = [fenced?.[1], cleaned].filter((c): c is string => typeof c === 'string');
  for (const c of candidates) {
    const direct = tryParse(c.trim());
    if (direct !== undefined) return direct;
    const block = firstBalanced(c);
    if (block === null) continue;
    const parsed = tryParse(block) ?? tryParse(repair(block));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function tryParse(s: string): unknown {
  if (!s || (s[0] !== '{' && s[0] !== '[')) return undefined;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

function repair(s: string): string {
  let out = s
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
    .replace(/:\s*True\b/g, ': true')
    .replace(/:\s*False\b/g, ': false')
    .replace(/:\s*None\b/g, ': null');
  // Single-quoted strings -> double-quoted (only when no double quotes are used at all).
  if (!out.includes('"') || /'[^']*'\s*:/.test(out)) {
    out = out.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) => JSON.stringify(inner));
  }
  // Raw newlines inside strings.
  out = out.replace(/"((?:[^"\\]|\\.)*)"/g, (m) => m.replace(/\n/g, '\\n'));
  return out;
}

/** First balanced {...} or [...] in the text, respecting strings. Unclosed blocks are auto-closed. */
export function firstBalanced(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const stack: string[] = [];
  let inStr: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"') inStr = ch;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  // Truncated output (token limit): close what is open.
  if (inStr) return null;
  return text.slice(start).replace(/,\s*$/, '') + stack.reverse().join('');
}

// ---------- lenient field coercion ----------

export function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

export function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /-?\d+(?:\.\d+)?/.exec(v);
    if (m) return Number(m[0]);
  }
  return undefined;
}

export function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    if (/^\s*(true|yes|y|accept(ed)?|1|sure|ok)\b/i.test(v)) return true;
    if (/^\s*(false|no|n|decline(d)?|0|reject(ed)?)\b/i.test(v)) return false;
  }
  return undefined;
}

export function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Case-insensitive key lookup with aliases. */
export function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined;
  for (const k of keys) if (k in obj) return obj[k];
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase());
    if (real !== undefined) return obj[real];
  }
  return undefined;
}

/**
 * Parse a time of day the way small models write it: "09:30", "9:30", "9", "9am", "2:15 PM", 14, 14.5.
 * Returns minute of day, or undefined.
 */
export function parseClockLoose(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v >= 0 && v <= 24) return Math.round(v * 60);
    if (v > 24 && v < 1440) return Math.round(v);
    return undefined;
  }
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  const m = /^(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (!m) {
    try {
      return parseClock(s);
    } catch {
      return undefined;
    }
  }
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.[0];
  if (ampm === 'p' && h < 12) h += 12;
  if (ampm === 'a' && h === 12) h = 0;
  if (h > 24 || min > 59) return undefined;
  return Math.min(1440, h * 60 + min);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
