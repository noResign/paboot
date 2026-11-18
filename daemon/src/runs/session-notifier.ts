import type { SessionEvent } from '../types/api.js';

export type SessionEventListener = (event: SessionEvent) => void;

/**
 * In-process fan-out for session-scoped hints: a run started or finished
 * elsewhere, or the title changed. Nothing is persisted — a subscriber that
 * reconnects gets a fresh `state` snapshot, which is the authoritative answer.
 */
export class SessionNotifier {
  private readonly listeners = new Map<string, Set<SessionEventListener>>();

  subscribe(sessionId: string, listener: SessionEventListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }

  publish(sessionId: string, event: SessionEvent): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // A dead socket must not break the run that is publishing.
      }
    }
  }
}
