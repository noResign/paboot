import { ROUTES } from '../../shared/routes';
import { LineSplitter, SseParser } from '../../shared/sse-parse';
import type { SessionEvent } from '../../shared/contract';
import type { DaemonClient } from '../daemon/client';
import type { SessionStreamSpec, StartStreamResult, StreamEvent } from '../../shared/ipc';

export interface SessionStreamerDeps {
  client: DaemonClient;
  emit(event: StreamEvent): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  finished(): void;
}

/**
 * Watches one session for out-of-band hints (a run started on another device,
 * a title generated or renamed elsewhere).
 *
 * No cursor and no replay: the daemon sends a `state` snapshot first on every
 * connection, so reconnecting is just opening the stream again. If the session
 * is gone (404) the watch is over for good.
 */
export class SessionStreamer {
  private stopped = false;
  private abort: AbortController | null = null;

  constructor(
    private readonly streamId: string,
    private readonly deps: SessionStreamerDeps,
  ) {}

  async start(spec: SessionStreamSpec): Promise<StartStreamResult> {
    const ready = deferred<StartStreamResult>();
    void this.loop(spec, ready).finally(() => this.deps.finished());
    return ready.promise;
  }

  /** Session watches never own a run, so `abortRun` is meaningless here. */
  cancel(_abortRun?: boolean): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    this.deps.emit(doneEvent(this.streamId, 'cancelled', null, null, null));
  }

  private async loop(spec: SessionStreamSpec, ready: Deferred<StartStreamResult>): Promise<void> {
    let first = true;
    let attempt = 0;
    let unreachableSince: number | null = null;

    while (!this.stopped) {
      this.deps.emit({ streamId: this.streamId, kind: 'phase', phase: first ? 'connecting' : 'reconnecting', attempt });
      const outcome = await this.attempt(spec);

      if (this.stopped) return;

      if (first) {
        first = false;
        if (!outcome.headersOk) {
          ready.resolve({
            ok: false,
            httpCode: outcome.httpCode,
            apiCode: outcome.apiCode,
            message: outcome.message ?? '请求失败',
          });
          return;
        }
        ready.resolve({ ok: true, streamId: this.streamId });
      }

      if (outcome.notFound) {
        this.deps.emit(doneEvent(this.streamId, 'settled', 404, 'session_not_found', '会话已删除'));
        return;
      }

      const now = this.deps.now();
      unreachableSince = outcome.reached ? null : (unreachableSince ?? now);
      // A stream that actually connected resets the backoff even if it then dropped.
      attempt = outcome.reached ? 0 : attempt + 1;
      if (unreachableSince !== null && now - unreachableSince > 60_000) {
        this.deps.emit(doneEvent(this.streamId, 'giveup', outcome.httpCode, outcome.apiCode, outcome.message));
        return;
      }
      await this.deps.sleep(Math.min(10_000, 1_000 * 2 ** attempt));
    }
  }

  private async attempt(spec: SessionStreamSpec): Promise<AttemptOutcome> {
    const controller = new AbortController();
    this.abort = controller;
    const parser = new SseParser();
    const splitter = new LineSplitter();
    let reached = false;

    const handleLine = (line: string): void => {
      const event = parser.feed(line);
      if (!event?.data) return;
      let sessionEvent: SessionEvent;
      try {
        sessionEvent = JSON.parse(event.data) as SessionEvent;
      } catch {
        return; // unknown payloads are ignored, not fatal
      }
      if (!sessionEvent || typeof sessionEvent.type !== 'string') return;
      this.deps.emit({ streamId: this.streamId, kind: 'session', event: sessionEvent });
    };

    try {
      const res = await this.deps.client.open(
        { method: 'GET', path: ROUTES.sessionEvents(spec.sessionId) },
        controller.signal,
      );
      const contentType = res.headers.get('content-type') ?? '';
      if (res.status === 404) {
        return { headersOk: false, reached: true, notFound: true, httpCode: 404, apiCode: 'session_not_found', message: null };
      }
      if (!res.ok || !contentType.includes('text/event-stream')) {
        return {
          headersOk: false,
          reached: true,
          notFound: false,
          httpCode: res.status,
          apiCode: null,
          message: `HTTP ${res.status}`,
        };
      }
      const reader = res.body?.getReader();
      if (!reader) {
        return { headersOk: true, reached: true, notFound: false, httpCode: res.status, apiCode: null, message: null };
      }
      reached = true;
      let live = false;
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.stopped) break;
        for (const line of splitter.push(decoder.decode(value, { stream: true }))) {
          if (!live) {
            live = true;
            this.deps.emit({ streamId: this.streamId, kind: 'phase', phase: 'live', attempt: 0 });
          }
          handleLine(line);
        }
      }
      const tail = splitter.flush();
      if (tail !== null) handleLine(tail);
      return { headersOk: true, reached, notFound: false, httpCode: res.status, apiCode: null, message: null };
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      return {
        headersOk: false,
        reached,
        notFound: false,
        httpCode: aborted ? null : -1,
        apiCode: null,
        message: aborted ? '已取消' : (err as Error).message,
      };
    } finally {
      this.abort = null;
    }
  }
}

interface AttemptOutcome {
  headersOk: boolean;
  reached: boolean;
  notFound: boolean;
  httpCode: number | null;
  apiCode: string | null;
  message: string | null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function doneEvent(
  streamId: string,
  outcome: 'finished' | 'settled' | 'giveup' | 'cancelled',
  httpCode: number | null,
  apiCode: string | null,
  message: string | null,
): StreamEvent {
  return { streamId, kind: 'done', outcome, httpCode, apiCode, message };
}
