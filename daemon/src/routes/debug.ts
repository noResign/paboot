import type { Express, Response } from 'express';
import type { AppContext } from '../app/context.js';
import { renderDebugPage } from '../debug/page.js';
import type { DebugEvent, LiveRunSummary, LiveSnapshot } from '../debug/types.js';
import { authRole } from '../http/auth.js';
import { sseHeaders } from '../http/sse.js';
import { listActiveRuns } from '../runtimes/active-runs.js';

function requireOperator(res: Response): boolean {
  if (authRole(res) === 'operator') return true;
  res.status(403).json({ error: 'operator token required', code: 'operator_required' });
  return false;
}

type SnapshotSummary = Omit<LiveSnapshot, 'payload'>;

function snapshotSummary(snapshot: LiveSnapshot): SnapshotSummary {
  return {
    id: snapshot.id,
    runId: snapshot.runId,
    sessionId: snapshot.sessionId,
    kind: snapshot.kind,
    step: snapshot.step,
    provider: snapshot.provider,
    model: snapshot.model,
    bytes: snapshot.bytes,
    truncated: snapshot.truncated,
    createdAt: snapshot.createdAt,
  };
}

function decorate(
  ctx: AppContext,
  run: LiveRunSummary,
): LiveRunSummary & { sessionTitle: string | null; workspaceName: string | null } {
  const session = ctx.db.getSession(run.sessionId);
  const workspace = run.workspaceId ? ctx.db.getWorkspace(run.workspaceId) : undefined;
  return {
    ...run,
    sessionTitle: session?.title ?? null,
    workspaceName: workspace?.name ?? null,
  };
}

/**
 * Live debug surface. Data lives only in `ctx.debug` (process memory),
 * so every endpoint is naturally scoped to this daemon run. The page shell is
 * public but carries no data; API calls require the operator token.
 */
export function registerDebugRoutes(app: Express, ctx: AppContext): void {
  app.get(['/debug', '/debug/'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(renderDebugPage());
  });

  app.get('/api/debug/config', (_req, res) => {
    if (!requireOperator(res)) return;
    res.json({
      capture: {
        mode: ctx.debug?.mode ?? 'off',
        active: ctx.debug?.active ?? false,
        subscribers: ctx.debug?.store.subscriberCount() ?? 0,
        maxBytes: ctx.config.debugMaxBytes,
        maxTotalBytes: ctx.config.debugMaxTotalBytes,
        keepMinutes: ctx.config.debugKeepMinutes,
      },
      version: 1,
    });
  });

  app.get('/api/debug/live', (_req, res) => {
    if (!requireOperator(res)) return;
    const store = ctx.debug?.store;
    const captured = store?.listRuns() ?? [];
    const seen = new Set(captured.map((run) => run.runId));
    // In-flight runs that started before the page connected have no captured
    // snapshots, but the user still needs to see that they exist.
    const uncaptured = listActiveRuns()
      .filter((active) => !seen.has(active.id))
      .flatMap((active) => {
        const row = ctx.db.getRun(active.id);
        if (!row) return [];
        const session = ctx.db.getSession(row.session_id);
        const workspace = session?.workspace_id ? ctx.db.getWorkspace(session.workspace_id) : undefined;
        return [
          {
            runId: row.id,
            sessionId: row.session_id,
            workspaceId: session?.workspace_id ?? null,
            runtime: row.runtime,
            model: row.model,
            status: 'running' as const,
            startedAt: row.started_at,
            endedAt: null,
            error: null,
            snapshotCount: 0,
            stepCount: 0,
            lastSnapshotAt: null,
            captured: false,
            sessionTitle: session?.title ?? null,
            workspaceName: workspace?.name ?? null,
          },
        ];
      });
    const memory = (store?.listMemorySessions() ?? []).map((entry) => ({
      ...entry,
      sessionTitle:
        entry.sessionId === 'unknown'
          ? '后台（无会话）'
          : ctx.db.getSession(entry.sessionId)?.title ?? null,
    }));
    res.json({
      runs: [
        ...captured.map((run) => ({ ...decorate(ctx, run), captured: true })),
        ...uncaptured,
      ],
      memory,
    });
  });

  app.get('/api/debug/runs/:runId', (req, res) => {
    if (!requireOperator(res)) return;
    const run = ctx.debug?.store.getRun(req.params.runId) ?? null;
    if (!run) {
      res.status(404).json({ error: 'run not found in live debug', code: 'run_not_found' });
      return;
    }
    const { injection, steps, ...summary } = run;
    res.json({
      ...decorate(ctx, summary),
      injection: injection ? snapshotSummary(injection) : null,
      steps: steps.map(snapshotSummary),
    });
  });

  app.get('/api/debug/sessions/:sessionId/memory', (req, res) => {
    if (!requireOperator(res)) return;
    const record = ctx.debug?.store.getSessionMemory(req.params.sessionId);
    res.json({ sessionId: req.params.sessionId, snapshots: (record?.snapshots ?? []).map(snapshotSummary) });
  });

  app.get('/api/debug/snapshots/:id', (req, res) => {
    if (!requireOperator(res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: 'snapshot not found', code: 'snapshot_not_found' });
      return;
    }
    const snapshot = ctx.debug?.store.getSnapshot(id) ?? null;
    if (!snapshot) {
      res.status(404).json({ error: 'snapshot not found (pruned or daemon restarted)', code: 'snapshot_not_found' });
      return;
    }
    if (req.query.raw === '1') {
      res.type('application/json').send(JSON.stringify(snapshot.payload, null, 2));
      return;
    }
    res.json({ snapshot: snapshotSummary(snapshot), payload: snapshot.payload });
  });

  app.get('/api/debug/memory/state', (_req, res) => {
    if (!requireOperator(res)) return;
    if (!ctx.memory) {
      res.json({ available: false });
      return;
    }
    res.json({
      available: true,
      lastExtractionError: ctx.memory.getState('last_extraction_error'),
      lastExtractionErrorAt: numberOrNull(ctx.memory.getState('last_extraction_error_at')),
      consecutiveFailures: Number(ctx.memory.getState('consecutive_failures') ?? 0),
      lastSuccessAt: numberOrNull(ctx.memory.getState('last_success_at')),
      lastProviderMissingAt: numberOrNull(ctx.memory.getState('last_provider_missing_at')),
    });
  });

  app.get('/api/debug/stream', (req, res) => {
    if (!requireOperator(res)) return;
    res.writeHead(200, sseHeaders());
    res.write(': connected\n\n');
    const send = (event: DebugEvent): void => {
      if (res.writableEnded) return;
      try {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // connection already gone
      }
    };
    const unsubscribe = ctx.debug?.subscribe(send);
    const ping = setInterval(() => {
      if (res.writableEnded) return;
      try {
        res.write('event: ping\ndata: {}\n\n');
      } catch {
        // ignore
      }
    }, 15_000);
    ping.unref?.();
    const cleanup = (): void => {
      clearInterval(ping);
      unsubscribe?.();
      if (!res.writableEnded) res.end();
    };
    req.on('close', cleanup);
  });
}

function numberOrNull(value: string | null): number | null {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
