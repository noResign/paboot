import { LINE_FLUSH_MS } from './constants';
import { FrameBatcher } from './frame-batcher';
import { ROUTES } from '../../shared/routes';
import { apiErrorOf } from '../../shared/errors';
import {
  backoffMs,
  decide as decideReconnect,
  HEALTHY_ATTEMPT_MS,
  isNonRetryable,
  UNREACHABLE_BUDGET_MS,
  type ReconnectDecision,
} from '../../shared/reconnect';
import { LineSplitter, SseParser } from '../../shared/sse-parse';
import type { NormalizedEvent, SseFrame } from '../../shared/contract';
import type { DaemonClient } from '../daemon/client';
import type { StartStreamResult, StreamEvent, StreamSpec } from '../../shared/ipc';

export interface StreamerDeps {
  client: DaemonClient;
  emit(event: StreamEvent): void;
  /** `GET /api/runs` → is this run still active? null = the probe itself failed. */
  probeRunActive(runId: string): Promise<boolean | null>;
  /** `GET /api/runs/:id/events?after=` → replay; null on failure. */
  fetchEvents(runId: string, after: number | null): Promise<SseFrame[] | null>;
  now(): number;
  random(): number;
  sleep(ms: number): Promise<void>;
  /** Called once the stream is over, however it ended. */
  finished(): void;
}

interface AttemptResult {
  headersOk: boolean;
  httpCode: number | null;
  apiCode: string | null;
  message: string | null;
  frames: number;
  terminal: boolean;
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

/**
 * Owns one run's stream for its whole life: the initial `POST /api/chat` (or a
 * re-attach), the read loop, and every reconnect after that.
 *
 * Living in the main process rather than the renderer is the point: the
 * `?after=` cursor and the `/api/runs` liveness probe both need the token, and
 * a renderer reload must re-attach instead of losing the run. Mirrors
 * `ChatViewModel.startStream` on Android, generation counter included.
 */
export class RunStreamer {
  private gen = 0;
  private stopped = false;
  private abort: AbortController | null = null;
  private runId: string | null = null;
  private lastSeq = -1;

  constructor(
    private readonly streamId: string,
    private readonly deps: StreamerDeps,
  ) {}

  /** The run this stream is attached to, learned from the first frame. */
  get currentRunId(): string | null {
    return this.runId;
  }

  /** Resolves once the first attempt's fate is known (pre-flight errors included). */
  async start(spec: StreamSpec): Promise<StartStreamResult> {
    const gen = ++this.gen;
    const ready = deferred<StartStreamResult>();
    void this.loop(spec, gen, ready).finally(() => this.deps.finished());
    return ready.promise;
  }

  /**
   * Detach. `abortRun` additionally asks the daemon to stop the run — the
   * difference between "I navigated away" and "stop button".
   */
  cancel(abortRun: boolean): void {
    this.stopped = true;
    this.gen++;
    this.abort?.abort();
    this.abort = null;
    this.deps.emit(this.done('cancelled', null, null, null));
    if (abortRun && this.runId) {
      void this.deps.client.request({ method: 'POST', path: ROUTES.runCancel(this.runId), timeoutMs: 5_000 });
    }
  }

