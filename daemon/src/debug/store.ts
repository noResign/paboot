import type {
  DebugEvent,
  DebugSnapshotKind,
  LiveMemoryRecord,
  LiveRunDetail,
  LiveRunRecord,
  LiveRunStatus,
  LiveRunSummary,
  LiveSnapshot,
} from './types.js';
import { DEBUG_LIMITS } from './types.js';

export interface StartRunInput {
  runId: string;
  sessionId: string;
  workspaceId: string | null;
  runtime: string;
  model: string | null;
  startedAt?: number;
}

export interface FinishRunInput {
  status: LiveRunStatus;
  endedAt?: number;
  error?: string | null;
}

export type NewSnapshot = Omit<LiveSnapshot, 'id' | 'runId' | 'sessionId'>;

/**
 * Process-local store behind `/debug`. Nothing is persisted: the map is the
 * whole record and is dropped when the daemon exits.
 */
export class LiveContextStore {
  private readonly runs = new Map<string, LiveRunRecord>();
  private readonly memory = new Map<string, LiveSnapshot[]>();
  private readonly snapshots = new Map<number, LiveSnapshot>();
  private readonly listeners = new Set<(event: DebugEvent) => void>();
  private readonly maxTotalBytes: number;
  private nextId = 1;
  private totalBytes = 0;

  constructor(options: { maxTotalBytes?: number } = {}) {
    this.maxTotalBytes = Math.max(
      64 * 1024,
      options.maxTotalBytes ?? DEBUG_LIMITS.maxTotalBytes,
    );
  }

  startRun(input: StartRunInput): void {
    const existing = this.runs.get(input.runId);
    if (existing) {
      existing.status = 'running';
      existing.endedAt = null;
      existing.error = null;
      existing.model = input.model;
      return;
    }
    this.runs.set(input.runId, {
      runId: input.runId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      runtime: input.runtime,
      model: input.model,
      status: 'running',
      startedAt: input.startedAt ?? Date.now(),
      endedAt: null,
      error: null,
      injection: null,
      steps: [],
    });
    this.notify({
      type: 'run-started',
      runId: input.runId,
      sessionId: input.sessionId,
      status: 'running',
      createdAt: Date.now(),
    });
  }

