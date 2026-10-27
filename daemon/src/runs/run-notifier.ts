import type { NormalizedEvent, SseFrame } from '../types/api.js';

/** A run's primary event emitter (assigned by the `/api/chat` handler). */
export type SseSender = (ev: NormalizedEvent) => void;

/** A subscriber that receives ready-to-send frames for a run. */
export type FrameListener = (frame: SseFrame) => void;

/**
 * Routes a run's events to everyone who cares about it.
 *
 * Two roles:
 * - **emitter** — the `/api/chat` handler registers its `send` here so
 *   out-of-band events (tool-permission requests) can be injected into the
 *   run's stream with the correct `seq`.
 * - **listeners** — attached viewers (`GET /api/runs/:id/stream`) receive every
 *   frame the run produces, so a phone can (re)attach to an in-flight run and
 *   watch it live, even after the original chat connection dropped.
 */
export class RunNotifier {
  private readonly emitters = new Map<string, SseSender>();
  private readonly listeners = new Map<string, Set<FrameListener>>();

  register(runId: string, send: SseSender): void {
    this.emitters.set(runId, send);
  }

  unregister(runId: string): void {
    this.emitters.delete(runId);
  }

  /** Inject an out-of-band event (e.g. `permission_request`) into a run. */
  emit(runId: string, ev: NormalizedEvent): boolean {
    const send = this.emitters.get(runId);
    if (!send) return false;
    send(ev);
    return true;
  }

  /** Attach a frame listener. Returns an unsubscribe function. */
  subscribe(runId: string, listener: FrameListener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  /** Fan a frame out to every attached listener (not the emitter itself). */
  broadcast(runId: string, frame: SseFrame): void {
    const set = this.listeners.get(runId);
    if (!set) return;
    for (const listener of set) listener(frame);
  }

  subscriberCount(runId: string): number {
    return this.listeners.get(runId)?.size ?? 0;
  }
}
