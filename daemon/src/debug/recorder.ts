import { log } from '../platform/log.js';
import { setDebugLive, setDebugMode, type DebugMode } from '../platform/debug-flag.js';
import { buildBuiltinStepPayload, buildMemoryExtractionPayload, buildRunInjectionPayload } from './builders.js';
import { encodeSnapshotPayload } from './limits.js';
import { createRedactor } from './redact.js';
import { LiveContextStore, type FinishRunInput, type NewSnapshot, type StartRunInput } from './store.js';
import type {
  BuiltinStepCaptureInput,
  DebugEvent,
  MemoryExtractionCaptureInput,
  Redactor,
  RunInjectionCaptureInput,
} from './types.js';

export interface DebugOptions {
  /** `auto` only captures while at least one debug client is subscribed. */
  mode: DebugMode;
  maxBytes: number;
  maxTotalBytes?: number;
  secrets: readonly string[];
  /** Grace period after the last debug client disconnects before clearing. */
  idleClearMs?: number;
  now?: () => number;
  store?: LiveContextStore;
}

interface EncodedPayload {
  payload: unknown;
  bytes: number;
  truncated: boolean;
}

/**
 * Best-effort in-memory capture behind `/debug`. Every public method swallows
 * its own failures: a broken debug view must never fail a run.
 */
export class DebugRecorder {
  readonly mode: DebugMode;
  readonly store: LiveContextStore;
  private readonly maxBytes: number;
  private readonly idleClearMs: number;
  private readonly redactor: Redactor;
  private readonly now: () => number;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(options: DebugOptions) {
    this.mode = options.mode;
    this.maxBytes = options.maxBytes;
    this.idleClearMs = options.idleClearMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.store =
      options.store ??
      new LiveContextStore({ maxTotalBytes: options.maxTotalBytes });
    this.redactor = createRedactor(options.secrets);
    setDebugMode(options.mode);
    this.syncLiveFlag();
  }

  /** Whether capture is currently writing (auto = a debug client is attached). */
  get active(): boolean {
    if (this.mode === 'off') return false;
    if (this.mode === 'on') return true;
    return this.store.subscriberCount() > 0;
  }

  subscribe(listener: (event: DebugEvent) => void): () => void {
    this.cancelIdleClear();
    const unsubscribe = this.store.subscribe(listener);
    this.syncLiveFlag();
    return () => {
      unsubscribe();
      this.syncLiveFlag();
      if (this.mode === 'auto' && this.store.subscriberCount() === 0) {
        this.scheduleIdleClear();
      }
    };
  }

  startRun(input: Omit<StartRunInput, 'startedAt'>): void {
    if (!this.active) return;
    try {
      this.store.startRun({ ...input, startedAt: this.now() });
    } catch (err) {
      log.warn('debug capture startRun failed', err);
    }
  }

  finishRun(runId: string, input: FinishRunInput): void {
    if (!this.active) return;
    try {
      this.store.finishRun(runId, { ...input, endedAt: input.endedAt ?? this.now() });
    } catch (err) {
      log.warn('debug capture finishRun failed', err);
    }
  }

  recordRunInjection(input: RunInjectionCaptureInput): number | null {
    if (!this.active) return null;
    try {
      this.ensureRun(input.runId, {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        runtime: input.runtime,
        model: input.model,
      });
      const payload = buildRunInjectionPayload(input, this.redactor);
      return this.writeRun(input.runId, {
        kind: 'run-injection',
        step: null,
        provider: null,
        model: input.model,
        ...this.encode(payload),
        createdAt: this.now(),
      });
    } catch (err) {
      log.warn('debug capture run-injection failed', err);
      return null;
    }
  }

  recordBuiltinStep(input: BuiltinStepCaptureInput): number | null {
    if (!this.active) return null;
    try {
      this.ensureRun(input.runId, {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        runtime: 'builtin',
        model: input.model ? `${input.provider}:${input.model}` : null,
      });
      const payload = buildBuiltinStepPayload(input, this.redactor);
      return this.writeRun(input.runId, {
        kind: 'builtin-step',
        step: input.step,
        provider: input.provider,
        model: input.model,
        ...this.encode(payload),
        createdAt: this.now(),
      });
    } catch (err) {
      log.warn('debug capture builtin-step failed', err);
      return null;
    }
  }

  recordMemoryExtraction(input: MemoryExtractionCaptureInput): number | null {
    if (!this.active) return null;
    try {
      const payload = buildMemoryExtractionPayload(input, this.redactor);
      const snapshot = this.store.appendMemorySnapshot(input.sessionId ?? 'unknown', {
        kind: 'memory-extraction',
        step: null,
        provider: input.provider,
        model: input.model,
        ...this.encode(payload),
        createdAt: this.now(),
      });
      return snapshot.id;
    } catch (err) {
      log.warn('debug capture memory-extraction failed', err);
      return null;
    }
  }

  prune(keepMs: number): string[] {
    try {
      return this.store.pruneFinished(this.now(), keepMs);
    } catch (err) {
      log.warn('debug capture prune failed', err);
      return [];
    }
  }

  /** Mirror the subscriber count into the global flag used by other modules. */
  private syncLiveFlag(): void {
    setDebugLive(this.store.subscriberCount() > 0);
  }

  private writeRun(runId: string, snapshot: NewSnapshot): number | null {
    const stored = this.store.appendRunSnapshot(runId, snapshot);
    return stored?.id ?? null;
  }

  /** Capture can start mid-run (page opened late), so create the record on demand. */
  private ensureRun(
    runId: string,
    input: { sessionId: string; workspaceId: string | null; runtime: string; model: string | null },
  ): void {
    if (this.store.getRun(runId)) return;
    this.store.startRun({ runId, ...input, startedAt: this.now() });
  }

  private scheduleIdleClear(): void {
    this.cancelIdleClear();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.mode === 'auto' && this.store.subscriberCount() === 0) this.store.clear();
    }, this.idleClearMs);
    this.idleTimer.unref?.();
  }

  private cancelIdleClear(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private encode(payload: unknown): EncodedPayload {
    const encoded = encodeSnapshotPayload(payload, this.maxBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded.payload) as unknown;
    } catch {
      parsed = { __truncated: true, reason: 'payload was not valid JSON' };
    }
    return { payload: parsed, bytes: encoded.bytes, truncated: encoded.truncated };
  }
}
