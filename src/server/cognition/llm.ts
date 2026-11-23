import { createLogger } from '../log.ts';
import { TASK_PRIORITY, type ChatMessage, type LlmQueue, type LlmTask } from '../llm/types.ts';
import { parseJsonLoose } from './json.ts';

const log = createLogger('cognition');

export interface AskSpec<T> {
  task: LlmTask;
  system: string;
  user: string;
  /** Validate/coerce the parsed JSON; return null when unusable. */
  parse: (raw: unknown) => T | null;
  /** Deterministic answer used when the model fails (the sim never stalls). */
  fallback: () => T;
  /** Accept a plain-text answer when no JSON is found (dialogue lines, replies). */
  acceptText?: (text: string) => T | null;
  /** Short JSON example shown in the repair prompt. */
  shape: string;
  meta?: Record<string, unknown>;
  dedupeKey?: string;
  expiresAt?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface AskResult<T> {
  value: T;
  source: 'llm' | 'fallback';
}

/**
 * Ask the queue for a JSON answer: tolerant parse, one repair retry, then the fallback.
 * Never throws.
 */
export async function ask<T>(queue: LlmQueue, spec: AskSpec<T>): Promise<AskResult<T>> {
  const messages: ChatMessage[] = [
    { role: 'system', content: spec.system },
    { role: 'user', content: spec.user },
  ];
  const opts = {
    priority: TASK_PRIORITY[spec.task],
    ...(spec.dedupeKey ? { dedupeKey: spec.dedupeKey } : {}),
    ...(spec.expiresAt !== undefined ? { expiresAt: spec.expiresAt } : {}),
  };
  const base = {
    task: spec.task,
    json: true,
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
    ...(spec.meta ? { meta: spec.meta } : {}),
  };
  let text: string;
  try {
    text = (await queue.enqueue({ ...base, messages }, opts)).text;
  } catch (err) {
    log.debug(`${spec.task}: request failed (${(err as Error).message}); using fallback`);
    return { value: spec.fallback(), source: 'fallback' };
  }
  const first = safeParse(spec, text);
  if (first !== null) return { value: first, source: 'llm' };
  try {
    const repaired = await queue.enqueue(
      {
        ...base,
        temperature: 0,
        messages: [
          ...messages,
          { role: 'assistant', content: text.slice(0, 2000) },
          {
            role: 'user',
            content: `That was not valid. Return ONLY one JSON object, no other text, like:\n${spec.shape}`,
          },
        ],
      },
      { priority: opts.priority },
    );
    const second = safeParse(spec, repaired.text);
    if (second !== null) return { value: second, source: 'llm' };
  } catch (err) {
    log.debug(`${spec.task}: repair request failed (${(err as Error).message})`);
  }
  log.debug(`${spec.task}: unusable model output; using fallback`);
  return { value: spec.fallback(), source: 'fallback' };
}

function safeParse<T>(spec: AskSpec<T>, text: string): T | null {
  const raw = parseJsonLoose(text);
  if (raw === undefined) return spec.acceptText && text.trim() ? spec.acceptText(text.trim()) : null;
  try {
    return spec.parse(raw);
  } catch {
    return null;
  }
}
