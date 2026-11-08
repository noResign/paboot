import type { ModelPrice } from '../../llm/catalog.js';
import type { NormalizedEvent, ProductPermissionMode } from '../../types/api.js';

/**
 * Stable identity of one agent instance. Builtin single-agent sessions use
 * `builtin`; future group-chat roles and subagents get their own ids while
 * sharing the same kernel.
 */
export interface AgentIdentity {
  id: string;
  name: string;
  role?: string;
}

/** Hard ceilings for one agent run. Usage is tracked separately. */
export interface AgentBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxCostUsd?: number;
  /** Wall-clock deadline in epoch milliseconds. */
  deadlineAt?: number;
}

/** Mutable per-run usage accumulated by the kernel. */
export interface AgentBudgetUsage {
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  startedAt: number;
}

export type BudgetExhaustedReason =
  | 'steps'
  | 'tool_calls'
  | 'input_tokens'
  | 'output_tokens'
  | 'cost'
  | 'deadline';

/** Agent profile defaults are resolved by the driver into an effective budget. */
export interface AgentProfile {
  identity: AgentIdentity;
  instructions: string;
  /** `undefined` means all registry tools are visible. */
  allowedTools?: string[];
  /** `undefined` means all discovered skills are visible. */
  allowedSkills?: string[];
  budgetDefaults?: Partial<AgentBudget>;
}

export type WorkspaceFamily = 'dev' | 'life';

/** Logical workspace identity used for context, memory and permissions. */
export interface WorkspaceSnapshot {
  id: string;
  name: string;
  family: WorkspaceFamily;
  /** Canonical primary root. */
  root: string;
}

export type PathCapability = 'read' | 'write' | 'list' | 'execute';

/** One canonical root and the capabilities granted inside it. */
export interface PathGrant {
  root: string;
  capabilities: PathCapability[];
}

export type PathPolicyMode = 'local' | 'server-strict' | 'bypass';

/**
 * Effective filesystem policy for one run. `bypass` intentionally has no
 * root restrictions; only OS permissions and the execution sandbox remain.
 */
export interface ResolvedPathPolicy {
  mode: PathPolicyMode;
  grants: PathGrant[];
  denyRoots: string[];
}

export interface SessionSnapshot {
  id: string;
  workspaceId: string | null;
  agentId: string;
  /** Primary end for end-scoped knowledge; null/absent for workspace scope. */
  endId?: string | null;
  /** Session-level memory policy. Missing means no memory injection. */
  memoryMode?: 'normal' | 'no_injection' | 'off' | string | null;
  /** Internal authoring sessions must never receive memory context. */
  purpose?: string | null;
}

export interface ModelSnapshot {
  provider: string;
  model: string;
  supportsTools: boolean;
  supportsImages: boolean;
  contextWindow?: number;
  maxOutput?: number;
  /** Optional catalog price, for the run-cumulative `costUsd` event field. */
  price?: ModelPrice;
}

export interface ToolPermissionDecision {
  status: 'allowed' | 'denied' | 'timed_out';
  reason?: string | null;
}

export interface ToolPermissionRequest {
  runId: string;
  sessionId?: string;
  toolName: string;
  toolInput: unknown;
}

/** The kernel asks this seam to surface approval requests to the client. */
export interface PermissionBroker {
  request(input: ToolPermissionRequest): Promise<ToolPermissionDecision>;
}

/** Minimal tool description used by prompt compilation and context assembly. */
export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: {
    kind: 'native' | 'mcp' | 'delegate';
    id: string;
  };
  sideEffect: 'read' | 'write' | 'execute' | 'network' | 'control' | 'mcp';
  concurrencySafe: boolean;
  timeoutMs?: number;
}

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  source: 'workspace' | 'user';
  path: string;
  version: string;
  allowedTools?: string[];
}

/** Internal event envelope. Wire mapping drops actor metadata until group chat. */
export type AgentEvent = NormalizedEvent & {
  actorId?: string;
  parentRunId?: string;
};

export interface AgentEventSink {
  emit(event: AgentEvent): void;
}

/**
 * Everything one agent run needs. It deliberately contains no database,
 * Express, MCP client or provider adapter handles.
 */
export interface AgentRunContext {
  runId: string;
  /** Optional because a delegated child agent may not own a paboot session. */
  sessionId?: string;
  /** Parent relationship for future subagent/group-chat runs. */
  parentRunId?: string;
  actor: AgentIdentity;
  workspace: WorkspaceSnapshot;
  /** Immutable working directory for relative paths, Bash and prompt context. */
  cwd: string;
  /**
   * Additional workspace roots. This is a path list only: read/write capability
   * lives in `pathPolicy`, and external runtimes may translate it to --add-dir.
   */
  extraDirs: string[];
  /** Effective filesystem policy; `bypass` intentionally removes root checks. */
  pathPolicy: ResolvedPathPolicy;
  /** Approval behavior; independent from tool visibility and path policy. */
  permissionMode: ProductPermissionMode;
  signal: AbortSignal;
  /** Effective limits for this run, not accumulated usage. */
  budget: AgentBudget;
  eventSink: AgentEventSink;
  permissionBroker: PermissionBroker;
}
