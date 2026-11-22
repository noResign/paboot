import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { AppContext } from '../app/context.js';
import type { EndRow, SessionRow } from '../db/db.js';
import { resolveSessionEndsScope } from '../ends/scope.js';
import { endDto } from './ends.js';
import type { SessionDto, SessionEndsResponse, SessionEvent } from '../types/api.js';
import {
  getDefaultPermissionMode,
  isProductPermissionMode,
  type ProductPermissionMode,
} from '../permissions/permission-mode.js';
import { resolveEffectivePermissionMode } from '../permissions/security-profile.js';
import { sseHeaders } from '../http/sse.js';
import { listActiveRuns } from '../runtimes/active-runs.js';
import { runningRunIdsBySession } from '../runs/session-runs.js';
import { closeSessionRoomStreams } from './room.js';
import { runDto } from '../db/dto.js';
import { resolveWorkspaceForRequest } from '../workspaces/workspace-service.js';
import {
  resolveNewSessionPermissionMode,
  resolveNewSessionRuntime,
} from '../workspaces/workspace-defaults.js';
import { titleFromPrompt } from '../runs/session-title.js';
import {
  isValidModelParameters,
  normalizeModel,
  normalizeModelParameters,
  parseStoredModelParameters,
} from '../db/model-selection.js';
import {
  resolveEffectiveStoredPermissionMode,
} from '../permissions/security-profile.js';

function sessionDto(
  ctx: AppContext,
  s: SessionRow,
  runningRunIds: readonly string[] = [],
  scheduledTaskCount = 0,
): SessionDto {
  const runningRunId = runningRunIds[0] ?? null;
  return {
    id: s.id,
    runtime: s.runtime,
    workspaceId: s.workspace_id,
    permissionMode: resolveEffectiveStoredPermissionMode(
      s.permission_mode,
      ctx.builtinConfig,
    ) as ProductPermissionMode,
    model: s.model,
    modelParameters: parseStoredModelParameters(s.model_parameters),
    cwd: s.cwd,
    title: s.title,
    createdAt: s.created_at,
    lastActiveAt: s.last_active_at,
    running: runningRunId !== null,
    runningRunId,
    runningRunIds: [...runningRunIds],
    scheduledTaskCount,
    purpose: s.purpose ?? null,
    memoryMode: s.memory_mode as SessionDto['memoryMode'],
  };
}

/** Command-task sessions are an internal detail; clients must not see them. */
function visibleSession(ctx: AppContext, id: string): SessionRow | undefined {
  const session = ctx.db.getSession(id);
  return session && session.kind === 'chat' ? session : undefined;
}

