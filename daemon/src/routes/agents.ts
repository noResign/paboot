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
  resolveSessionAgent,
  sessionRoster,
  setLeader,
  updateAgent,
} from '../agents/index.js';
import type { Agent, AgentAvailability } from '../agents/index.js';
import type { WorkspaceRow } from '../db/db.js';
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
 * The list DTO deliberately omits the mechanism fields (`readOnly`, tool
 * allow/deny, permission ceiling): those are the owner's view of the agent, not
 * something an `@` picker or another member needs. They appear on the detail
 * endpoint, which is the one an editor uses.
 */

/**
 * Shapes below mirror the wire contract in `types/api.ts` — that file is the
 * source of truth (Desktop imports it directly), so the routes only assemble it.
 */
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
    toolsAllow: agent.toolsAllow,
    toolsDeny: agent.toolsDeny,
    skills: agent.skills,
    budget: agent.budget,
    version: agent.version,
    isImplicit: agent.isImplicit,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function sendAgentError(res: Response, err: unknown): void {
  if (err instanceof AgentValidationError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'leader_required' ? 409 : 400;
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
    // Peer probing arrives with the peer module; until then a peer agent is
    // reported as offline rather than optimistically available.
    return { enabled: true, online: false, available: false, reason: 'peer_not_connected' };
  }
  if (agent.kind === 'builtin') {
    return { enabled: true, online: true, available: true };
  }
  const runtime = agent.runtime ?? '';
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
    // Filter *before* probing: indexing availability by the unfiltered list
    // would hand every agent the previous one's online state as soon as a
    // disabled agent is skipped.
    const visible = listAgents(ctx.db, workspace.id).filter(
      (agent) => agent.enabled || req.query.includeDisabled === '1',
    );
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
        toolsAllow: Array.isArray(body.toolsAllow) ? body.toolsAllow.map(String) : null,
        toolsDeny: Array.isArray(body.toolsDeny) ? body.toolsDeny.map(String) : null,
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
        ...(Array.isArray(body.toolsAllow) ? { toolsAllow: body.toolsAllow.map(String) } : {}),
        ...(Array.isArray(body.toolsDeny) ? { toolsDeny: body.toolsDeny.map(String) } : {}),
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
    // Probe the members too: the roster is where the user decides who to @, so
    // "available" must mean the same thing it does in the workspace list.
    const availability = await Promise.all(roster.map((row) => availabilityOf(ctx, row.agent)));
    res.json({
      leaderId: roster.find((row) => row.role === 'leader')?.agent.id ?? null,
      agents: roster.map((row, index) => ({
        ...agentSummaryDto(row.agent, availability[index]!),
        role: row.role,
        // Whether this agent already has its own conversation here — what the
        // "reset conversation" action operates on.
        hasContext: threadCount(threads.get(row.agent.id)),
      })),
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
    if (ctx.db.getSessionLeader(session.id)?.agent_id === req.params.agentId) {
      res.status(409).json({
        error: 'this agent is the room leader; hand the room over first',
        code: 'leader_required',
      });
      return;
    }
    ctx.db.deleteSessionAgent(session.id, req.params.agentId!);
    res.status(204).end();
  });

  app.patch('/api/sessions/:id/leader', (req, res) => {
    const session = ctx.db.getSession(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const body = (req.body ?? {}) as { agentId?: unknown };
    const agentId = typeof body.agentId === 'string' ? body.agentId : '';
    try {
      setLeader(ctx.db, session.id, agentId);
      // `sessions.runtime` mirrors the leader so pre-agent clients stay correct.
      const resolved = resolveSessionAgent(ctx.db, session, ctx.db.getWorkspace(session.workspace_id ?? '') ?? null);
      if (resolved) ctx.db.setSessionRuntime(session.id, resolved.thread.backend);
      res.status(204).end();
    } catch (err) {
      sendAgentError(res, err);
    }
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
    const thread = ctx.db.getAgentThread(session.id, req.params.agentId!);
    if (!thread) {
      res.status(404).json({ error: 'this agent has no conversation in the session', code: 'not_found' });
      return;
    }
    ctx.db.clearAgentThreadByOwner(session.id, req.params.agentId!);
    res.status(204).end();
  });
}

/** `hasContext` means "this agent has a provider conversation here". */
function threadCount(thread: { nativeSessionId: string | null } | undefined): boolean {
  return thread !== undefined && thread.nativeSessionId !== null;
}
