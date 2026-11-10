import type { NormalizedEvent } from '../types/api.js';
import type { ProductPermissionMode } from '../permissions/permission-mode.js';
import type { ManagedRun } from './active-runs.js';
import type { RunOutcome } from './engine.js';
import type { RuntimeImageInput, ToolServerSpec } from './types.js';

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
  /** Generic model knobs (e.g. reasoningEffort) passed through to the runtime. */
  modelParameters?: Record<string, string>;
  permissionMode: ProductPermissionMode;
  /** Native session/thread id to resume, if the session already has one. */
  resumeNativeSessionId?: string;
  /**
   * Record the session's native id once the provider confirms the conversation
   * exists: Claude only after its init event, Codex/DeepSeek when the provider
   * reports the thread/session id. Calling it earlier would persist an id that
   * a failed start never created.
   */
  onNativeSessionId: (id: string) => void;
  /** Workspace dirs beyond `cwd` this run may touch. */
  extraDirs?: string[];
  /** Image attachments admitted for this prompt. */
  attachmentIds?: string[];
  /** The same attachments resolved to disk rows, ready for the runtime. */
  images?: RuntimeImageInput[];
  /**
   * Native system-prompt context for runtimes that support one; the driver may
   * ignore it and rely on the caller's prompt prelude instead.
   */
  systemContext?: string;
  /** MCP servers this run may use. The service assembles them once per run. */
  toolServers?: ToolServerSpec[];
  onEvent: (ev: NormalizedEvent) => void;
}

/**
 * The per-runtime execution seam. argv-driven runtimes (Claude) and RPC-driven
 * runtimes (Codex) each provide one; the chat route selects a driver by runtime
 * id and calls `start`, and never branches on the runtime name itself.
 */
export interface RuntimeDriver {
  id: string;
  /**
   * Whether the runtime must be probed for availability before starting. False
   * for internal drivers (the command runner) that have no external CLI.
   */
  requiresDetection?: boolean;
  /**
   * Internal drivers are not exposed through `/api/chat`; only the daemon
   * itself (scheduled command tasks) starts them.
   */
  internal?: boolean;
  start(req: RuntimeDriverRequest): ManagedRun<RunOutcome>;
}
