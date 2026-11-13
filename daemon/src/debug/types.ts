import type { LlmCompletion, LlmMessage, LlmRequest } from '../llm/types.js';
import type { AgentContextAssembly } from '../runtimes/builtin/context/assembly.js';

export const DEBUG_SNAPSHOT_KINDS = [
  'run-injection',
  'builtin-step',
  'memory-extraction',
] as const;

export type DebugSnapshotKind = (typeof DEBUG_SNAPSHOT_KINDS)[number];

/** How paboot's context reached the runtime for this run. */
export type InjectionMode =
  | 'native-system-prompt'
  | 'first-message-prelude'
  | 'skipped-resume'
  | 'none';

export interface PreludeMeta {
  prefix: string;
  used: number;
  overBudget: boolean;
  omitted: number;
}

export interface KnowledgeMeta extends PreludeMeta {
  documents: number;
  indexVersion: string;
}

export interface MemoryBriefMeta extends PreludeMeta {
  claims: number;
  truncated: boolean;
  usedClaimIds: string[];
}

export type RecallDropReason =
  | 'duplicate'
  | 'not_relevant'
  | 'max_items'
  | 'render_rejected'
  | 'feedback_wrong';

export interface RecallDrop {
  kind: 'loop' | 'claim' | 'observation' | 'summary' | 'document' | 'source';
  refId?: string;
  reason: RecallDropReason;
}

export interface RecallMeta extends PreludeMeta {
  hits: number;
  cue: boolean;
  query: string;
  terms: string[];
  dropped: RecallDrop[];
  droppedCount: number;
}

export interface ToolServerSnapshot {
  name: string;
  command: string;
  args: string[];
  /** Env keys are useful for diagnosis; values are always redacted. */
  envKeys: string[];
}

export interface ToolServerLike {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface Redactor {
  text(value: string): string;
  messages(messages: readonly LlmMessage[]): LlmMessage[];
  toolServers(servers: readonly ToolServerLike[]): ToolServerSnapshot[];
}

export interface RunInjectionCaptureInput {
  sessionId: string;
  workspaceId: string | null;
  runId: string;
  runtime: string;
  sessionKind: string;
  purpose: string | null;
  memoryMode: string;
  model: string | null;
  modelParameters: Record<string, string> | null;
  permissionMode: string;
  extraDirs: string[];
  toolServers: readonly ToolServerLike[];
  resumeNativeSession: boolean;
  knowledge: KnowledgeMeta | null;
  memory: MemoryBriefMeta | null;
  recall: RecallMeta | null;
  merged: PreludeMeta | null;
  injectionMode: InjectionMode;
  prompt: string;
  promptSent: string;
  systemContext: string | null;
}

export interface BuiltinStepCaptureInput {
  sessionId: string;
  workspaceId: string | null;
  runId: string;
  step: number;
  provider: string;
  model: string;
  request: LlmRequest;
  assembly: AgentContextAssembly;
  estimatedTokens: number;
  /** Provider wire body (OpenAI/Anthropic), useful when debugging gateways. */
  wireBody?: unknown;
}

export interface MemoryExtractionFailureState {
  consecutiveFailures: number;
  lastError: string;
  lastErrorAt: number | null;
  dead: boolean;
}

/** Result of one builtin model step, merged into its request snapshot. */
export interface BuiltinStepResultInput {
  sessionId: string;
  workspaceId: string | null;
  runId: string;
  step: number;
  status: 'ok' | 'error' | 'cancelled';
  durationMs: number;
  finishReason?: string;
  rawFinishReason?: string;
  usage?: unknown;
  textChars: number;
  reasoningChars: number;
  toolCallCount: number;
  preview?: string;
  error?: { code?: string; message: string };
}

export interface MemoryExtractionCaptureInput {
  batchKey: string;
  attempt: number;
  maxAttempts: number;
  provider: string;
  model: string;
  workspaceId: string | null;
  scope: string;
  sessionId: string | null;
  runId: string | null;
  sourceIds: string[];
  request: LlmRequest;
  completion?: LlmCompletion | null;
  error?: string | null;
  durationMs: number;
  deterministic: boolean;
  willRetry: boolean;
  failureState?: MemoryExtractionFailureState | null;
}

export type DebugOutcomeStatus = 'running' | 'ok' | 'error' | 'cancelled';

/** One stored snapshot. `payload` is already redacted and size-capped. */
export interface LiveSnapshot {
  id: number;
  runId: string | null;
  sessionId: string;
  kind: DebugSnapshotKind;
  step: number | null;
  provider: string | null;
  model: string | null;
  payload: unknown;
  bytes: number;
  truncated: boolean;
  createdAt: number;
  /** Model call / extraction result, so failures are visible without opening it. */
  outcome: DebugOutcomeStatus | null;
  durationMs: number | null;
  error: string | null;
}

export type LiveRunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'rolled_back'
  | 'deleted';

export interface LiveRunRecord {
  runId: string;
  sessionId: string;
  workspaceId: string | null;
  runtime: string;
  model: string | null;
  status: LiveRunStatus;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  injection: LiveSnapshot | null;
  steps: LiveSnapshot[];
}

export interface LiveMemoryRecord {
  sessionId: string;
  snapshots: LiveSnapshot[];
}

export interface LiveRunSummary {
  runId: string;
  sessionId: string;
  workspaceId: string | null;
  runtime: string;
  model: string | null;
  status: LiveRunStatus;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  snapshotCount: number;
  stepCount: number;
  lastSnapshotAt: number | null;
}

export interface LiveRunDetail extends LiveRunSummary {
  injection: LiveSnapshot | null;
  steps: LiveSnapshot[];
}

export interface DebugEvent {
  type: 'run-started' | 'run-finished' | 'run-removed' | 'snapshot' | 'snapshot-updated';
  runId: string | null;
  sessionId: string;
  status?: LiveRunStatus;
  kind?: DebugSnapshotKind;
  step?: number | null;
  snapshotId?: number;
  bytes?: number;
  truncated?: boolean;
  createdAt: number;
}

/** Hard in-memory bounds so a long-running daemon cannot grow without limit. */
export const DEBUG_LIMITS = {
  maxStepsPerRun: 100,
  maxMemorySnapshotsPerSession: 50,
  maxFinishedRuns: 50,
  maxTotalBytes: 32 * 1024 * 1024,
} as const;
