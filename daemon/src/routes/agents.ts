import type { Express, Response } from 'express';
import type { AppContext } from '../app/context.js';
import {
  addToSession,
  AgentValidationError,
  assertWritableSlotFree,
  backendFor,
  createAgent,
  getAgent,
  listAgents,
  listThreads,
  MAX_SUMMARY_CHARS,
  removeAgent,
  ROOM_MAX_MEMBERS,
  sessionRoster,
  updateAgent,
} from '../agents/index.js';
import type { Agent, AgentAvailability } from '../agents/index.js';
import { removeExposure } from '../peer/index.js';
import type { AgentTaskRow, WorkspaceRow } from '../db/db.js';
import type { ProductPermissionMode } from '../permissions/permission-mode.js';
import type {
  AgentProfileDetailDto,
  AgentProfileDto,
  SessionAgentDto,
} from '../types/api.js';
import { isProductPermissionMode } from '../permissions/permission-mode.js';

/**
 * Agent CRUD, room membership, and per-agent conversation resets.
 *
 * The list DTO deliberately omits the mechanism fields (`readOnly`, permission
 * ceiling, skills): those are the owner's view of the agent, not something an
 * `@` picker or another member needs. They appear on the detail endpoint, which
 * is the one an editor uses.
 */

/**
 * Shapes below mirror the wire contract in `types/api.ts` — that file is the
 * source of truth (Desktop imports it directly), so the routes only assemble it.
 */
type SessionThread = ReturnType<typeof listThreads>[number];

/**
 * One member as the roster reports it. Shared with the expanded-detail route so
 * the two cannot disagree about `hasContext` or which task is "current".
 */
function sessionAgentEntry(
  ctx: AppContext,
  sessionId: string,
  row: { agent: Agent; role: 'leader' | 'member' },
  thread: SessionThread | undefined,
  task: { id: string; status: 'queued' | 'running' } | null,
  availability: AgentAvailability,
): SessionAgentDto {
  return {
    ...agentSummaryDto(row.agent, availability),
    role: row.role,
    // Whether this agent already has its own conversation here — what the
    // "reset context" action operates on. Builtin (including the implicit
    // builtin runtime agents) keeps its transcript in the native tables, so it
    // has no provider id to look at.
    hasContext:
      threadCount(thread) ||
      ((row.agent.kind === 'builtin' || row.agent.runtime === 'builtin') &&
        ctx.db.hasNativeTranscript(sessionId, row.agent.id)),
    taskStatus: task?.status ?? null,
    taskId: task?.id ?? null,
  };
}

/** A running task wins over a queued one: it is what "stop this agent" means. */
function currentTask(tasks: AgentTaskRow[]): AgentTaskRow | null {
  return tasks.find((task) => task.status === 'running') ?? tasks[0] ?? null;
}

/** The two-state summary the roster field and detail DTO both carry. */
function taskRef(task: AgentTaskRow | null): { id: string; status: 'queued' | 'running' } | null {
  if (!task) return null;
  return { id: task.id, status: task.status === 'running' ? 'running' : 'queued' };
}

function agentSummaryDto(agent: Agent, availability: AgentAvailability): AgentProfileDto {
  return {
    id: agent.id,
    name: agent.name,
    // Empty summary falls back to the name so a picker never renders a blank row.
    summary: agent.summary || agent.name,
    avatar: agent.avatar,
    kind: agent.kind,
    backend: backendFor(agent),
    heavy: agent.heavy,
    enabled: agent.enabled,
    online: availability.online,
    available: availability.available,
  };
}

