import type { ServerResponse } from 'node:http';
import type { Express } from 'express';
import type { AppContext } from '../context.js';
import type { RunRow } from '../db.js';
import type { NormalizedEvent, SseFrame } from '../types/api.js';
import { getActiveRun, listActiveRuns } from '../runtimes/active-runs.js';
import { isTerminalEvent, sseHeaders, writeSseFrame } from '../sse.js';

function parseAfter(raw: unknown): number | null {
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
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

  const rows = ctx.db.listEvents(run.id, afterSeq);
  for (const row of rows) {
    writeSseFrame(res, {
      runId: row.run_id,
      seq: row.seq,
      event: JSON.parse(row.payload) as NormalizedEvent,
    });
  }

  // Run already finished: nothing live left to attach to.
  if (!getActiveRun(run.id)) {
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
  // Currently-running runs (in-memory active runs + their DB metadata). This is
  // the phone's "which agents are running right now" list for switching between
  // several in-flight agents.
  app.get('/api/runs', (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId ? req.query.workspaceId : undefined;
    if (workspaceId && !ctx.db.getWorkspace(workspaceId)) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const runs = listActiveRuns()
      .map((active) => {
        const row = ctx.db.getRun(active.id);
        if (!row) return { id: active.id, sessionId: null, workspaceId: null };
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

    const events: SseFrame[] = ctx.db.listEvents(run.id, afterSeq).map((row) => ({
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
