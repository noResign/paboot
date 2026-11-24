import { RunStreamer } from './run-streamer';
import { RoomStreamer } from './room-streamer';
import { SessionStreamer } from './session-streamer';
import { ROUTES } from '../../shared/routes';
import type { DaemonClient } from '../daemon/client';
import type { SseFrame } from '../../shared/contract';
import type { StartStreamResult, StreamCancelInput, StreamEvent, StreamSpec } from '../../shared/ipc';

type Streamer = RunStreamer | SessionStreamer | RoomStreamer;

/**
 * How long a stream may take to prove it is alive.
 *
 * A streamer resolves only once the daemon's headers arrive. A connection that
 * establishes but never answers (a half-open tunnel, a stuck proxy) leaves that
 * promise pending forever, and the caller — `sendTurn` — has no timeout of its
 * own: the UI sticks on "正在发送…" with no way back. Failing after this long
 * turns that into a retryable error instead.
 */
const START_TIMEOUT_MS = 15_000;

/**
 * Owns every live stream in the main process: run transcripts and the lighter
 * per-session watch. The renderer reloads, HMRs and switches sessions freely;
 * streams survive it and events are pushed by `webContents.send`.
 */
export class StreamManager {
  private readonly streams = new Map<string, Streamer>();
  /** streamId → the connection it belongs to, so a host can be dropped cleanly. */
  private readonly owners = new Map<string, string>();

  constructor(
    private readonly getClient: (connectionId: string) => DaemonClient | null,
    private readonly send: (event: StreamEvent) => void,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly random: () => number = Math.random,
    private readonly now: () => number = Date.now,
    private readonly startTimeoutMs: number = START_TIMEOUT_MS,
  ) {}

  async start(spec: StreamSpec): Promise<StartStreamResult> {
    const client = this.getClient(spec.connectionId);
    if (!client) {
      return { ok: false, httpCode: null, apiCode: 'not_connected', message: '尚未连接 daemon' };
    }
    // Chosen by the renderer so it can register the id before any event lands.
    const streamId = spec.streamId;
    if (spec.kind === 'room') {
      const streamer = new RoomStreamer(streamId, {
        client,
        emit: (event) => this.send(event),
        now: this.now,
        sleep: this.sleep,
        finished: () => {
          this.streams.delete(streamId);
          this.owners.delete(streamId);
        },
      });
      this.streams.set(streamId, streamer);
      this.owners.set(streamId, spec.connectionId);
      const result = await this.awaitReady(() => streamer.start(spec), () => streamer.cancel());
      if (!result.ok) {
        this.streams.delete(streamId);
        this.owners.delete(streamId);
      }
      return result;
    }
    if (spec.kind === 'session') {
      const streamer = new SessionStreamer(streamId, {
        client,
        emit: (event) => this.send(event),
        now: this.now,
        sleep: this.sleep,
        finished: () => {
          this.streams.delete(streamId);
          this.owners.delete(streamId);
        },
      });
      this.streams.set(streamId, streamer);
      this.owners.set(streamId, spec.connectionId);
      const result = await this.awaitReady(() => streamer.start(spec), () => streamer.cancel());
      if (!result.ok) {
        this.streams.delete(streamId);
        this.owners.delete(streamId);
      }
      return result;
    }
    const streamer = new RunStreamer(streamId, {
      client,
      emit: (event) => this.send(event),
      probeRunActive: (runId) => this.probeRunActive(client, runId),
      fetchEvents: (runId, after) => this.fetchEvents(client, runId, after),
      now: this.now,
      random: this.random,
      sleep: this.sleep,
      finished: () => {
        this.streams.delete(streamId);
        this.owners.delete(streamId);
      },
    });
    this.streams.set(streamId, streamer);
    this.owners.set(streamId, spec.connectionId);
    const result = await this.awaitReady(() => streamer.start(spec), () => streamer.cancel(false));
    if (!result.ok) {
      this.streams.delete(streamId);
      this.owners.delete(streamId);
    }
    return result;
  }

  /**
   * Wait for a streamer's first result, but never past `START_TIMEOUT_MS`.
   * On timeout the streamer is cancelled, so a connection that arrives late
   * cannot keep emitting into a stream the renderer already dropped.
   */
  private async awaitReady(
    start: () => Promise<StartStreamResult>,
    cancel: () => void,
  ): Promise<StartStreamResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<StartStreamResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            httpCode: -1,
            apiCode: 'timeout',
            message: '建立连接超时，请重试',
          }),
        this.startTimeoutMs,
      );
    });
    const result = await Promise.race([start(), timeout]);
    clearTimeout(timer);
    if (!result.ok) cancel();
    return result;
  }

  /** Detach one stream; `abortRun` also stops the run on the daemon. */
  cancel(input: StreamCancelInput): void {
    const streamer = this.streams.get(input.streamId);
    if (!streamer) return;
    streamer.cancel(input.abortRun);
    this.streams.delete(input.streamId);
    this.owners.delete(input.streamId);
  }

  /** Detach one host's streams — used when that connection is removed. */
  cancelFor(connectionId: string): void {
    for (const [streamId, owner] of [...this.owners]) {
      if (owner !== connectionId) continue;
      this.streams.get(streamId)?.cancel(false);
      this.streams.delete(streamId);
      this.owners.delete(streamId);
    }
  }

  /** Detach everything without touching any run — used when switching daemons. */
  cancelAll(): void {
    for (const streamer of this.streams.values()) streamer.cancel(false);
    this.streams.clear();
    this.owners.clear();
  }

  private async probeRunActive(client: DaemonClient, runId: string): Promise<boolean | null> {
    const res = await client.request<{ runs: Array<{ id: string }> }>({
      method: 'GET',
      path: ROUTES.runs,
      timeoutMs: 5_000,
    });
    if (!res.ok) return null;
    return (res.data?.runs ?? []).some((run) => run.id === runId);
  }

  private async fetchEvents(client: DaemonClient, runId: string, after: number | null): Promise<SseFrame[] | null> {
    const res = await client.request<{ events: SseFrame[] }>({
      method: 'GET',
      path: ROUTES.runEvents(runId),
      query: { after: after ?? undefined },
      timeoutMs: 10_000,
    });
    if (!res.ok) return null;
    return res.data?.events ?? [];
  }
}