  private async loop(spec: StreamSpec, gen: number, ready: Deferred<StartStreamResult>): Promise<void> {
    let current: StreamSpec = spec;
    let after: number | null = spec.kind === 'attach' ? spec.after : null;
    // An attach already knows its run; a new chat learns it from the first frame.
    if (spec.kind === 'attach') this.runId = spec.runId;
    let attempt = 0;
    let unreachableSince: number | null = null;
    let first = true;

    while (!this.stopped && gen === this.gen) {
      this.deps.emit({ streamId: this.streamId, kind: 'phase', phase: 'connecting', attempt });
      const startedAt = this.deps.now();
      const outcome = await this.attempt(current, after, gen, attempt);

      if (this.stopped || gen !== this.gen) return;

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

      // Health is judged on how long the *stream* lived, excluding the probe
      // below — the probe waits on a connection timeout and would skew it.
      const streamMs = this.deps.now() - startedAt;
      const resumable = this.runId;

      // A run id we never learned means the POST died before its first frame.
      // The command id makes that recoverable: re-send the same chat request and
      // the daemon attaches us to the run it already started (or starts one if
      // the first request never landed). Give up only once the daemon has been
      // unreachable past the budget, or the failure is not worth retrying.
      if (!outcome.terminal && resumable === null) {
        const now = this.deps.now();
        unreachableSince = unreachableSince ?? now;
        if (
          isNonRetryable(outcome.httpCode) ||
          now - unreachableSince >= UNREACHABLE_BUDGET_MS
        ) {
          this.deps.emit(this.done('giveup', outcome.httpCode, outcome.apiCode, outcome.message));
          return;
        }
        attempt = outcome.frames > 0 || streamMs > HEALTHY_ATTEMPT_MS ? 0 : attempt + 1;
        this.deps.emit({ streamId: this.streamId, kind: 'phase', phase: 'reconnecting', attempt });
        await this.deps.sleep(backoffMs(attempt, this.deps.random()));
        if (this.stopped || gen !== this.gen) return;
        current = spec;
        continue;
      }

      const probed = outcome.terminal || resumable === null ? null : await this.deps.probeRunActive(resumable);
      if (this.stopped || gen !== this.gen) return;
      const now = this.deps.now();
      unreachableSince = probed === null ? (unreachableSince ?? now) : null;

      const decision: ReconnectDecision = decideReconnect({
        terminal: outcome.terminal,
        httpCode: outcome.httpCode,
        runActive: probed,
        unreachableMs: unreachableSince === null ? 0 : now - unreachableSince,
        attempt,
        jitter: this.deps.random(),
      });

      if (decision.kind === 'finished') {
        this.deps.emit(this.done('finished', null, null, null));
        return;
      }

      if (decision.kind === 'settled') {
        // The run left the daemon (finished, restarted, or cancelled by the
        // watchdog). Its tail usually arrived in the replay above; if this round
        // never connected at all, the missing tail has to be fetched explicitly
        // or the message would be truncated.
        if (!outcome.headersOk && resumable !== null) {
          const events = await this.deps.fetchEvents(resumable, this.lastSeq >= 0 ? this.lastSeq : null);
          if (events) this.emitFrames(events);
        }
        this.deps.emit(this.done('settled', null, null, null));
        return;
      }

      if (decision.kind === 'giveup') {
        this.deps.emit(this.done('giveup', outcome.httpCode, outcome.apiCode, outcome.message));
        return;
      }

      // A round that produced frames or lived past the health threshold resets
      // the backoff; one that died right after connecting lengthens it.
      attempt = outcome.frames > 0 || streamMs > HEALTHY_ATTEMPT_MS ? 0 : attempt + 1;
      this.deps.emit({ streamId: this.streamId, kind: 'phase', phase: 'reconnecting', attempt });
      await this.deps.sleep(decision.delayMs);
      if (this.stopped || gen !== this.gen) return;

      after = this.lastSeq >= 0 ? this.lastSeq : after;
      current = {
        kind: 'attach',
        streamId: this.streamId,
        connectionId: spec.connectionId,
        runId: resumable as string,
        after,
      };
    }
  }

