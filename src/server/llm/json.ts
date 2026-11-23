/**
 * Tolerant JSON parsing and schema-validated LLM calls with a repair retry and a deterministic
 * fallback, so a malformed answer never stalls the simulation. See spec §8.3.
 */
import { z } from 'zod';
import { createLogger } from '../log.ts';
import type { ChatRequest, EnqueueOptions, LlmQueue } from './types.ts';

const log = createLogger('llm.json');

/**
 * Parse JSON from model output: strips `<think>` blocks and code fences, takes the first
 * balanced `{…}` or `[…]`, and removes trailing commas. Returns `undefined` if nothing parses.
 */
export function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const direct = tryParse(cleaned);
  if (direct !== undefined) return direct;
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(cleaned);
  const candidates = fenced?.[1] ? [fenced[1], cleaned] : [cleaned];
  for (const c of candidates) {
    const block = firstBalanced(c);
    if (block === undefined) continue;
    const parsed = tryParse(block) ?? tryParse(block.replace(/,\s*([}\]])/g, '$1'));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

/** First balanced object/array, aware of strings and escapes. */
function firstBalanced(s: string): string | undefined {
  for (let start = 0; start < s.length; start++) {
    const open = s[start];
    if (open !== '{' && open !== '[') continue;
    const stack: string[] = [];
    let inString = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') {
        if (stack.pop() !== ch) break;
        if (stack.length === 0) return s.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

function describeSchema(schema: z.ZodType): string {
  try {
    const js = z.toJSONSchema(schema) as Record<string, unknown>;
    delete js.$schema;
    return JSON.stringify(js);
  } catch {
    return 'the JSON shape described above';
  }
}

export interface AskJsonResult<T> {
  value: T;
  /** 'llm' = valid answer (possibly after repair); 'fallback' = deterministic fallback used. */
  source: 'llm' | 'fallback';
  /** Raw text of the last answer, if any. */
  raw?: string;
}

/**
 * Ask for JSON, validate with zod, try one repair round, then fall back. Never throws for
 * provider or parse errors; the fallback may be a value or a function (called lazily).
 */
export async function askJsonDetailed<T>(
  queue: LlmQueue,
  req: ChatRequest,
  schema: z.ZodType<T>,
  fallback: T | (() => T),
  opts?: EnqueueOptions,
): Promise<AskJsonResult<T>> {
  const fb = (): T => (typeof fallback === 'function' ? (fallback as () => T)() : fallback);
  const request = { ...req, json: req.json ?? true };
  let raw: string;
  try {
    raw = (await queue.enqueue(request, opts)).text;
  } catch (err) {
    log.warn(`${req.task}: ${(err as Error).message}; using fallback`);
    return { value: fb(), source: 'fallback' };
  }
  const first = schema.safeParse(parseJsonLoose(raw));
  if (first.success) return { value: first.data, source: 'llm', raw };

  const repairReq: ChatRequest = {
    ...request,
    messages: [
      ...request.messages,
      { role: 'assistant', content: raw },
      {
        role: 'user',
        content: `That was not valid. Return only valid JSON matching this JSON schema: ${describeSchema(schema)}`,
      },
    ],
  };
  // The repair must not be coalesced with the original job.
  const repairOpts = opts ? { ...opts, dedupeKey: undefined } : undefined;
  try {
    const repaired = (await queue.enqueue(repairReq, repairOpts)).text;
    const second = schema.safeParse(parseJsonLoose(repaired));
    if (second.success) return { value: second.data, source: 'llm', raw: repaired };
    log.warn(
      `${req.task}: invalid JSON after repair (${second.error.issues[0]?.message ?? 'parse error'}); using fallback`,
    );
    return { value: fb(), source: 'fallback', raw: repaired };
  } catch (err) {
    log.warn(`${req.task}: repair failed: ${(err as Error).message}; using fallback`);
    return { value: fb(), source: 'fallback', raw };
  }
}

/** `askJsonDetailed` returning only the value. */
export async function askJson<T>(
  queue: LlmQueue,
  req: ChatRequest,
  schema: z.ZodType<T>,
  fallback: T | (() => T),
  opts?: EnqueueOptions,
): Promise<T> {
  return (await askJsonDetailed(queue, req, schema, fallback, opts)).value;
}
