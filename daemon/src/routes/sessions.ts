import type { Express } from 'express';
import type { AppContext } from '../context.js';
import type { RunCheckpointRow, RunRow, SessionRow } from '../db.js';
import { listActiveRuns } from '../runtimes/active-runs.js';
import { runningRunBySession } from '../session-runs.js';
import {
  isValidModelParameters,
  normalizeModel,
  normalizeModelParameters,
  parseStoredModelParameters,
} from '../model-selection.js';

function sessionDto(s: SessionRow, runningRunId: string | null = null) {
  return {
    id: s.id,
    runtime: s.runtime,
    workspaceId: s.workspace_id,
    permissionMode: s.permission_mode,
    model: s.model,
    modelParameters: parseStoredModelParameters(s.model_parameters),
    cwd: s.cwd,
    title: s.title,
    createdAt: s.created_at,
    lastActiveAt: s.last_active_at,
    running: runningRunId !== null,
    runningRunId,
  };
}

function runDto(r: RunRow, checkpoint?: RunCheckpointRow) {
  return {
    id: r.id,
    sessionId: r.session_id,
    runtime: r.runtime,
    model: r.model,
    modelParameters: parseStoredModelParameters(r.model_parameters),
    status: r.status,
    prompt: r.prompt,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    exitCode: r.exit_code,
    error: r.error,
    checkpoint: checkpoint
      ? {
          status: checkpoint.status,
          repoRoot: checkpoint.repo_root,
          preRef: checkpoint.pre_ref,
          postRef: checkpoint.post_ref,
        }
      : null,
  };
}

export function registerSessionRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/sessions', (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId ? req.query.workspaceId : undefined;
    if (workspaceId && !ctx.db.getWorkspace(workspaceId)) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const running = runningRunBySession(ctx);
    const sessions = ctx.db.listSessions(workspaceId).map((s) => sessionDto(s, running.get(s.id) ?? null));
    res.json({ sessions });
  });

  app.get('/api/sessions/:id', (req, res) => {
    const s = ctx.db.getSession(req.params.id);
    if (!s) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const running = runningRunBySession(ctx);
    res.json({
      session: sessionDto(s, running.get(s.id) ?? null),
      messages: ctx.db.listMessages(s.id),
      runs: ctx.db.listRuns(s.id).map((r) => runDto(r, ctx.db.getRunCheckpoint(r.id))),
    });
  });

  // Rename a session.
  app.patch('/api/sessions/:id', (req, res) => {
    const s = ctx.db.getSession(req.params.id);
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
    ctx.db.audit('rename_session', s.id);
    const running = runningRunBySession(ctx);
    const updated = ctx.db.getSession(s.id) as SessionRow;
    res.json({ ok: true, session: sessionDto(updated, running.get(s.id) ?? null) });
  });

  // Switch the model used by this session's subsequent runs. An in-flight run
  // keeps the model it already started with; there is nothing to restart.
  app.patch('/api/sessions/:id/model', (req, res) => {
    const s = ctx.db.getSession(req.params.id);
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
    const running = runningRunBySession(ctx);
    const updated = ctx.db.getSession(s.id) as SessionRow;
    res.json({ ok: true, effective: 'next_run', session: sessionDto(updated, running.get(s.id) ?? null) });
  });

  // Delete a session, cancelling any in-flight run first so no child process is
  // left orphaned.
  app.delete('/api/sessions/:id', (req, res) => {
    const s = ctx.db.getSession(req.params.id);
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
    ctx.db.deleteSession(s.id);
    ctx.permissions.clearSession(s.id);
    ctx.db.audit('delete_session', s.id);
    res.json({ ok: true, id: s.id });
  });
}
