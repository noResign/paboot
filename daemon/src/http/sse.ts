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

/** Write one SSE frame, ignoring writes after the response has ended. */
export function writeSseFrame(res: ServerResponse, frame: SseFrame): void {
  if (res.writableEnded) return;
  try {
    res.write(`id: ${frame.seq}\n`);
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
