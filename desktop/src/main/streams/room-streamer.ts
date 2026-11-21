import { ROUTES } from '../../shared/routes';
import { LineSplitter, SseParser } from '../../shared/sse-parse';
import type { SseFrame } from '../../shared/contract';
import type { DaemonClient } from '../daemon/client';
import type { RoomStreamSpec, StartStreamResult, StreamEvent } from '../../shared/ipc';

export interface RoomStreamerDeps {
  client: DaemonClient;
  emit(event: StreamEvent): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  finished(): void;
}

/**
 * The room stream: every agent's frames for one session, behind one cursor.
 *
 * Unlike `SessionStreamer` (which carries only "something changed" hints), this
 * one carries the transcript frames themselves. It keeps a cursor so a
 * reconnect resumes instead of re-reading: `after=N` replays what was missed,
 * then the connection goes live. That single number is the reason the daemon
 * multiplexes at all — the alternative is one subscription per live run.
 */
export class RoomStreamer {
  private stopped = false;
  private abort: AbortController | null = null;
  /** Highest room position applied so far; the resume point after a drop. */
  private cursor: number | null = null;

  constructor(
    private readonly streamId: string,
    private readonly deps: RoomStreamerDeps,
  ) {}

  async start(spec: RoomStreamSpec): Promise<StartStreamResult> {
    this.cursor = spec.after;
    const ready = deferred<StartStreamResult>();
    void this.loop(spec, ready).finally(() => this.deps.finished());
    return ready.promise;
  }

  cancel(): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    this.deps.emit({
      streamId: this.streamId,
      kind: 'done',
      outcome: 'cancelled',
      httpCode: null,
      apiCode: null,
      message: null,
    });
  }

  private async loop(spec: RoomStreamSpec, ready: Deferred<StartStreamResult>): Promise<void> {
    let first = true;
    let attempt = 0;

    while (!this.stopped) {
      this.deps.emit({
        streamId: this.streamId,
        kind: 'phase',
        phase: first ? 'connecting' : 'reconnecting',
        attempt,
      });

      const outcome = await this.attempt(spec);
      if (this.stopped) return;

      if (first) {
        first = false;
        if (!outcome.headersOk) {
          // A 404 means the session is gone for good: retrying cannot help.
          ready.resolve({
            ok: false,
            httpCode: outcome.httpCode,
            apiCode: outcome.httpCode === 404 ? 'session_not_found' : null,
            message: outcome.httpCode === 404 ? '会话不存在' : '无法打开房间流',
          });
          return;
        }
        ready.resolve({ ok: true, streamId: this.streamId });
      }

      if (outcome.finished) break;
      // Exponential backoff, capped: a dropped connection should recover in a
      // second or two, not hammer the daemon in a tight loop.
      attempt += 1;
      await this.deps.sleep(Math.min(500 * 2 ** attempt, 8000));
    }

    this.deps.emit({
      streamId: this.streamId,
      kind: 'done',
      outcome: 'settled',
      httpCode: null,
      apiCode: null,
      message: null,
    });
  }

  private async attempt(spec: RoomStreamSpec): Promise<{
    headersOk: boolean;
    httpCode: number | null;
    finished: boolean;
  }> {
    this.abort = new AbortController();
    const query = this.cursor === null ? {} : { after: String(this.cursor) };
    let response: Awaited<ReturnType<DaemonClient['open']>>;
    try {
      response = await this.deps.client.open(
        { method: 'GET', path: ROUTES.sessionStream(spec.sessionId), query },
        this.abort.signal,
      );
    } catch {
      // A network failure is a drop, not a verdict. Retrying is the loop's job;
      // letting it escape would leave `ready` unresolved on the first attempt
      // and hang the caller forever.
      return { headersOk: false, httpCode: -1, finished: this.stopped };
    }
    if (!response.ok) {
      return { headersOk: false, httpCode: response.status, finished: true };
    }

    const reader = response.body?.getReader();
    if (!reader) return { headersOk: true, httpCode: response.status, finished: true };

    const decoder = new TextDecoder();
    const splitter = new LineSplitter();
    const parser = new SseParser();
    // Frames are batched per read chunk: one IPC message per chunk instead of
    // one per token keeps a fast stream from starving the renderer.
    let pending: SseFrame[] = [];

    const handleLine = (line: string): void => {
      const event = parser.feed(line);
      if (!event?.data) return;
      let frame: SseFrame;
      try {
        frame = JSON.parse(event.data) as SseFrame;
      } catch {
        return; // an unknown payload is ignored, not fatal
      }
      if (!frame || typeof frame.seq !== 'number') return;
      // Advance the cursor before emitting: if the emit throws, resuming from
      // the old position would replay this frame, and a duplicated delta is
      // worse than a lost one for a client that applies them.
      if (typeof frame.roomSeq === 'number') this.cursor = frame.roomSeq;
      pending.push(frame);
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of splitter.push(decoder.decode(value, { stream: true }))) {
          handleLine(line);
        }
        if (pending.length > 0) {
          this.deps.emit({ streamId: this.streamId, kind: 'frames', frames: pending });
          pending = [];
        }
      }
      const rest = splitter.flush();
      if (rest !== null) handleLine(rest);
      if (pending.length > 0) {
        this.deps.emit({ streamId: this.streamId, kind: 'frames', frames: pending });
      }
    } catch {
      // Aborted or the socket died; the loop decides whether to reconnect.
    } finally {
      void reader.cancel().catch(() => {});
    }
    return { headersOk: true, httpCode: response.status, finished: false };
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
