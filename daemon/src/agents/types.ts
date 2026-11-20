import type { ProductPermissionMode } from '../permissions/permission-mode.js';

/**
 * An agent is a reusable *definition*: who does the work and under what
 * constraints. It carries no conversation state — the same agent can sit in
 * many sessions, each with its own thread.
 *
 * Two descriptions, deliberately separate:
 *   - `instructions` is for the agent (its own system prompt; can be long).
 *   - `summary` is for everyone else (≤40 chars; it is what `@` completion shows
 *     and what a room roster injects so peers know who is available).
 * Mixing them into one field forces a choice between "useful to the model" and
 * "readable in a list", and loses both.
 */
export interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  /** ≤40 chars, one line. Empty falls back to `name` at every read site. */
  summary: string;
  avatar: string | null;

  kind: AgentKind;
  /** `kind='runtime'` only. Runtime id from the driver registry. */
  runtime: string | null;
  /** `kind='peer'` only. */
  peerId: string | null;
  remoteAgentId: string | null;

  model: string | null;
  modelParameters: Record<string, string> | null;
  /** Persona / responsibilities, injected into the agent's own system prompt. */
  instructions: string;

  /** Working directory. `null` clears it back to the workspace root. */
  cwd: string | null;
  /** Extra dirs this agent may touch. Every entry must stay inside the workspace. */
  extraDirs: string[];
  readOnly: boolean;
  /** Upper bound on the effective permission mode; the session may only tighten. */
  permissionCeiling: ProductPermissionMode;
  toolsAllow: string[] | null;
  toolsDeny: string[] | null;
  skills: string[] | null;
  budget: AgentBudgetOverride | null;
  /** External-CLI agents: in a room they are only addressed explicitly. */
  heavy: boolean;

  enabled: boolean;
  /** Bumped on every edit; threads snapshot it so drift is diagnosable. */
  version: number;
  /** Seeded by the P0 backfill, not created by a user. */
  isImplicit: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AgentKind = 'builtin' | 'runtime' | 'peer';

export interface AgentBudgetOverride {
  maxSteps?: number;
  maxToolCalls?: number;
}

/** Fields a client may set. Everything else is derived or owned by the store. */
export interface CreateAgentInput {
  workspaceId: string;
  name: string;
  summary?: string;
  avatar?: string | null;
  kind: AgentKind;
  runtime?: string | null;
  peerId?: string | null;
  remoteAgentId?: string | null;
  model?: string | null;
  modelParameters?: Record<string, string> | null;
  instructions?: string;
  cwd?: string | null;
  extraDirs?: string[] | null;
  readOnly?: boolean;
  permissionCeiling?: ProductPermissionMode;
  toolsAllow?: string[] | null;
  toolsDeny?: string[] | null;
  skills?: string[] | null;
  budget?: AgentBudgetOverride | null;
  heavy?: boolean;
  enabled?: boolean;
}

/** Every field optional: an update names only what changes. */
export type UpdateAgentInput = Partial<Omit<CreateAgentInput, 'workspaceId' | 'kind'>>;

/**
 * What a caller needs to start one run for an agent in one session. Kept
 * separate from `Agent` so the execution seam never depends on editable state.
 */
export interface AgentRunTarget {
  agent: Agent;
  /** The agent's context handle for this session (its own conversation). */
  thread: AgentThread;
}

export interface AgentThread {
  id: string;
  sessionId: string;
  agentId: string;
  /** Driver-facing backend id: `builtin` | `claude` | `codex` | `deepseek` | `peer`. */
  backend: string;
  /** The provider's own handle. `null` means "start a fresh conversation". */
  nativeSessionId: string | null;
  nativeThreadId: string | null;
  remoteThreadKey: string | null;
  cwd: string;
  modelSnapshot: string | null;
  /** `agent.version` when this thread was opened. */
  agentVersion: number;
  status: 'idle' | 'running' | 'broken';
  /** Highest room sequence this thread has already seen. */
  lastSeenSeq: number;
  createdAt: number;
  lastUsedAt: number;
}

/** Normalized availability, so the UI needs one shape for all three kinds. */
export interface AgentAvailability {
  /** The definition is enabled. */
  enabled: boolean;
  /** The backing thing can run right now (CLI installed / key present / peer up). */
  online: boolean;
  /** Enabled ∧ online — the only state where `@` may start a run. */
  available: boolean;
  /** Why not, for display. Empty when available. */
  reason?: string;
}
