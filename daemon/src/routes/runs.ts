import type { ServerResponse } from 'node:http';
import path from 'node:path';
import type { Express } from 'express';
import type { AppContext } from '../context.js';
import type { RunRow } from '../db.js';
import type { NormalizedEvent, SseFrame } from '../types/api.js';
import { ChangesError } from '../changes.js';
import { captureCheckpoint, restoreToRef } from '../checkpoints.js';
import { getActiveRun, listActiveRuns } from '../runtimes/active-runs.js';
import { isTerminalEvent, sseHeaders, writeSseFrame } from '../sse.js';

function parseAfter(raw: unknown): number | null {
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function inside(root: string, absolute: string): boolean {
  const rel = path.relative(root, absolute);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sendRollbackError(res: import('express').Response, err: unknown): void {
  if (err instanceof ChangesError) {
    res.status(err.httpStatus).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'internal_error' });
}

/**
 * Replay a run's persisted events (`seq > afterSeq`), then keep streaming new
 * frames while the run is still active. Shared by `GET /api/runs/:id/stream`
 * and by a duplicated `POST /api/chat` re-attaching to the run its command id
 * already started.
 */
export function streamRunToResponse(
  ctx: AppContext,
  run: RunRow,
  afterSeq: number,
  res: ServerResponse,
): void {
  res.writeHead(200, sseHeaders());
  res.write(': connected\n\n');

  // Subscribe first, then replay, all synchronously: on Node's single thread
  // no frame can be published in between, so there is no gap and no need to
  // de-duplicate.
  let unsubscribe: (() => void) | undefined;
  unsubscribe = ctx.notifier.subscribe(run.id, (frame) => {
    writeSseFrame(res, frame);
    if (isTerminalEvent(frame.event)) {
      unsubscribe?.();
      res.end();
    }
  });

  // Legacy runs still hold thinking deltas. They are never replayed: the client
  // shows a transient indicator from `thinking_start`, and shipping the content
  // is both useless and ruinous for long transcripts. The exclusion happens in
  // SQL so those rows are never materialized.
  const rows = ctx.db.listReplayEvents(run.id, afterSeq);
  for (const row of rows) {
    writeSseFrame(res, {
      runId: row.run_id,
      seq: row.seq,
      event: JSON.parse(row.payload) as NormalizedEvent,
    });
  }

  // Run already finished: nothing live left to attach to.
  if (run.status !== 'running' && !getActiveRun(run.id)) {
    unsubscribe();
    res.end();
    return;
  }

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': keepalive\n\n');
  }, 15000);

  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe?.();
  });
}

