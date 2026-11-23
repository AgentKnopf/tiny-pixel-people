export type LlmErrorKind = 'network' | 'http' | 'timeout' | 'parse' | 'config';

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
