import { RunStreamer } from './run-streamer';
import { SessionStreamer } from './session-streamer';
import { ROUTES } from '../../shared/routes';
import type { DaemonClient } from '../daemon/client';
import type { SseFrame } from '../../shared/contract';
import type { StartStreamResult, StreamCancelInput, StreamEvent, StreamSpec } from '../../shared/ipc';

type Streamer = RunStreamer | SessionStreamer;

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
  ) {}

  async start(spec: StreamSpec): Promise<StartStreamResult> {
    const client = this.getClient(spec.connectionId);
    if (!client) {
      return { ok: false, httpCode: null, apiCode: 'not_connected', message: '尚未连接 daemon' };
    }
    // Chosen by the renderer so it can register the id before any event lands.
    const streamId = spec.streamId;
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
      const result = await streamer.start(spec);
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
    const result = await streamer.start(spec);
    if (!result.ok) {
      this.streams.delete(streamId);
      this.owners.delete(streamId);
    }
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