  finishRun(runId: string, input: FinishRunInput): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = input.status;
    run.endedAt = input.endedAt ?? Date.now();
    run.error = input.error ?? null;
    this.notify({
      type: 'run-finished',
      runId,
      sessionId: run.sessionId,
      status: run.status,
      createdAt: run.endedAt,
    });
  }

  appendRunSnapshot(runId: string, snapshot: NewSnapshot): LiveSnapshot | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    const stored = this.store(snapshot, runId, run.sessionId);
    if (stored.kind === 'run-injection') {
      if (run.injection) this.deleteSnapshot(run.injection.id);
      run.injection = stored;
    } else {
      run.steps.push(stored);
      if (run.steps.length > DEBUG_LIMITS.maxStepsPerRun) {
        const dropped = run.steps.shift();
        if (dropped) this.deleteSnapshot(dropped.id);
      }
    }
    this.publish(stored);
    return stored;
  }

  /** Memory extraction can arrive after the run ended, so it hangs off the session. */
  appendMemorySnapshot(sessionId: string, snapshot: NewSnapshot): LiveSnapshot {
    const stored = this.store(snapshot, null, sessionId);
    const list = this.memory.get(sessionId) ?? [];
    list.push(stored);
    if (list.length > DEBUG_LIMITS.maxMemorySnapshotsPerSession) {
      const dropped = list.shift();
      if (dropped) this.deleteSnapshot(dropped.id);
    }
    this.memory.set(sessionId, list);
    this.publish(stored);
    return stored;
  }

  listRuns(): LiveRunSummary[] {
    return [...this.runs.values()]
      .map((run) => this.summary(run))
      .sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (b.status === 'running' && a.status !== 'running') return 1;
        return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
      });
  }

  getRun(runId: string): LiveRunDetail | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return { ...this.summary(run), injection: run.injection, steps: [...run.steps] };
  }

  getSessionMemory(sessionId: string): LiveMemoryRecord {
    return { sessionId, snapshots: [...(this.memory.get(sessionId) ?? [])] };
  }

  /** Sessions with captured memory-extraction calls, newest activity first. */
  listMemorySessions(): Array<{ sessionId: string; count: number; lastCreatedAt: number }> {
    return [...this.memory.entries()]
      .map(([sessionId, snapshots]) => ({
        sessionId,
        count: snapshots.length,
        lastCreatedAt: snapshots[snapshots.length - 1]?.createdAt ?? 0,
      }))
      .sort((a, b) => b.lastCreatedAt - a.lastCreatedAt);
  }

  getSnapshot(id: number): LiveSnapshot | null {
    return this.snapshots.get(id) ?? null;
  }

  /** Remove finished runs past the retention window and the finished-run cap. */
  pruneFinished(now: number, keepMs: number, maxFinished = DEBUG_LIMITS.maxFinishedRuns): string[] {
    const removed: string[] = [];
    for (const [runId, run] of this.runs) {
      if (run.status === 'running') continue;
      if (run.endedAt !== null && now - run.endedAt > keepMs) {
        this.removeRun(runId);
        removed.push(runId);
      }
    }
    const finished = [...this.runs.values()]
      .filter((run) => run.status !== 'running')
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    const overflow = finished.length - maxFinished;
    for (let i = 0; i < overflow; i += 1) {
      const run = finished[i];
      if (!run) break;
      this.removeRun(run.runId);
      removed.push(run.runId);
    }
    return removed;
  }

  subscribe(listener: (event: DebugEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscriberCount(): number {
    return this.listeners.size;
  }

  /** Drop everything (used when the last debug client disconnects). */
  clear(): void {
    this.runs.clear();
    this.memory.clear();
    this.snapshots.clear();
    this.totalBytes = 0;
  }

  private removeRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.injection) this.deleteSnapshot(run.injection.id);
    for (const step of run.steps) this.deleteSnapshot(step.id);
    this.runs.delete(runId);
    this.notify({
      type: 'run-removed',
      runId,
      sessionId: run.sessionId,
      createdAt: Date.now(),
    });
  }

  private store(snapshot: NewSnapshot, runId: string | null, sessionId: string): LiveSnapshot {
    const stored: LiveSnapshot = {
      ...snapshot,
      id: this.nextId,
      runId,
      sessionId,
    };
    this.nextId += 1;
    this.snapshots.set(stored.id, stored);
    this.totalBytes += stored.bytes;
    this.evictOverflow();
    return stored;
  }

  private deleteSnapshot(id: number): void {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return;
    this.snapshots.delete(id);
    this.totalBytes = Math.max(0, this.totalBytes - snapshot.bytes);
  }

  /** Keep the whole store under the byte cap by dropping the oldest snapshots. */
  private evictOverflow(): void {
    while (this.totalBytes > this.maxTotalBytes && this.snapshots.size > 0) {
      let oldest = Number.POSITIVE_INFINITY;
      for (const id of this.snapshots.keys()) {
        if (id < oldest) oldest = id;
      }
      if (!Number.isFinite(oldest)) return;
      this.removeSnapshotFromContainers(oldest);
      this.deleteSnapshot(oldest);
    }
  }

  private removeSnapshotFromContainers(id: number): void {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return;
    if (snapshot.runId === null) {
      const list = this.memory.get(snapshot.sessionId);
      if (!list) return;
      const index = list.findIndex((item) => item.id === id);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) this.memory.delete(snapshot.sessionId);
      return;
    }
    const run = this.runs.get(snapshot.runId);
    if (!run) return;
    if (run.injection?.id === id) {
      run.injection = null;
      return;
    }
    const index = run.steps.findIndex((item) => item.id === id);
    if (index >= 0) run.steps.splice(index, 1);
  }

  private publish(snapshot: LiveSnapshot): void {
    this.notify({
      type: 'snapshot',
      runId: snapshot.runId,
      sessionId: snapshot.sessionId,
      kind: snapshot.kind,
      step: snapshot.step,
      snapshotId: snapshot.id,
      bytes: snapshot.bytes,
      truncated: snapshot.truncated,
      createdAt: snapshot.createdAt,
    });
  }

  private notify(event: DebugEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a broken debug subscriber must not affect the run
      }
    }
  }

  private summary(run: LiveRunRecord): LiveRunSummary {
    const lastSnapshotAt = Math.max(
      run.injection?.createdAt ?? 0,
      ...run.steps.map((step) => step.createdAt),
      0,
    );
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      workspaceId: run.workspaceId,
      runtime: run.runtime,
      model: run.model,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      error: run.error,
      snapshotCount: (run.injection ? 1 : 0) + run.steps.length,
      stepCount: run.steps.length,
      lastSnapshotAt: lastSnapshotAt > 0 ? lastSnapshotAt : null,
    };
  }
}