export function registerRunRoutes(app: Express, ctx: AppContext): void {
  // In-flight runs, including checkpoint preparation/finalization. This is
  // the phone's "which agents are running right now" list for switching between
  // several in-flight agents.
  app.get('/api/runs', (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId ? req.query.workspaceId : undefined;
    if (workspaceId && !ctx.db.getWorkspace(workspaceId)) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const ids = new Set([...ctx.db.listRunningRuns().map((run) => run.id), ...listActiveRuns().map((run) => run.id)]);
    const runs = [...ids]
      .map((id) => {
        const row = ctx.db.getRun(id);
        if (!row) return { id, sessionId: null, workspaceId: null };
        const session = ctx.db.getSession(row.session_id);
        return {
          id: row.id,
          sessionId: row.session_id,
          workspaceId: session?.workspace_id ?? null,
          runtime: row.runtime,
          model: row.model,
          status: row.status,
          prompt: row.prompt,
          startedAt: row.started_at,
        };
      })
      .filter((run) => !workspaceId || run.workspaceId === workspaceId);
    res.json({ runs });
  });

  app.post('/api/runs/:id/cancel', (req, res) => {
    const id = req.params.id;
    const active = getActiveRun(id);
    if (!active) {
      res.status(404).json({ error: 'run not found or already finished', code: 'run_not_found' });
      return;
    }
    active.cancel('cancelled by request');
    ctx.db.audit('cancel', id);
    res.json({ ok: true, id });
  });

  // Roll the workspace back to before a run: restore the tree to the run's
  // pre-checkpoint and mark it and every later run in the session as
  // `rolled_back`. Destructive and hard to reverse — the caller must opt in
  // (`confirm`), the current tree is snapshotted first as an escape hatch, and
  // discarding later runs additionally requires `force`.
  app.post('/api/runs/:id/rollback', async (req, res) => {
    const id = req.params.id;
    const body = (req.body ?? {}) as { confirm?: unknown; force?: unknown };
    if (body.confirm !== true) {
      res.status(400).json({ error: 'rollback requires { confirm: true }', code: 'confirm_required' });
      return;
    }
    const run = ctx.db.getRun(id);
    if (!run) {
      res.status(404).json({ error: 'run not found', code: 'run_not_found' });
      return;
    }
    const checkpoint = ctx.db.getRunCheckpoint(id);
    if (!checkpoint || !checkpoint.pre_ref) {
      res.status(409).json({ error: 'run has no checkpoint to roll back to', code: 'no_checkpoint' });
      return;
    }

    // A live run editing the same repo would race the restore and be clobbered.
    const clashing = ctx.db.listRunningRuns().some((activeRun) => {
      const session = ctx.db.getSession(activeRun.session_id);
      return session ? inside(checkpoint.repo_root, session.cwd) : false;
    });
    if (clashing) {
      res.status(409).json({ error: 'a run is still active in this repository', code: 'run_active' });
      return;
    }

    const later = ctx.db.listRuns(run.session_id).filter((r) => r.started_at > run.started_at);
    if (later.length > 0 && body.force !== true) {
      res.status(409).json({
        error: 'later runs would also be discarded',
        code: 'later_runs_exist',
        laterRuns: later.length,
      });
      return;
    }

    try {
      // Escape hatch: snapshot the current tree so a mistaken rollback is itself
      // recoverable (via git, outside the product — there is no UI for it).
      await captureCheckpoint(checkpoint.repo_root, `pre-rollback-${Date.now()}`);
      await restoreToRef(checkpoint.repo_root, checkpoint.pre_ref);
    } catch (err) {
      sendRollbackError(res, err);
      return;
    }

    const rolledBackRuns = ctx.db.markRunsRolledBack(run.session_id, run.started_at);
    for (const affected of [run, ...later]) ctx.db.markRunCheckpointRolledBack(affected.id);
    // The file tree rewound; the agent's transcript cannot. Say so explicitly so
    // the history stays honest about what happened.
    ctx.db.addMessage(run.session_id, 'assistant', '文件已回滚到该运行之前（agent 对话未回退）。');
    ctx.db.audit('rollback', id);
    res.json({ ok: true, rolledBackRuns, conversationRewound: false });
  });

  // One-shot replay of a run's persisted events, in the same `SseFrame` shape
  // as the live stream. `after` is the resume cursor (the last `seq` the client
  // has seen); only events with `seq > after` are returned. Lets a client
  // re-render a completed run, or catch up after a disconnect, without losing
  // the event-level detail (tool cards / thinking / usage) that the aggregated
  // `messages` transcript does not carry.
  app.get('/api/runs/:id/events', (req, res) => {
    const run = ctx.db.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run not found', code: 'run_not_found' });
      return;
    }

    const afterSeq = parseAfter(req.query.after);
    if (afterSeq === null) {
      res.status(400).json({ error: 'invalid "after" cursor', code: 'bad_request' });
      return;
    }

    const events: SseFrame[] = ctx.db.listReplayEvents(run.id, afterSeq).map((row) => ({
      runId: row.run_id,
      seq: row.seq,
      event: JSON.parse(row.payload) as NormalizedEvent,
    }));

    res.json({ runId: run.id, events });
  });

  // Live stream: replay persisted events (`?after=<seq>`), then keep streaming
  // new frames as long as the run is active. This is how a phone re-attaches to
  // an in-flight run after dropping the original `/api/chat` connection.
  app.get('/api/runs/:id/stream', (req, res) => {
    const run = ctx.db.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run not found', code: 'run_not_found' });
      return;
    }

    const afterSeq = parseAfter(req.query.after);
    if (afterSeq === null) {
      res.status(400).json({ error: 'invalid "after" cursor', code: 'bad_request' });
      return;
    }

    streamRunToResponse(ctx, run, afterSeq, res);
  });
}
