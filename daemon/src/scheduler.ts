import { randomUUID } from 'node:crypto';
import type { AppContext } from './context.js';
import type { ScheduledTaskRow, SessionRow, WorkspaceRow } from './db.js';
import type { ProductPermissionMode } from './permission-mode.js';
import { isProductPermissionMode } from './permission-mode.js';
import { parseStoredModelParameters } from './model-selection.js';
import { nextRunAt } from './schedule.js';
import { startSessionRun, type RunSink } from './run-service.js';
import { activeRunIdForSession } from './session-runs.js';
import { workspaceContains } from './workspace-service.js';
import { log } from './log.js';

/**
 * In-daemon scheduler. It owns no transport: every fire starts a normal run
 * through `startSessionRun`, and the sink is a no-op (events are still
 * persisted and broadcast, so any client can attach to `/api/runs/:id/stream`).
 */
const BACKGROUND_SINK: RunSink = { frame: () => {} };

/** At most one fire per task at a time, even across a manual run-now. */
const firing = new Set<string>();

export type FireMode = 'scheduled' | 'run_now';

export type FireResult =
  | { ok: true; runId: string; sessionId: string }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'disabled'
        | 'busy'
        | 'session_deleted'
        | 'workspace_deleted'
        | 'workspace_disabled'
        | 'session_invalid'
        | 'runtime_unavailable'
        | 'invalid_schedule'
        | 'missing_prompt'
        | 'failed';
      message: string;
    };

function fail(code: Extract<FireResult, { ok: false }>['code'], message: string): FireResult {
  return { ok: false, code, message };
}

function isAiTask(task: ScheduledTaskRow): boolean {
  return task.task_type !== 'command';
}

/**
 * Advance past any occurrence missed while the daemon was down. We never replay
 * missed slots: a task that should have run at 09:00 is advanced to tomorrow
 * and recorded as `skipped_missed`.
 */
export function reconcileScheduledTasks(ctx: AppContext, now = Date.now()): void {
  for (const task of ctx.db.listScheduledTasks()) {
    if (task.last_status === 'running') {
      const run = task.last_run_id ? ctx.db.getRun(task.last_run_id) : undefined;
      if (!run || run.status !== 'running') {
        ctx.db.recordScheduledTaskResult(
          task.id,
          run?.status ?? 'interrupted',
          run?.error ?? 'daemon restarted during the run',
          run?.ended_at ?? now,
        );
      }
    }
    if (!task.enabled) continue;
    if (task.next_run_at !== null && task.next_run_at > now) continue;

    let next: number;
    try {
      next = nextRunAt(task.cron_expr, task.timezone, now);
    } catch (err) {
      log.warn(`task ${task.id} has an invalid schedule`, err);
      ctx.db.disableScheduledTask(task.id, 'invalid_schedule');
      continue;
    }
    ctx.db.updateScheduledTask(task.id, {
      nextRunAt: next,
      ...(task.next_run_at !== null ? { lastStatus: 'skipped_missed', lastError: null } : {}),
    });
  }
}

export async function runDueScheduledTasks(ctx: AppContext, now = Date.now()): Promise<void> {
  for (const task of ctx.db.listDueScheduledTasks(now)) {
    try {
      await fireScheduledTask(ctx, task.id, 'scheduled', now);
    } catch (err) {
      log.warn(`failed to fire task ${task.id}`, err);
      ctx.db.recordScheduledTaskResult(task.id, 'failed', err instanceof Error ? err.message : String(err));
    }
  }
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly intervalMs = 30_000,
    private readonly clock: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    reconcileScheduledTasks(this.ctx, this.clock());
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await runDueScheduledTasks(this.ctx, this.clock());
    } finally {
      this.ticking = false;
    }
  }
}

