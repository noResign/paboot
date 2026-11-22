import { describe, expect, it } from 'vitest';
import { RoomStreamer, type RoomStreamerDeps } from './room-streamer';
import type { RoomStreamSpec, StreamEvent } from '../../shared/ipc';

function frame(runId: string, seq: number, event: unknown): string {
  return `id: ${seq}\ndata: ${JSON.stringify({ runId, seq, event })}\n\n`;
}

describe('RoomStreamer startup', () => {
  it('resolves once headers arrive, without waiting for the long-lived stream to end', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(
          new TextEncoder().encode(
            frame('r1', 1, { type: 'status', label: 'starting', runtime: 'claude' }),
          ),
        );
        // Deliberately stay open: a real room stream runs until the socket dies.
      },
    });
    const client = {
      open: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    } as unknown as RoomStreamerDeps['client'];
    const events: StreamEvent[] = [];
    const streamer = new RoomStreamer('room-1', {
      client,
      emit: (event) => events.push(event),
      sleep: async () => {},
      now: () => 0,
      finished: () => {},
    });
    const spec: RoomStreamSpec = {
      kind: 'room',
      streamId: 'room-1',
      connectionId: 'c1',
      sessionId: 's1',
      after: null,
    };

    const result = await Promise.race([
      streamer.start(spec),
      new Promise<{ ok: 'timeout' }>((resolve) => setTimeout(() => resolve({ ok: 'timeout' }), 100)),
    ]);

    expect(result).toMatchObject({ ok: true, streamId: 'room-1' });
    expect(events.some((event) => event.kind === 'frames')).toBe(true);
    streamer.cancel();
    controller.close();
  });
});
