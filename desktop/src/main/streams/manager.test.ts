import { describe, expect, it } from 'vitest';
import { StreamManager } from './manager';
import type { DaemonClient } from '../daemon/client';

/**
 * A stream that connects but never answers — a half-open tunnel, a proxy that
 * swallows the response — must not keep the caller waiting forever. `sendTurn`
 * awaits this before it can POST the turn, so a pending start is a composer
 * stuck on "正在发送…" with no way back.
 */

function manager(open: () => Promise<Response>): StreamManager {
  const client = { open } as unknown as DaemonClient;
  return new StreamManager(
    () => client,
    () => {},
    undefined,
    undefined,
    undefined,
    10, // startTimeoutMs
  );
}

const roomSpec = {
  kind: 'room',
  connectionId: 'c1',
  sessionId: 's1',
  streamId: 'stream-1',
  after: null,
} as const;

describe('StreamManager start timeout', () => {
  it('fails a start that never receives headers', async () => {
    const result = await manager(() => new Promise<Response>(() => {})).start(roomSpec);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ apiCode: 'timeout' });
  });

  it('returns at once when the daemon sends headers', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': connected\n\n'));
        controller.close();
      },
    });
    const result = await manager(
      async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ).start(roomSpec);
    expect(result).toMatchObject({ ok: true, streamId: 'stream-1' });
  });
});
