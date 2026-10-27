import type { Express, Response } from 'express';
import type { AppContext } from '../context.js';
import type { RunRow, SessionRow, WorkspaceRow } from '../db.js';
import {
  MAX_NAME_CHARS,
  MAX_PROMPT_CHARS,
  insertAiTaskOnSession,
  insertNewAiTask,
  parseSchedule,
  scheduledTaskDto,
} from './scheduled-tasks.js';
import { normalizeModel } from '../model-selection.js';
import { workspaceContains } from '../workspace-service.js';

/**
 * Agent-facing endpoints behind the `paboot_tasks` MCP server. The agent only
 * ever sends its run id; session/workspace are resolved server-side, so a
 * prompt-injected agent cannot reach another workspace. Task listing/cancel are
 * workspace-scoped, matching what the client shows in its tasks tab.
 */

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: message, code });
}

function resolveScope(
  ctx: AppContext,
  runId: unknown,
): { ok: true; run: RunRow; session: SessionRow; workspace: WorkspaceRow } | { ok: false; status: number; code: string; message: string } {
  if (typeof runId !== 'string' || !runId) {
    return { ok: false, status: 400, code: 'bad_request', message: 'runId is required' };
  }
  const run = ctx.db.getRun(runId);
  if (!run) return { ok: false, status: 404, code: 'run_not_found', message: 'run not found' };
  const session = ctx.db.getSession(run.session_id);
  if (!session || session.kind !== 'chat') {
    return { ok: false, status: 404, code: 'session_not_found', message: 'session not found' };
  }
  const workspace = ctx.db.getWorkspace(session.workspace_id ?? '');
  if (!workspace) {
    return { ok: false, status: 404, code: 'workspace_not_found', message: 'workspace not found' };
  }
  return { ok: true, run, session, workspace };
}

export function registerMcpTaskRoutes(app: Express, ctx: AppContext): void {
  app.post('/api/internal/mcp/schedule-task', (req, res) => {
    const body = (req.body ?? {}) as {
      runId?: string;
      name?: unknown;
      prompt?: unknown;
      schedule?: unknown;
      target?: { mode?: string; sessionId?: string; runtime?: string };
    };
    const scope = resolveScope(ctx, body.runId);
    if (!scope.ok) {
      sendError(res, scope.status, scope.code, scope.message);
      return;
    }
    if (scope.run.trigger === 'scheduled') {
      sendError(res, 409, 'recursion_blocked', 'a scheduled run cannot create another scheduled task');
      return;
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_NAME_CHARS) {
      sendError(res, 400, 'bad_request', `name is required (max ${MAX_NAME_CHARS} chars)`);
      return;
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
      sendError(res, 400, 'bad_request', `prompt is required (max ${MAX_PROMPT_CHARS} chars)`);
      return;
    }
    const parsed = parseSchedule(body.schedule);
    if (!parsed.ok) {
      sendError(res, 400, 'schedule_invalid', parsed.message);
      return;
    }

    const target = body.target ?? { mode: 'current' };
    const targetMode = target.mode === 'existing' || target.mode === 'new' ? target.mode : 'current';
    let result: ReturnType<typeof insertAiTaskOnSession> | ReturnType<typeof insertNewAiTask>;
    if (targetMode === 'new') {
      const runtime =
        typeof target.runtime === 'string' && target.runtime ? target.runtime : scope.session.runtime;
      const driver = ctx.registry.driver(runtime);
      if (!driver || driver.internal) {
        sendError(res, 400, 'unknown_runtime', `unknown runtime: ${runtime}`);
        return;
      }
      result = insertNewAiTask(ctx, {
        workspace: scope.workspace,
        runtime,
        model: normalizeModel(scope.session.model) ?? null,
        name,
        prompt,
        schedule: parsed.schedule,
        createdBy: 'mcp',
      });
    } else {
      let targetSession = scope.session;
      if (targetMode === 'existing') {
        const targetId = typeof target.sessionId === 'string' ? target.sessionId : '';
        const found = targetId ? ctx.db.getSession(targetId) : undefined;
        if (!found || found.kind !== 'chat' || found.workspace_id !== scope.workspace.id) {
          sendError(res, 400, 'target_not_found', 'target session not found in this workspace');
          return;
        }
        if (!workspaceContains(scope.workspace.path, found.cwd)) {
          sendError(res, 400, 'cwd_not_allowed', 'target session cwd is outside this workspace');
          return;
        }
        targetSession = found;
      }
      result = insertAiTaskOnSession(ctx, {
        session: targetSession,
        workspace: scope.workspace,
        name,
        prompt,
        schedule: parsed.schedule,
        createdBy: 'mcp',
      });
    }
    if (!result.ok) {
      sendError(res, result.code === 'task_limit_reached' ? 409 : 400, result.code, result.message);
      return;
    }
    ctx.db.audit(
      'scheduled_task_create_mcp',
      JSON.stringify({
        id: result.task.id,
        target: targetMode,
        sessionId: result.task.session_id,
        runId: scope.run.id,
      }),
    );
    res.status(201).json({ ok: true, task: scheduledTaskDto(ctx, result.task) });
  });

  app.get('/api/internal/mcp/sessions', (req, res) => {
    const scope = resolveScope(ctx, req.query.runId);
    if (!scope.ok) {
      sendError(res, scope.status, scope.code, scope.message);
      return;
    }
    const sessions = ctx.db.listSessions(scope.workspace.id).map((session) => ({
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      runtime: session.runtime,
      lastActiveAt: session.last_active_at,
    }));
    res.json({ currentSessionId: scope.session.id, sessions });
  });

  app.get('/api/internal/mcp/scheduled-tasks', (req, res) => {
    const scope = resolveScope(ctx, req.query.runId);
    if (!scope.ok) {
      sendError(res, scope.status, scope.code, scope.message);
      return;
    }
    const tasks = ctx.db
      .listScheduledTasks({ workspaceId: scope.workspace.id })
      .map((task) => scheduledTaskDto(ctx, task));
    res.json({ currentSessionId: scope.session.id, tasks });
  });

  app.post('/api/internal/mcp/scheduled-tasks/:id/cancel', (req, res) => {
    const body = (req.body ?? {}) as { runId?: string };
    const scope = resolveScope(ctx, body.runId);
    if (!scope.ok) {
      sendError(res, scope.status, scope.code, scope.message);
      return;
    }
    const task = ctx.db.getScheduledTask(req.params.id);
    if (!task || task.workspace_id !== scope.workspace.id) {
      sendError(res, 404, 'task_not_found', 'scheduled task not found');
      return;
    }
    ctx.db.deleteScheduledTask(task.id);
    if (task.task_type === 'command' && task.session_id) ctx.db.deleteSession(task.session_id);
    ctx.db.audit('scheduled_task_delete_mcp', JSON.stringify({ id: task.id, runId: scope.run.id }));
    res.json({ ok: true, id: task.id });
  });
}
