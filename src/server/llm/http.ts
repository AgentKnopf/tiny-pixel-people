import { LlmError, isRetryableStatus, parseRetryAfter } from './errors.ts';

export type FetchLike = typeof fetch;

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: FetchLike;
  /** Label used in error messages, e.g. "ollama". */
  label: string;
}

/**
 * Send a JSON request and parse the JSON response, mapping every failure to an `LlmError`
 * (network / timeout / http / parse / aborted). `body === undefined` sends a GET.
 */
export async function requestJson(url: string, body: unknown, opts: HttpOptions): Promise<unknown> {
  const doFetch = opts.fetch ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const method = body === undefined ? 'GET' : 'POST';
  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...opts.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw mapFetchError(err, opts, timeout);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw mapFetchError(err, opts, timeout);
  }
  if (!res.ok) {
    const detail = extractErrorMessage(text);
    throw new LlmError('http', `${opts.label}: HTTP ${res.status}${detail ? ` – ${detail}` : ''}`, {
      status: res.status,
      retryable: isRetryableStatus(res.status),
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new LlmError('parse', `${opts.label}: response is not JSON: ${text.slice(0, 200)}`, {
      cause: err,
    });
  }
}

function mapFetchError(err: unknown, opts: HttpOptions, timeout: AbortSignal): LlmError {
  if (err instanceof LlmError) return err;
  if (opts.signal?.aborted) return new LlmError('aborted', `${opts.label}: request aborted`, { cause: err });
  if (timeout.aborted)
    return new LlmError('timeout', `${opts.label}: no response within ${opts.timeoutMs} ms`, { cause: err });
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const reason = cause?.code ?? cause?.message ?? (err as Error).message;
  return new LlmError('network', `${opts.label}: cannot reach server (${reason})`, { cause: err });
}

/** Pull a readable message out of the usual provider error bodies. */
export function extractErrorMessage(text: string): string {
  if (!text) return '';
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof j.error === 'string') return j.error;
    if (j.error && typeof j.error === 'object') {
      const m = (j.error as { message?: unknown }).message;
      if (typeof m === 'string') return m;
    }
    if (typeof j.message === 'string') return j.message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 300);
}

/** Join a base URL and a path without doubling slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Throw a parse error unless `v` is an array of number arrays. */
export function asVectors(v: unknown, label: string, expected: number): number[][] {
  if (
    !Array.isArray(v) ||
    v.length !== expected ||
    !v.every((row) => Array.isArray(row) && row.every((x) => typeof x === 'number'))
  )
    throw new LlmError('parse', `${label}: expected ${expected} embedding vectors in the response`);
  return v as number[][];
}
