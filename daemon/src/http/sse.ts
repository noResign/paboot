import type { ServerResponse } from 'node:http';
import type { NormalizedEvent, SseFrame } from '../types/api.js';

/** Shared SSE response headers for the live `/api/chat` and replay streams. */
export function sseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

/**
 * Write one SSE frame, ignoring writes after the response has ended.
 *
 * The `id:` is the cursor the client should resume from. On the room stream
 * that is the session-wide `roomSeq`, not the per-run `seq` — a browser
 * `EventSource` auto-reconnect would otherwise send a run position as
 * `Last-Event-ID` and replay the wrong window.
 */
export function writeSseFrame(res: ServerResponse, frame: SseFrame): void {
  if (res.writableEnded) return;
  try {
    res.write(`id: ${frame.roomSeq ?? frame.seq}\n`);
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  } catch {
    // connection already gone — nothing to do
  }
}

/** True for the terminal `status` / `error` events that close a run. */
export function isTerminalEvent(event: NormalizedEvent): boolean {
  return (
    (event.type === 'status' && event.terminal === true) ||
    (event.type === 'error' && event.terminal === true)
  );
}
