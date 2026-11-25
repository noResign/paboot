import { randomUUID } from 'node:crypto';
import { backendFor, ensureThread, getAgent } from '../agents/index.js';
import type { AppContext } from '../app/context.js';
import { getActiveRun } from '../runtimes/active-runs.js';
import { startSessionRun, type RunSink } from '../runs/run-service.js';
import { isShareableBackend, PeerValidationError } from './contract.js';
import { getExposure } from './service.js';
import { evaluatePeerTool } from './tool-policy.js';
import type { ExposedAgentContract } from './types.js';

/**
 * A-side peer run orchestration.
 *
 * The hidden session is keyed by the B-generated `threadKey`; the exposed
 * agent's own thread lives inside it, so the remote conversation resumes while
 * the session stays out of the local session list (`purpose='peer'`).
 */
export interface PeerRunRequest {
  /** Caller-allocated so the SSE handler can send `peer_meta` before frame 1. */
  runId: string;
  peerId: string;
  agentId: string;
  clientRunId: string;
  threadKey: string;
  prompt: string;
  contract: ExposedAgentContract;
  /** Attachment ids already saved by the route. */
  attachmentIds?: string[];
  /** Text block built from B's room projection (already bounded by B). */
  roomContext?: string;
}

export interface PeerRunHandle {
  runId: string;
  threadKey: string;
  cwd: string;
  threadResumed: boolean;
  agent: { id: string; name: string };
  done: Promise<void>;
}

/** The system-prompt guardrail for remote runs. Soft by design (see 06-peer §0.4). */
export const PEER_BOUNDARY_PROMPT = [
  '本次会话由远端访客驱动。',
  '不要修改工作区之外的文件；不要读取或输出 ~/.paboot、~/.ssh、API key、token 等敏感内容；',
  '需要写操作前先说明目的。',
].join('\n');

export function startPeerRun(
  ctx: AppContext,
  input: PeerRunRequest,
  sink: RunSink,
): PeerRunHandle {
  const agent = getAgent(ctx.db, input.agentId);
  if (!agent || !agent.enabled) {
    throw new PeerValidationError('agent is disabled', 'agent_disabled', 403);
  }
  if (agent.kind === 'peer') {
    throw new PeerValidationError('a peer agent cannot be exposed again', 'cannot_expose_peer', 400);
  }
  if (!isShareableBackend(agent.kind, agent.runtime)) {
    // Legacy exposures created before this gate must fail closed too.
    throw new PeerValidationError(
      'only builtin and Claude agents can be shared in v1',
      'backend_not_supported',
      403,
    );
  }
  const workspace = ctx.db.getWorkspace(agent.workspaceId);
  if (!workspace) {
    throw new PeerValidationError('workspace not found', 'workspace_missing', 503);
  }
  const driver = ctx.registry.driver(backendFor(agent));
  if (!driver || driver.internal) {
    throw new PeerValidationError(`runtime not available: ${backendFor(agent)}`, 'runtime_unavailable', 503);
  }

  // Reserve before creating a hidden session: otherwise a visitor over quota
  // could keep minting sessions by retrying with fresh threadKeys.
  const release = reservePeerQuota(input.peerId, agent.id, input.contract);
  const runId = input.runId;
  // Re-read the live exposure on every tool call so pausing a share or switching
  // to auto_deny takes effect on runs that are already in flight.
  const peerToolPolicy = (toolName: string, toolInput: unknown) => {
    const live = getExposure(ctx.db, agent.id);
    return evaluatePeerTool({
      enabled: live?.enabled === true,
      approvalPolicy: live?.contract.approvalPolicy ?? input.contract.approvalPolicy,
      dataDir: ctx.config.dataDir ?? '',
      toolName,
      toolInput,
    }).decision;
  };

  let handle: ReturnType<typeof startSessionRun>;
  let located: ReturnType<typeof locatePeerSession>;
  let thread: ReturnType<typeof ensureThread>;
  try {
    located = locatePeerSession(ctx, input, agent.id, workspace.id);
    thread = ensureThread(ctx.db, located.session, agent, workspace);
    handle = startSessionRun(ctx, {
      runId,
      session: located.session,
      workspace,
      prompt: input.prompt,
      driver,
      permissionMode: 'ask',
      model: null,
      trigger: 'peer',
      peerId: input.peerId,
      clientRunId: input.clientRunId,
      ...(ctx.config.dataDir ? { denyRoots: [ctx.config.dataDir] } : {}),
      peerToolPolicy,
      agent,
      thread,
      ...(input.attachmentIds && input.attachmentIds.length > 0
        ? { attachmentIds: input.attachmentIds }
        : {}),
      ...(input.roomContext ? { roomContext: input.roomContext } : {}),
      roomSystem: PEER_BOUNDARY_PROMPT,
      sink,
    });
  } catch (error) {
    release();
    throw error;
  }

  const wallClock = setTimeout(() => {
    getActiveRun(handle.runId)?.cancel('peer wall clock exceeded');
  }, input.contract.quota.maxWallClockMs);
  wallClock.unref();

  const done = handle.done
    .then(() => undefined)
    .finally(() => {
      clearTimeout(wallClock);
      release();
    });

  return {
    runId: handle.runId,
    threadKey: input.threadKey,
    cwd: thread.cwd,
    threadResumed: located.resumed,
    agent: { id: agent.id, name: agent.name },
    done,
  };
}