  private async attempt(
    spec: StreamSpec,
    after: number | null,
    gen: number,
    attemptNumber: number,
  ): Promise<AttemptResult> {
    const controller = new AbortController();
    this.abort = controller;
    const batcher = new FrameBatcher();
    const parser = new SseParser();
    const splitter = new LineSplitter();
    let frames = 0;
    let terminal = false;

    const emitBatch = (): void => {
      const batch = batcher.flush();
      if (batch.length) this.deps.emit({ streamId: this.streamId, kind: 'frames', frames: batch });
    };
    const timer = setInterval(emitBatch, LINE_FLUSH_MS);

    const handleData = (data: string): void => {
      if (!data) return;
      let frame: SseFrame;
      try {
        frame = JSON.parse(data) as SseFrame;
      } catch {
        return; // not a frame we understand; ignore rather than kill the stream
      }
      if (!frame || typeof frame.seq !== 'number') return;
      if (frame.runId) this.runId = frame.runId;
      if (frame.seq > this.lastSeq) this.lastSeq = frame.seq;
      frames++;
      // The phase moves to `live` on the first frame of a round, not when the
      // round ends — a reconnect that then streams for minutes must not keep
      // showing the reconnecting banner.
      if (frames === 1) {
        this.deps.emit({ streamId: this.streamId, kind: 'phase', phase: 'live', attempt: attemptNumber });
      }
      if (isTerminal(frame.event)) terminal = true;
      const ready = batcher.push(frame);
      if (ready.length) this.deps.emit({ streamId: this.streamId, kind: 'frames', frames: ready });
    };

    const handleLine = (line: string): void => {
      const event = parser.feed(line);
      if (event?.data) handleData(event.data);
    };

    try {
      const res = await this.open(spec, after, controller.signal);
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok || !contentType.includes('text/event-stream')) {
        const { apiCode, message } = await readError(res);
        return { headersOk: false, httpCode: res.status, apiCode, message, frames: 0, terminal: false };
      }

      const reader = res.body?.getReader();
      if (!reader) {
        return { headersOk: true, httpCode: res.status, apiCode: null, message: null, frames: 0, terminal: false };
      }
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (gen !== this.gen) break;
        for (const line of splitter.push(decoder.decode(value, { stream: true }))) handleLine(line);
      }
      const tail = splitter.flush();
      if (tail !== null) handleLine(tail);
      // A server that ended without a blank line leaves one event unemitted.
      const trailing = parser.flush();
      if (trailing?.data) handleData(trailing.data);

      return { headersOk: true, httpCode: res.status, apiCode: null, message: null, frames, terminal };
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      return {
        headersOk: false,
        httpCode: aborted ? null : -1,
        apiCode: null,
        message: aborted ? '已取消' : (err as Error).message,
        frames,
        terminal,
      };
    } finally {
      clearInterval(timer);
      emitBatch();
      this.abort = null;
    }
  }

  private open(spec: StreamSpec, after: number | null, signal: AbortSignal): Promise<Response> {
    if (spec.kind === 'attach') {
      return this.deps.client.open(
        {
          method: 'GET',
          path: ROUTES.runStream(spec.runId),
          query: { after: after === null ? undefined : after },
        },
        signal,
      );
    }
    return this.deps.client.open(
      {
        method: 'POST',
        path: ROUTES.chat,
        body: {
          sessionId: spec.sessionId ?? undefined,
          prompt: spec.prompt,
          runtime: spec.runtime,
          workspaceId: spec.workspaceId,
          permissionMode: spec.permissionMode,
          claudeSessionId: spec.claudeSessionId,
          commandId: spec.commandId,
        },
      },
      signal,
    );
  }

  private emitFrames(frames: SseFrame[]): void {
    if (!frames.length) return;
    this.deps.emit({ streamId: this.streamId, kind: 'frames', frames });
  }

  private done(
    outcome: 'finished' | 'settled' | 'giveup' | 'cancelled',
    httpCode: number | null,
    apiCode: string | null,
    message: string | null,
  ): StreamEvent {
    return { streamId: this.streamId, kind: 'done', outcome, httpCode, apiCode, message };
  }
}

function isTerminal(event: NormalizedEvent): boolean {
  if (event.type === 'status') return event.terminal === true;
  if (event.type === 'error') return event.terminal === true;
  return false;
}

async function readError(res: Response): Promise<{ apiCode: string | null; message: string | null }> {
  try {
    const text = await res.text();
    if (!text) return { apiCode: null, message: null };
    try {
      return apiErrorOf(JSON.parse(text));
    } catch {
      return { apiCode: null, message: text.slice(0, 300) };
    }
  } catch {
    return { apiCode: null, message: null };
  }
}
