import { describe, expect, it } from 'vitest';
import { RunStreamer, type StreamerDeps } from './run-streamer';
import type { ChatStreamSpec, StreamEvent } from '../../shared/ipc';

/** A 200 SSE response whose body is `text`, then closes. */
function sse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function frame(runId: string, seq: number, event: unknown): string {
  return `id: ${seq}\ndata: ${JSON.stringify({ runId, seq, event })}\n\n`;
}

describe('RunStreamer command idempotency', () => {
  // The POST can die after its headers but before the first frame, leaving no
  // run id to resume. With a command id the request can simply be re-sent — the
  // daemon attaches to the run it already started. This must not give up.
  it('resends the chat request with the same commandId when the run id never arrives', async () => {
    const opens: Array<{ path: string; body: unknown }> = [];
    let call = 0;
    const client = {
      open: async (req: { path: string; body?: unknown }) => {
        opens.push({ path: req.path, body: req.body });
        call++;
        // First attempt: headers ok, stream ends immediately with no frames.
        if (call === 1) return sse('');
        // Second attempt: a real run that reaches a terminal frame.
        return sse(
          frame('r-1', 1, { type: 'status', label: 'starting' }) +
            frame('r-1', 2, { type: 'status', label: 'succeeded', terminal: true }),
        );
      },
    } as unknown as StreamerDeps['client'];

    const events: StreamEvent[] = [];
    let onFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      onFinished = resolve;
    });
    const deps: StreamerDeps = {
      client,
      emit: (event) => events.push(event),
      probeRunActive: async () => false,
      fetchEvents: async () => [],
      now: () => 0,
      random: () => 0,
      sleep: async () => {},
      finished: () => onFinished(),
    };

    const spec: ChatStreamSpec = {
      kind: 'chat',
      streamId: 's1',
      connectionId: 'c1',
      sessionId: null,
      prompt: 'hi',
      commandId: 'cmd-1',
    };

    const result = await new RunStreamer('s1', deps).start(spec);
    await finished;

    expect(result.ok).toBe(true);
    // Same chat request re-sent, same command id — re-attached, not duplicated.
    expect(opens.map((o) => o.path)).toEqual(['/api/chat', '/api/chat']);
    expect((opens[1]?.body as { commandId?: string }).commandId).toBe('cmd-1');
    expect(events.some((e) => e.kind === 'done' && e.outcome === 'finished')).toBe(true);
    expect(events.some((e) => e.kind === 'done' && e.outcome === 'giveup')).toBe(false);
  });
});
