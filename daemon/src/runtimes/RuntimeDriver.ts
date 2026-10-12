import type { NormalizedEvent } from '../types/api.js';
import type { ProductPermissionMode } from '../permission-mode.js';
import type { ManagedRun } from './active-runs.js';
import type { RunOutcome } from './engine.js';

/**
 * One run's inputs, resolved by the chat route without knowing which runtime it
 * is. How these map onto a provider (argv vs. RPC, who picks the native session
 * id) stays inside the driver.
 */
export interface RuntimeDriverRequest {
  runId: string;
  sessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  permissionMode: ProductPermissionMode;
  /** Native session/thread id to resume, if the session already has one. */
  resumeNativeSessionId?: string;
  /**
   * Record the session's native id once it is known. A host-picking runtime
   * (Claude `--session-id`) calls this immediately with an id it generated; a
   * runtime that allocates its own (Codex) calls it when the provider reports
   * the id.
   */
  onNativeSessionId: (id: string) => void;
  /** Workspace dirs beyond `cwd` this run may touch. */
  extraDirs?: string[];
  onEvent: (ev: NormalizedEvent) => void;
}

/**
 * The per-runtime execution seam. argv-driven runtimes (Claude) and RPC-driven
 * runtimes (Codex) each provide one; the chat route selects a driver by runtime
 * id and calls `start`, and never branches on the runtime name itself.
 */
export interface RuntimeDriver {
  id: string;
  start(req: RuntimeDriverRequest): ManagedRun<RunOutcome>;
}