/** Validate a B-supplied prompt against the per-run input budget (rough 4 chars/token). */
export function assertPeerInputBudget(input: PeerRunRequest): void {
  const estimate = Math.ceil((input.prompt.length + (input.roomContext?.length ?? 0)) / 4);
  if (estimate > input.contract.quota.maxInputTokensPerRun) {
    throw new PeerValidationError(
      `input exceeds the contract limit (${input.contract.quota.maxInputTokensPerRun} tokens)`,
      'peer_quota_exceeded',
      429,
    );
  }
}

function locatePeerSession(
  ctx: AppContext,
  input: PeerRunRequest,
  agentId: string,
  workspaceId: string,
): { session: ReturnType<AppContext['db']['createSession']>; resumed: boolean } {
  const mapping = ctx.db.getPeerThread(input.peerId, input.threadKey);
  if (mapping && mapping.agent_id !== agentId) {
    throw new PeerValidationError(
      'threadKey belongs to a different agent',
      'thread_key_mismatch',
      403,
    );
  }
  if (mapping) {
    const existing = ctx.db.getSession(mapping.session_id);
    if (existing) return { session: existing, resumed: true };
  }
  const agent = ctx.db.getAgent(agentId)!;
  const session = ctx.db.createSession({
    id: `ps_${randomUUID()}`,
    runtime: agent.kind === 'builtin' ? 'builtin' : (agent.runtime ?? 'claude'),
    workspaceId,
    permissionMode: 'ask',
    cwd: agent.cwd ?? ctx.db.getWorkspace(workspaceId)!.path,
    title: `共享运行：${agent.name}`,
    purpose: 'peer',
  });
  if (mapping) {
    ctx.db.setPeerThreadSession(input.peerId, input.threadKey, session.id);
  } else {
    ctx.db.insertPeerThread({
      peer_id: input.peerId,
      thread_key: input.threadKey,
      agent_id: agentId,
      session_id: session.id,
      created_at: Date.now(),
    });
  }
  return { session, resumed: false };
}

// ── quota ────────────────────────────────────────────────────────────────
// Process-local: the daemon is single-instance (fixed data dir + lock), and
// restarting it resets the sliding window, which is acceptable for a personal
// deployment. The contract numbers are enforced here, not just displayed.

const startWindows = new Map<string, number[]>();
const activeRuns = new Map<string, number>();

function reservePeerQuota(
  peerId: string,
  agentId: string,
  contract: ExposedAgentContract,
): () => void {
  const key = `${peerId}:${agentId}`;
  const now = Date.now();
  const window = (startWindows.get(key) ?? []).filter((at) => now - at < 60 * 60 * 1000);
  if (window.length >= contract.quota.runsPerHour) {
    throw new PeerValidationError('peer quota exceeded', 'peer_quota_exceeded', 429);
  }
  const active = activeRuns.get(key) ?? 0;
  if (active >= contract.maxConcurrentRuns) {
    throw new PeerValidationError('peer is busy', 'peer_busy', 409);
  }
  window.push(now);
  startWindows.set(key, window);
  activeRuns.set(key, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (activeRuns.get(key) ?? 1) - 1;
    if (next <= 0) activeRuns.delete(key);
    else activeRuns.set(key, next);
  };
}

/** Test hook: quota state is module-level so a suite can start from zero. */
export function resetPeerQuotaForTests(): void {
  startWindows.clear();
  activeRuns.clear();
}
