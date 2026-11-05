import type { LlmChunk } from './types.js';

/**
 * Request-time provider failure. Configuration errors keep using `LlmError`;
 * this type carries enough classification for retry and user-facing messages.
 */
export type LlmRequestErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'http'
  | 'network'
  | 'protocol'
  | 'timeout'
  | 'idle_timeout'
  | 'stream_incomplete'
  | 'provider'
  | 'cancelled';

export interface LlmRequestErrorOptions {
  retryable?: boolean;
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class LlmRequestError extends Error {
  readonly code: LlmRequestErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: LlmRequestErrorCode, message: string, options: LlmRequestErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'LlmRequestError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isLlmRequestError(error: unknown): error is LlmRequestError {
  return error instanceof LlmRequestError;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

export function normalizeRequestError(error: unknown, signal?: AbortSignal): LlmRequestError {
  if (error instanceof LlmRequestError) return error;
  if (signal?.aborted || isAbortError(error)) {
    return new LlmRequestError('cancelled', 'model request cancelled', { cause: error });
  }
  if (error instanceof TypeError) {
    return new LlmRequestError('network', error.message, { retryable: true, cause: error });
  }
  return new LlmRequestError(
    'provider',
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

/** Parse Retry-After seconds or HTTP date into milliseconds. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function errorFromResponse(response: Response, body: string): LlmRequestError {
  const message = sanitizeErrorMessage(extractProviderMessage(body) || `${response.status} ${response.statusText}`);
  const status = response.status;
  const code: LlmRequestErrorCode =
    status === 401 || status === 403
      ? 'auth'
      : status === 429
        ? 'rate_limit'
        : status >= 500
          ? 'server'
          : 'http';
  return new LlmRequestError(code, message, {
    status,
    retryable: status === 429 || status >= 500,
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  });
}

export function sanitizeErrorMessage(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

function extractProviderMessage(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed)) {
      const error = parsed['error'];
      if (isRecord(error) && typeof error['message'] === 'string') return error['message'];
      if (typeof parsed['message'] === 'string') return parsed['message'];
    }
  } catch {
    // Fall through to the raw body preview.
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface StreamRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  signal?: AbortSignal;
  /** Injectable for tests. */
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Retry an LLM stream only when it fails before yielding any chunk. Once a
 * text/tool delta escaped, a retry could duplicate model output and is refused.
 */
export async function* withStreamRetry(
  open: () => AsyncIterable<LlmChunk>,
  options: StreamRetryOptions = {},
): AsyncIterable<LlmChunk> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 4_000;
  const jitterMs = options.jitterMs ?? 100;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let emitted = false;
    try {
      for await (const chunk of open()) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (error) {
      const normalized = normalizeRequestError(error, options.signal);
      if (
        emitted ||
        !normalized.retryable ||
        attempt >= maxAttempts ||
        options.signal?.aborted
      ) {
        throw normalized;
      }
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = jitterMs === 0 ? 0 : Math.floor(Math.random() * (jitterMs + 1));
      await sleep(normalized.retryAfterMs ?? backoff + jitter);
      if (options.signal?.aborted) {
        throw new LlmRequestError('cancelled', 'model request cancelled');
      }
    }
  }
}

async function defaultSleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