function agentDetailDto(agent: Agent): AgentProfileDetailDto {
  return {
    ...agentSummaryDto(agent, { enabled: agent.enabled, online: true, available: agent.enabled }),
    workspaceId: agent.workspaceId,
    instructions: agent.instructions,
    model: agent.model,
    modelParameters: agent.modelParameters,
    cwd: agent.cwd,
    extraDirs: agent.extraDirs,
    readOnly: agent.readOnly,
    permissionCeiling: agent.permissionCeiling,
    skills: agent.skills,
    budget: agent.budget,
    peerId: agent.peerId,
    remoteAgentId: agent.remoteAgentId,
    version: agent.version,
    isImplicit: agent.isImplicit,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function sendAgentError(res: Response, err: unknown): void {
  if (err instanceof AgentValidationError) {
    const status =
      err.code === 'not_found'
        ? 404
        : err.code === 'leader_required' || err.code === 'room_full'
          ? 409
          : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'internal_error' });
}

function workspaceOr404(ctx: AppContext, id: string, res: Response): WorkspaceRow | null {
  const workspace = ctx.db.getWorkspace(id);
  if (!workspace) {
    res.status(404).json({ error: `workspace not found: ${id}`, code: 'workspace_not_found' });
    return null;
  }
  return workspace;
}

/**
 * Whether the agent can run right now. Only the runtime kind needs a probe; a
 * builtin agent is available whenever a provider is configured, and a disabled
 * agent is never available regardless of what the CLI says.
 */
async function availabilityOf(ctx: AppContext, agent: Agent): Promise<AgentAvailability> {
  if (!agent.enabled) return { enabled: false, online: false, available: false, reason: 'disabled' };
  if (agent.kind === 'peer') {
    const peer = agent.peerId ? ctx.db.getPeer(agent.peerId) : undefined;
    if (!peer || peer.direction !== 'out' || !peer.token_cipher) {
      return { enabled: true, online: false, available: false, reason: 'peer_not_connected' };
    }
    // No live probe here: the roster must not fan out network calls. A run or
    // manual probe refreshes `last_seen_at`, so five minutes is the same
    // freshness window the connections list uses.
    const online = peer.last_seen_at !== null && Date.now() - peer.last_seen_at < 5 * 60 * 1000;
    return {
      enabled: true,
      online,
      available: online,
      ...(online ? {} : { reason: 'peer_offline' }),
    };
  }
  // Builtin has no executable to probe, but it still needs a configured
  // provider with at least one enabled model. Treat it like any other runtime
  // so the @ picker cannot offer an assistant that is guaranteed to fail.
  const runtime = agent.kind === 'builtin' ? 'builtin' : (agent.runtime ?? '');
  const detection = ctx.registry.detection(runtime) ?? (await ctx.registry.detect(runtime, process.env));
  if (!detection?.available) {
    return { enabled: true, online: false, available: false, reason: detection?.error ?? 'runtime_unavailable' };
  }
  return { enabled: true, online: true, available: true };
}

/**
 * Mounted under `/api/agent-profiles` for the definition resource and
 * `/api/workspaces/:id/agents` for the listing, deliberately *not* under
 * `/api/agents` — that path already means "the runtime plugins we can drive"
 * and overloading it would make `GET /api/agents/claude` ambiguous.
 */
export function registerAgentsRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/workspaces/:id/agents', async (req, res) => {
    const workspace = workspaceOr404(ctx, req.params.id!, res);
    if (!workspace) return;
    // The user's catalogue of assistants, not the daemon's inventory. Implicit
    // agents are the internal stand-ins created for sessions that predate agent
    // definitions; they are not user-authored, so they never appear here.
    // `?includeImplicit=1` exists for diagnostics only.
    //
    // Filter *before* probing: indexing availability by the unfiltered list
    // would hand every agent the previous one's online state as soon as a row
    // is skipped.
    const visible = listAgents(ctx.db, workspace.id)
      .filter((agent) => !agent.isImplicit || req.query.includeImplicit === '1')
      .filter((agent) => agent.enabled || req.query.includeDisabled === '1');
    const availability = await Promise.all(visible.map((agent) => availabilityOf(ctx, agent)));
    res.json({
      agents: visible.map((agent, index) => agentSummaryDto(agent, availability[index]!)),
    });
  });

  app.post('/api/workspaces/:id/agents', (req, res) => {
    const workspace = workspaceOr404(ctx, req.params.id!, res);
    if (!workspace) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const agent = createAgent(ctx.db, workspace, {
        workspaceId: workspace.id,
        name: String(body.name ?? ''),
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        avatar: typeof body.avatar === 'string' ? body.avatar : null,
        kind: body.kind === 'builtin' || body.kind === 'peer' ? body.kind : 'runtime',
        runtime: typeof body.runtime === 'string' ? body.runtime : null,
        peerId: typeof body.peerId === 'string' ? body.peerId : null,
        remoteAgentId: typeof body.remoteAgentId === 'string' ? body.remoteAgentId : null,
        model: typeof body.model === 'string' ? body.model : null,
        modelParameters:
          body.modelParameters && typeof body.modelParameters === 'object'
            ? (body.modelParameters as Record<string, string>)
            : null,
        instructions: typeof body.instructions === 'string' ? body.instructions : '',
        cwd: typeof body.cwd === 'string' ? body.cwd : null,
        extraDirs: Array.isArray(body.extraDirs) ? body.extraDirs.map(String) : null,
        readOnly: body.readOnly === true,
        permissionCeiling: isProductPermissionMode(body.permissionCeiling) ? body.permissionCeiling : undefined,
        skills: Array.isArray(body.skills) ? body.skills.map(String) : null,
        budget:
          body.budget && typeof body.budget === 'object' ? (body.budget as { maxSteps?: number; maxToolCalls?: number }) : null,
        heavy: body.heavy === true,
        enabled: body.enabled !== false,
      });
      res.status(201).json({ agent: agentDetailDto(agent), maxSummaryChars: MAX_SUMMARY_CHARS });
    } catch (err) {
      sendAgentError(res, err);
    }
  });

  app.get('/api/agent-profiles/:id', (req, res) => {
    const agent = getAgent(ctx.db, req.params.id!);
    if (!agent) {
      res.status(404).json({ error: 'agent not found', code: 'not_found' });
      return;
    }
    res.json({ agent: agentDetailDto(agent) });
  });

  app.patch('/api/agent-profiles/:id', (req, res) => {
    const agent = getAgent(ctx.db, req.params.id!);
    if (!agent) {
      res.status(404).json({ error: 'agent not found', code: 'not_found' });
      return;
    }
    const workspace = workspaceOr404(ctx, agent.workspaceId, res);
    if (!workspace) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const updated = updateAgent(ctx.db, workspace, agent.id, {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
        ...(body.avatar === null || typeof body.avatar === 'string' ? { avatar: body.avatar } : {}),
        ...(body.model === null || typeof body.model === 'string' ? { model: body.model } : {}),
        ...(typeof body.instructions === 'string' ? { instructions: body.instructions } : {}),
        ...(body.cwd === null || typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
        ...(Array.isArray(body.extraDirs) ? { extraDirs: body.extraDirs.map(String) } : {}),
        ...(typeof body.readOnly === 'boolean' ? { readOnly: body.readOnly } : {}),
        ...(isProductPermissionMode(body.permissionCeiling)
          ? { permissionCeiling: body.permissionCeiling as ProductPermissionMode }
          : {}),
        ...(Array.isArray(body.skills) ? { skills: body.skills.map(String) } : {}),
        ...(body.modelParameters === null
          ? { modelParameters: null }
          : body.modelParameters && typeof body.modelParameters === 'object'
            ? { modelParameters: body.modelParameters as Record<string, string> }
            : {}),
        ...(body.budget === null
          ? { budget: null }
          : body.budget && typeof body.budget === 'object'
            ? { budget: body.budget as { maxSteps?: number; maxToolCalls?: number } }
            : {}),
        ...(typeof body.heavy === 'boolean' ? { heavy: body.heavy } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      });
      res.json({ agent: agentDetailDto(updated) });
    } catch (err) {
      sendAgentError(res, err);
    }
  });

  app.delete('/api/agent-profiles/:id', (req, res) => {
    try {
      removeAgent(ctx.db, req.params.id!);
      // `agents/` cannot import `peer/`; the composition point does the
      // cross-domain cleanup. A deleted agent must not linger in /peer/info.
      removeExposure(ctx.db, req.params.id!);
      res.status(204).end();
    } catch (err) {
      sendAgentError(res, err);
    }
  });

  // ── room membership ──────────────────────────────────────────────

  app.get('/api/sessions/:id/agents', async (req, res) => {
    const session = ctx.db.getSession(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const roster = sessionRoster(ctx.db, session.id);
    const threads = new Map(listThreads(ctx.db, session.id).map((thread) => [thread.agentId, thread]));
    // Live work per member, so the roster can say "正在回答" instead of only
    // whether the definition exists.
    const tasksByAgent = new Map<string, AgentTaskRow[]>();
    for (const task of ctx.db.listOpenTasks(session.id)) {
      const list = tasksByAgent.get(task.agent_id);
      if (list) list.push(task);
      else tasksByAgent.set(task.agent_id, [task]);
    }
    // Probe the members too: the roster is where the user decides who to @, so
    // "available" must mean the same thing it does in the workspace list.
    const availability = await Promise.all(roster.map((row) => availabilityOf(ctx, row.agent)));
    res.json({
      leaderId: roster.find((row) => row.role === 'leader')?.agent.id ?? null,
      agents: roster.map((row, index) =>
        sessionAgentEntry(
          ctx,
          session.id,
          row,
          threads.get(row.agent.id),
          taskRef(currentTask(tasksByAgent.get(row.agent.id) ?? [])),
          availability[index]!,
        ),
      ),
      // Clients grey out "add" against this instead of guessing the constant.
      capacity: { used: roster.length, max: ROOM_MAX_MEMBERS },
    });
  });

  /** One member's expanded row: current task, last answer, and its conversation. */
  app.get('/api/sessions/:id/agents/:agentId', async (req, res) => {
    const session = ctx.db.getSession(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const roster = sessionRoster(ctx.db, session.id);
    const row = roster.find((entry) => entry.agent.id === req.params.agentId);
    if (!row) {
      // Distinct from the server's generic 404: the client must be able to tell
      // "this member was removed" apart from "this daemon has no such endpoint".
      res
        .status(404)
        .json({ error: 'agent is not a member of this session', code: 'agent_not_in_session' });
      return;
    }
    const thread = listThreads(ctx.db, session.id).find((item) => item.agentId === row.agent.id);
    const task = currentTask(
      ctx.db.listOpenTasks(session.id).filter((item) => item.agent_id === row.agent.id),
    );
    const availability = await availabilityOf(ctx, row.agent);
    const entry = sessionAgentEntry(ctx, session.id, row, thread, taskRef(task), availability);
    const last = ctx.db.lastCommittedMessageForAgent(session.id, row.agent.id);
    const builtin = row.agent.kind === 'builtin' || row.agent.runtime === 'builtin';
    const stats = builtin && thread ? ctx.db.nativeTranscriptStats(thread.id) : null;
    const now = Date.now();
    res.json({
      agent: entry,
      task: task
        ? {
            id: task.id,
            source: task.source,
            status: task.status === 'running' ? 'running' : 'queued',
            createdAt: task.created_at,
            startedAt: task.started_at,
            elapsedMs: Math.max(0, now - (task.started_at ?? task.created_at)),
          }
        : null,
      lastSpoke: last
        ? { messageId: last.id, committedSeq: last.committed_seq, at: last.created_at }
        : null,
      context: {
        cwd: thread?.cwd ?? row.agent.cwd ?? session.cwd ?? null,
        backend: thread?.backend ?? backendFor(row.agent),
        model: thread?.modelSnapshot ?? session.model ?? row.agent.model ?? null,
        messageCount: stats?.messageCount ?? null,
        compactionCount: stats?.compactionCount ?? null,
        lastCompactedAt: stats?.lastCompactedAt ?? null,
      },
    });
  });

  app.post('/api/sessions/:id/agents', (req, res) => {
    const session = ctx.db.getSession(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const body = (req.body ?? {}) as { agentId?: unknown };
    const agentId = typeof body.agentId === 'string' ? body.agentId : '';
    try {
      // The single-writable rule is checked here, at membership time: telling
      // someone "this room already has a writer" while they are saving is a
      // save-time answer, whereas failing a run they just triggered is a shock.
      const agent = getAgent(ctx.db, agentId);
      if (agent) assertWritableSlotFree(ctx.db, session.id, agent);
      addToSession(ctx.db, { id: session.id, workspaceId: session.workspace_id }, agentId);
      res.status(204).end();
    } catch (err) {
      sendAgentError(res, err);
    }
  });

  app.delete('/api/sessions/:id/agents/:agentId', (req, res) => {
    const session = ctx.db.getSession(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    // The leader is fixed when the session is created (choosing the runtime is
    // choosing its agent). There is deliberately no "hand over" API, so the
    // original agent cannot be removed from its own session — start a new one.
    if (ctx.db.getSessionLeader(session.id)?.agent_id === req.params.agentId) {
      res.status(409).json({
        error: 'this agent is the room leader and cannot be removed; start a new session instead',
        code: 'leader_required',
      });
      return;
    }
    ctx.db.deleteSessionAgent(session.id, req.params.agentId!);
    res.status(204).end();
  });

  /**
   * Reset one agent's conversation in this session.
   *
   * This clears paboot's own thread binding only. A runtime may keep its own
   * memory outside paboot (Claude Code stores a per-directory memory), and that
   * is out of reach here — the route name says "reset", not "erase".
   */
  app.post('/api/sessions/:id/agents/:agentId/reset-context', (req, res) => {
    const session = ctx.db.getSession(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const agentId = req.params.agentId!;
    const thread = ctx.db.getAgentThread(session.id, agentId);
    const nativeThread = ctx.db.getNativeThreadForSession(session.id, agentId);
    if (!thread && !nativeThread) {
      res.status(404).json({ error: 'this agent has no conversation in the session', code: 'not_found' });
      return;
    }
    // A live run holds its thread id and keeps appending to the transcript —
    // deleting the thread underneath it would fail the run mid-step. Refuse
    // instead of silently corrupting it.
    const busy =
      ctx.db.listOpenTasks(session.id).some((task) => task.agent_id === agentId) ||
      ctx.db.listRunningRunsForAgent(session.id, agentId).length > 0;
    if (busy) {
      res.status(409).json({
        error: 'this agent is still working; wait for it to finish before resetting',
        code: 'run_in_progress',
      });
      return;
    }
    // Provider-backed runtimes keep a native session id; builtin keeps its own
    // transcript rows. Resetting must clear whichever one exists.
    ctx.db.clearAgentThreadByOwner(session.id, agentId);
    ctx.db.clearNativeTranscriptByOwner(session.id, agentId);
    res.status(204).end();
  });
}

/** `hasContext` means "this agent has a provider conversation here". */
function threadCount(thread: { nativeSessionId: string | null } | undefined): boolean {
  return thread !== undefined && thread.nativeSessionId !== null;
}