export async function fireScheduledTask(
  ctx: AppContext,
  taskId: string,
  mode: FireMode,
  now = Date.now(),
): Promise<FireResult> {
  if (firing.has(taskId)) return fail('busy', 'task is already firing');
  firing.add(taskId);
  try {
    return await fireInner(ctx, taskId, mode, now);
  } finally {
    firing.delete(taskId);
  }
}

async function fireInner(ctx: AppContext, taskId: string, mode: FireMode, now: number): Promise<FireResult> {
  const task = ctx.db.getScheduledTask(taskId);
  if (!task) return fail('not_found', 'scheduled task not found');
  if (mode === 'scheduled' && !task.enabled) return fail('disabled', 'scheduled task is disabled');

  const workspace = ctx.db.getWorkspace(task.workspace_id);
  if (!workspace) {
    ctx.db.disableScheduledTask(task.id, 'workspace_deleted');
    return fail('workspace_deleted', 'workspace no longer exists');
  }
  if (workspace.enabled !== 1) {
    ctx.db.disableScheduledTask(task.id, 'workspace_disabled');
    return fail('workspace_disabled', 'workspace is disabled');
  }

  let session: SessionRow;
  if (task.session_id) {
    const bound = ctx.db.getSession(task.session_id);
    if (!bound) {
      ctx.db.deleteScheduledTask(task.id);
      return fail('session_deleted', 'the bound session was deleted');
    }
    session = bound;
  } else if (task.session_mode === 'new' && isAiTask(task)) {
    session = resolveNewSession(ctx, task, workspace);
  } else {
    ctx.db.deleteScheduledTask(task.id);
    return fail('session_deleted', 'task has no session');
  }

  if (!workspaceContains(workspace.path, session.cwd)) {
    ctx.db.disableScheduledTask(task.id, 'session_invalid');
    return fail('session_invalid', 'session cwd is outside its workspace');
  }

  const running = activeRunIdForSession(ctx, session.id);
  if (running) {
    if (mode === 'scheduled') {
      advanceOrSkip(ctx, task, now, 'skipped_busy', 'session already has a running run');
    }
    return fail('busy', `session already has a running run: ${running}`);
  }

  if (mode === 'scheduled') {
    // Claim the slot before starting the run. If another tick already advanced
    // it, this fire loses and does nothing.
    let next: number;
    try {
      next = nextRunAt(task.cron_expr, task.timezone, now);
    } catch (err) {
      ctx.db.disableScheduledTask(task.id, 'invalid_schedule');
      return fail('invalid_schedule', err instanceof Error ? err.message : String(err));
    }
    const claimed = ctx.db.advanceScheduledTask(task.id, task.next_run_at, {
      nextRunAt: next,
      lastFireAt: now,
      lastStatus: 'running',
      lastError: null,
    });
    if (!claimed) return fail('busy', 'another tick already claimed this slot');
  }

  const prompt = isAiTask(task) ? task.prompt?.trim() : task.command?.trim();
  if (!prompt) {
    ctx.db.recordScheduledTaskResult(task.id, 'failed', 'task has no prompt/command');
    return fail('missing_prompt', 'task has no prompt/command');
  }

  const driver = ctx.registry.driver(task.runtime);
  if (!driver) {
    ctx.db.recordScheduledTaskResult(task.id, 'failed', `unknown runtime: ${task.runtime}`);
    return fail('failed', `unknown runtime: ${task.runtime}`);
  }
  if (driver.requiresDetection !== false) {
    const detection =
      ctx.registry.detection(task.runtime) ?? (await ctx.registry.detect(task.runtime, process.env));
    if (!detection?.available) {
      ctx.db.recordScheduledTaskResult(task.id, 'failed', `runtime not available: ${task.runtime}`);
      return fail('runtime_unavailable', `runtime not available: ${task.runtime}`);
    }
  }

  // Detection and runtime probing can yield; a client may have started a run
  // (or deleted the session) in the meantime. Re-check before claiming it.
  if (!ctx.db.getSession(session.id)) {
    ctx.db.deleteScheduledTask(task.id);
    return fail('session_deleted', 'the bound session was deleted');
  }
  const stillRunning = activeRunIdForSession(ctx, session.id);
  if (stillRunning) {
    if (mode === 'scheduled') {
      ctx.db.updateScheduledTask(task.id, {
        lastStatus: 'skipped_busy',
        lastError: 'session already has a running run',
      });
    } else {
      ctx.db.recordScheduledTaskResult(task.id, 'failed', 'session already has a running run');
    }
    return fail('busy', `session already has a running run: ${stillRunning}`);
  }

  const permissionMode: ProductPermissionMode = isProductPermissionMode(task.permission_mode)
    ? task.permission_mode
    : 'bypass';
  const ai = isAiTask(task);
  const model = ai ? session.model ?? task.model ?? null : null;
  const modelParameters = ai
    ? parseStoredModelParameters(session.model_parameters) ?? parseStoredModelParameters(task.model_parameters)
    : null;

  try {
    const handle = startSessionRun(ctx, {
      session,
      workspace,
      prompt,
      driver,
      permissionMode,
      model,
      modelParameters: modelParameters ?? null,
      trigger: mode === 'scheduled' ? 'scheduled' : 'run_now',
      taskId: task.id,
      commandId:
        mode === 'scheduled'
          ? `sched:${task.id}:${task.next_run_at ?? now}`
          : `runnow:${task.id}:${randomUUID()}`,
      sink: BACKGROUND_SINK,
    });
    ctx.db.markScheduledTaskRunning(task.id, handle.runId);
    // The daemon may shut down (or a test may close its DB) before the run
    // finishes; recording a result must never turn into an unhandled rejection.
    const recordResult = (status: string, error: string | null): void => {
      try {
        ctx.db.recordScheduledTaskResult(task.id, status, error);
      } catch (err) {
        log.warn(`failed to record result for scheduled task ${task.id}`, err);
      }
    };
    void handle.done
      .then((outcome) => recordResult(outcome.status, outcome.error))
      .catch((err: unknown) => recordResult('failed', err instanceof Error ? err.message : String(err)));
    return { ok: true, runId: handle.runId, sessionId: session.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.db.recordScheduledTaskResult(task.id, 'failed', message);
    return fail('failed', message);
  }
}

function advanceOrSkip(
  ctx: AppContext,
  task: ScheduledTaskRow,
  now: number,
  status: string,
  reason: string,
): void {
  let next: number;
  try {
    next = nextRunAt(task.cron_expr, task.timezone, now);
  } catch {
    ctx.db.disableScheduledTask(task.id, 'invalid_schedule');
    return;
  }
  ctx.db.updateScheduledTask(task.id, {
    nextRunAt: next,
    lastFireAt: now,
    lastStatus: status,
    lastError: reason,
  });
}

/**
 * First fire of a "new session" task. The session id is written back with a
 * compare-and-swap; on a lost race the winner's session is used and the
 * just-created (unused) one is removed.
 */
function resolveNewSession(ctx: AppContext, task: ScheduledTaskRow, workspace: WorkspaceRow): SessionRow {
  const created = ctx.db.createSession({
    id: randomUUID(),
    runtime: task.runtime,
    workspaceId: workspace.id,
    permissionMode: task.permission_mode,
    model: task.model,
    modelParameters: parseStoredModelParameters(task.model_parameters),
    cwd: workspace.path,
    title: task.name,
  });
  if (ctx.db.setScheduledTaskSession(task.id, created.id)) return created;

  const winnerId = ctx.db.getScheduledTask(task.id)?.session_id;
  const winner = winnerId ? ctx.db.getSession(winnerId) : undefined;
  if (winner) {
    ctx.db.deleteSession(created.id);
    return winner;
  }
  // The row vanished or was rewritten without a session; use what we created.
  return created;
}
