import { LlmRequestError, normalizeRequestError } from './errors.js';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface SseRequestOptions {
  signal: AbortSignal;
  /** Time allowed for fetch to return response headers. */
  connectTimeoutMs?: number;
  /** Time allowed between body chunks. */
  idleTimeoutMs?: number;
  fetch?: FetchLike;
}

/** Small pure SSE frame parser; useful for fragmented and CRLF test fixtures. */
export class SseFrameParser {
  private buffer = '';
  private event = 'message';
  private dataLines: string[] = [];
  private id: string | undefined;
  private retry: number | undefined;

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      const event = this.processLine(line);
      if (event) events.push(event);
      newline = this.buffer.indexOf('\n');
    }
    return events;
  }

  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      const event = this.processLine(this.buffer.replace(/\r$/, ''));
      if (event) events.push(event);
      this.buffer = '';
    }
    const final = this.dispatch();
    if (final) events.push(final);
    return events;
  }

  private processLine(line: string): SseEvent | null {
    if (line.length === 0) return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.event = value || 'message';
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        this.id = value;
        break;
      case 'retry': {
        const retry = Number(value);
        if (Number.isInteger(retry) && retry >= 0) this.retry = retry;
        break;
      }
      default:
        break;
    }
    return null;
  }

  private dispatch(): SseEvent | null {
    if (this.dataLines.length === 0) {
      this.event = 'message';
      this.id = undefined;
      this.retry = undefined;
      return null;
    }
    const event: SseEvent = {
      event: this.event,
      data: this.dataLines.join('\n'),
      ...(this.id === undefined ? {} : { id: this.id }),
      ...(this.retry === undefined ? {} : { retry: this.retry }),
    };
    this.event = 'message';
    this.dataLines = [];
    this.id = undefined;
    this.retry = undefined;
    return event;
  }
}

/** Fetch a streaming endpoint with connect timeout and abort propagation. */
export async function requestSse(
  url: string,
  init: RequestInit,
  options: SseRequestOptions,
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, connectTimeoutMs);
  const onAbort = (): void => controller.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });
  if (options.signal.aborted) controller.abort();

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (options.signal.aborted) {
      throw new LlmRequestError('cancelled', 'model request cancelled', { cause: error });
    }
    if (timedOut) {
      throw new LlmRequestError('timeout', 'model request timed out before headers', {
        retryable: true,
        cause: error,
      });
    }
    throw normalizeRequestError(error, options.signal);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
}

/** Read one SSE response body and yield decoded frames. */
export async function* readSse(
  response: Response,
  options: { signal: AbortSignal; idleTimeoutMs?: number },
): AsyncIterable<SseEvent> {
  if (!response.body) {
    throw new LlmRequestError('protocol', 'provider returned an empty streaming body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseFrameParser();
  const idleTimeoutMs = options.idleTimeoutMs ?? 90_000;
  if (options.signal.aborted) {
    await reader.cancel().catch(() => undefined);
    throw new LlmRequestError('cancelled', 'model request cancelled');
  }
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  options.signal.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const result = await readWithIdleTimeout(reader, idleTimeoutMs, options.signal);
      if (result.done) break;
      for (const event of parser.push(decoder.decode(result.value, { stream: true }))) {
        yield event;
      }
    }
    for (const event of parser.push(decoder.decode())) yield event;
    for (const event of parser.end()) yield event;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw normalizeRequestError(error, options.signal);
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled reader may already be locked while the body settles.
    }
  }
}

interface ReadChunkResult {
  done: boolean;
  value?: Uint8Array;
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ReadChunkResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new LlmRequestError('cancelled', 'model request cancelled'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(
        new LlmRequestError('idle_timeout', `model stream idle for ${timeoutMs}ms`, {
          retryable: true,
        }),
      );
    }, timeoutMs);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LlmRequestError('cancelled', 'model request cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(normalizeRequestError(error, signal));
      },
    );
  });
}
