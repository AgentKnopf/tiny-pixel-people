export type LlmErrorKind =
  | 'network'
  | 'http'
  | 'timeout'
  | 'parse'
  | 'config'
  /** The job was dropped by the queue before it started (stale `expiresAt`). */
  | 'expired'
  /** The caller aborted the request via its AbortSignal. */
  | 'aborted';

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: LlmErrorKind,
    message: string,
    opts: { status?: number; retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'LlmError';
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable ?? (kind === 'network' || kind === 'timeout');
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** HTTP statuses worth retrying: request timeout, conflict/lock, rate limit, server errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Parse a `retry-after` header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}