export function registerSessionRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/sessions', (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId ? req.query.workspaceId : undefined;
    if (workspaceId && !ctx.db.getWorkspace(workspaceId)) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const running = runningRunIdsBySession(ctx);
    const taskCounts = ctx.db.countScheduledTasksBySession();
    const sessions = ctx.db
      .listSessions(workspaceId)
      .map((s) => sessionDto(ctx, s, running.get(s.id) ?? [], taskCounts.get(s.id) ?? 0));
    res.json({ sessions });
  });

  /**
   * Create a chat session without starting a run.
   *
   * Interactive clients use this once, then drive every message through
   * `/turns` + the room stream. Keeping creation separate makes single-agent
   * sessions use the same send/reconnect path as group rooms.
   */
  app.post('/api/sessions', (req, res) => {
    const body = (req.body ?? {}) as {
      workspaceId?: unknown;
      runtime?: unknown;
      permissionMode?: unknown;
      model?: unknown;
      modelParameters?: unknown;
      title?: unknown;
    };
    if (body.permissionMode !== undefined && !isProductPermissionMode(body.permissionMode)) {
      res.status(400).json({ error: 'permissionMode must be ask, acceptEdits or bypass', code: 'bad_request' });
      return;
    }
    if (body.modelParameters !== undefined && !isValidModelParameters(body.modelParameters)) {
      res.status(400).json({ error: 'modelParameters must be an object or null', code: 'bad_request' });
      return;
    }
    const workspace = resolveWorkspaceForRequest(
      ctx.db,
      typeof body.workspaceId === 'string' && body.workspaceId.trim() ? body.workspaceId.trim() : undefined,
    );
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const requestedRuntime =
      typeof body.runtime === 'string' && body.runtime ? body.runtime : undefined;
    const runtime = resolveNewSessionRuntime(workspace, requestedRuntime);
    const driver = ctx.registry.driver(runtime);
    if (!driver || driver.internal) {
      res.status(400).json({ error: `unknown runtime: ${runtime}`, code: 'unknown_runtime' });
      return;
    }
    const requestedPermissionMode: ProductPermissionMode = isProductPermissionMode(body.permissionMode)
      ? body.permissionMode
      : resolveNewSessionPermissionMode(
          workspace,
          undefined,
          getDefaultPermissionMode(ctx.db, ctx.config),
        );
    const permissionMode = resolveEffectivePermissionMode(requestedPermissionMode, ctx.builtinConfig);
    const model = normalizeModel(body.model);
    const modelParameters =
      body.modelParameters !== undefined ? normalizeModelParameters(body.modelParameters) : null;
    const promptTitle = typeof body.title === 'string' ? body.title : '';
    const session = ctx.db.createSession({
      id: randomUUID(),
      runtime,
      workspaceId: workspace.id,
      permissionMode,
      model,
      modelParameters,
      cwd: workspace.path,
      title: promptTitle.trim() ? titleFromPrompt(promptTitle) : null,
    });
    res.status(201).json({
      session: sessionDto(ctx, session, [], ctx.db.countScheduledTasksForSession(session.id)),
    });
  });

  app.get('/api/sessions/:id', (req, res) => {
    const s = visibleSession(ctx, req.params.id);
    if (!s) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const running = runningRunIdsBySession(ctx);
    const messages = ctx.db.listMessages(s.id);
    const committedByTask = new Map(
      messages
        .filter((row) => row.role === 'assistant' && row.task_id && row.committed_seq !== null)
        .map((row) => [row.task_id!, row.committed_seq!] as const),
    );
    res.json({
      session: sessionDto(ctx, s, running.get(s.id) ?? [], ctx.db.countScheduledTasksForSession(s.id)),
      messages,
      runs: ctx.db.listRuns(s.id).map((r) => ({
        ...runDto(r, ctx.db.getRunCheckpoint(r.id), s.workspace_id),
        answerCommittedSeq: r.task_id ? (committedByTask.get(r.task_id) ?? null) : null,
      })),
    });
  });

  /**
   * Session-scoped hint stream. Used by an open client to notice work started
   * elsewhere (another device) and title changes, without polling. The first
   * event is always a `state` snapshot, so a reconnect never has to guess what
   * it missed; nothing here is persisted.
   */
  app.get('/api/sessions/:id/events', (req, res) => {
    const s = visibleSession(ctx, req.params.id);
    if (!s) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    res.writeHead(200, sseHeaders());
    res.write(': connected\n\n');

    const send = (event: SessionEvent): void => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const running = runningRunIdsBySession(ctx);
    send({
      type: 'state',
      session: sessionDto(ctx, s, running.get(s.id) ?? [], ctx.db.countScheduledTasksForSession(s.id)),
    });

    const unsubscribe = ctx.sessionNotifier.subscribe(s.id, send);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 15_000);
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // Rename a session.
  app.patch('/api/sessions/:id', (req, res) => {
    const s = visibleSession(ctx, req.params.id);
    if (!s) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const body = (req.body ?? {}) as { title?: string };
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      res.status(400).json({ error: 'title is required', code: 'bad_request' });
      return;
    }
    ctx.db.setSessionTitle(s.id, title.slice(0, 200));
    ctx.sessionNotifier.publish(s.id, { type: 'session_updated', sessionId: s.id, title: title.slice(0, 200) });
    ctx.db.audit('rename_session', s.id);
    const running = runningRunIdsBySession(ctx);
    const updated = ctx.db.getSession(s.id) as SessionRow;
    res.json({ ok: true, session: sessionDto(ctx, updated, running.get(s.id) ?? [], ctx.db.countScheduledTasksForSession(updated.id)) });
  });

  // Switch the model used by this session's subsequent runs. An in-flight run
  // keeps the model it already started with; there is nothing to restart.
  app.patch('/api/sessions/:id/model', (req, res) => {
    const s = visibleSession(ctx, req.params.id);
    if (!s) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const body = (req.body ?? {}) as { model?: unknown; modelParameters?: unknown };
    const hasModel = 'model' in body;
    const hasParameters = 'modelParameters' in body;
    if (!hasModel && !hasParameters) {
      res.status(400).json({ error: 'model or modelParameters is required', code: 'bad_request' });
      return;
    }
    if (hasModel && body.model !== null && typeof body.model !== 'string') {
      res.status(400).json({ error: 'model must be a string or null', code: 'bad_request' });
      return;
    }
    if (hasParameters && !isValidModelParameters(body.modelParameters)) {
      res.status(400).json({ error: 'modelParameters must be an object or null', code: 'bad_request' });
      return;
    }
    // Omitted fields keep their current value, so the clients can update the
    // model and its knobs independently.
    const model = hasModel ? normalizeModel(body.model) : normalizeModel(s.model);
    const modelParameters = hasParameters
      ? normalizeModelParameters(body.modelParameters)
      : parseStoredModelParameters(s.model_parameters);
    ctx.db.setSessionModelSelection(s.id, model, modelParameters);
    ctx.db.audit('set_session_model', JSON.stringify({ sessionId: s.id, model, modelParameters }));
    const running = runningRunIdsBySession(ctx);
    const updated = ctx.db.getSession(s.id) as SessionRow;
    res.json({ ok: true, effective: 'next_run', session: sessionDto(ctx, updated, running.get(s.id) ?? [], ctx.db.countScheduledTasksForSession(updated.id)) });
  });

  function sessionEndsPayload(ctx: AppContext, session: SessionRow): SessionEndsResponse {
    const scope = resolveSessionEndsScope(ctx.db, session);
    const rows = ctx.db.listSessionEnds(session.id);
    const activeIds = new Set(scope.ends.map((end) => end.id));
    const reference = rows
      .filter((row) => row.role === 'reference' && !activeIds.has(row.end_id))
      .map((row) => ctx.db.getEnd(row.end_id))
      .filter((end): end is EndRow => !!end && end.workspace_id === session.workspace_id);
    return {
      primaryEndId: scope.primary?.id ?? null,
      ends: [
        ...scope.ends.map((end) => ({ ...endDto(ctx, end), role: 'active' as const })),
        ...reference.map((end) => ({ ...endDto(ctx, end), role: 'reference' as const })),
      ],
    };
  }

  app.get('/api/sessions/:id/ends', (req, res) => {
    const s = visibleSession(ctx, req.params.id);
    if (!s) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    res.json(sessionEndsPayload(ctx, s));
  });

  app.put('/api/sessions/:id/ends', (req, res) => {
    const s = visibleSession(ctx, req.params.id);
    if (!s) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const raw = (req.body ?? {})['endIds'];
    if (raw !== null && raw !== undefined && (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string'))) {
      res.status(400).json({ error: 'endIds must be a string array or null', code: 'bad_request' });
      return;
    }
    // null / [] clears the narrowing and falls back to every active end.
    const endIds = Array.isArray(raw) ? (raw as string[]) : [];
    if (endIds.length > 0) {
      const workspace = s.workspace_id ? ctx.db.getWorkspace(s.workspace_id) : undefined;
      if (!workspace) {
        res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
        return;
      }
      const valid = new Set(
        ctx.db
          .listEnds(workspace.id)
          .filter((end) => end.status === 'active')
          .map((end) => end.id),
      );
      const invalid = endIds.find((id) => !valid.has(id));
      if (invalid) {
        res.status(400).json({ error: `end is not active in this workspace: ${invalid}`, code: 'end_not_allowed' });
        return;
      }
      ctx.db.replaceSessionEnds(s.id, [...new Set(endIds)]);
    } else {
      ctx.db.clearSessionEnds(s.id);
    }
    ctx.db.audit('session_ends', JSON.stringify({ sessionId: s.id, endIds }));
    res.json(sessionEndsPayload(ctx, s));
  });

  // Delete a session, cancelling any in-flight run first so no child process is
  // left orphaned.
  app.delete('/api/sessions/:id', async (req, res) => {
    const s = visibleSession(ctx, req.params.id);
    if (!s) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    for (const active of listActiveRuns()) {
      const row = ctx.db.getRun(active.id);
      if (row && row.session_id === s.id) {
        active.cancel('session deleted');
      }
    }
    await ctx.attachments?.deleteForSession(s.id);
    closeSessionRoomStreams(s.id);
    ctx.db.deleteSession(s.id);
    ctx.permissions.clearSession(s.id);
    ctx.spill?.removeSession(s.id);
    ctx.db.audit('delete_session', s.id);
    res.json({ ok: true, id: s.id });
  });
}
