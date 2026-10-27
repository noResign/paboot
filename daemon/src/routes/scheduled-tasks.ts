import { randomUUID } from 'node:crypto';
import type { Express, Response } from 'express';
import type { AppContext } from '../app/context.js';
import type { ScheduledTaskRow, SessionRow, WorkspaceRow } from '../db/db.js';
import type {
  CreateScheduledTaskRequest,
  ScheduleDto,
  ScheduleInput,
  SchedulePresetInput,
  ScheduledTaskDto,
  ScheduledTaskLastStatus,
  ScheduledTaskSessionMode,
  ScheduledTaskType,
  UpdateScheduledTaskRequest,
} from '../types/api.js';
import { runDto } from '../db/dto.js';
import { normalizeModel, parseStoredModelParameters } from '../db/model-selection.js';
import { ScheduleError, nextRunAt, normalizeSchedule, scheduleLabel, type NormalizedSchedule } from '../scheduling/schedule.js';
import { fireScheduledTask } from '../scheduling/scheduler.js';
import { workspaceContains } from '../workspaces/workspace-service.js';
import { getDefaultPermissionMode, isProductPermissionMode, type ProductPermissionMode } from '../permissions/permission-mode.js';
import { TASK_CONFIG_PROMPT } from '../scheduling/task-config.js';
import { activeRunIdForSession } from '../runs/session-runs.js';
import { startSessionRun } from '../runs/run-service.js';

const MAX_TASKS_PER_SESSION = 20;
const MAX_TASKS_PER_WORKSPACE = 20;
export const MAX_PROMPT_CHARS = 16 * 1024;
export const MAX_COMMAND_CHARS = 8 * 1024;
export const MAX_NAME_CHARS = 120;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: message, code });
}

function presetFromRaw(raw: string | null): SchedulePresetInput | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SchedulePresetInput;
    return parsed && typeof parsed === 'object' && typeof parsed.preset === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function scheduledTaskDto(ctx: AppContext, task: ScheduledTaskRow): ScheduledTaskDto {
  const session = task.session_id ? ctx.db.getSession(task.session_id) : undefined;
  const schedule: ScheduleDto = {
    cron: task.cron_expr,
    timezone: task.timezone,
    preset: presetFromRaw(task.schedule_preset),
    label: scheduleLabel(task.cron_expr),
  };
  return {
    id: task.id,
    name: task.name,
    type: (task.task_type === 'command' ? 'command' : 'ai') as ScheduledTaskType,
    sessionMode: task.session_mode as ScheduledTaskSessionMode,
    sessionId: task.session_id,
    sessionTitle: session?.title ?? null,
    workspaceId: task.workspace_id,
    runtime: task.runtime,
    prompt: task.prompt,
    command: task.command,
    permissionMode: task.permission_mode,
    schedule,
    nextRunAt: task.next_run_at,
    lastFireAt: task.last_fire_at,
    lastRunAt: task.last_run_at,
    lastStatus: task.last_status as ScheduledTaskLastStatus,
    lastError: task.last_error,
    lastRunId: task.last_run_id,
    runCount: task.run_count,
    enabled: task.enabled === 1,
    disabledReason: task.disabled_reason,
    createdBy: task.created_by === 'mcp' ? 'mcp' : 'user',
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

export function parseSchedule(value: unknown): { ok: true; schedule: NormalizedSchedule } | { ok: false; message: string } {
  if (!value || typeof value !== 'object') return { ok: false, message: 'schedule is required' };
  try {
    return { ok: true, schedule: normalizeSchedule(value as ScheduleInput) };
  } catch (err) {
    if (err instanceof ScheduleError) return { ok: false, message: err.message };
    throw err;
  }
}

function taskLimitReached(ctx: AppContext, sessionId: string | null, workspaceId: string): boolean {
  if (sessionId) {
    return ctx.db.listScheduledTasks({ sessionId }).length >= MAX_TASKS_PER_SESSION;
  }
  return ctx.db.listScheduledTasks({ workspaceId }).length >= MAX_TASKS_PER_WORKSPACE;
}

/**
 * Insert an AI task bound to an existing session. Shared by the public route
 * and the agent-facing internal endpoint.
 */
export function insertAiTaskOnSession(
  ctx: AppContext,
  input: {
    session: SessionRow;
    workspace: WorkspaceRow;
    name: string;
    prompt: string;
    schedule: NormalizedSchedule;
    createdBy: 'user' | 'mcp';
  },
): { ok: true; task: ScheduledTaskRow } | { ok: false; code: string; message: string } {
  if (taskLimitReached(ctx, input.session.id, input.workspace.id)) {
    return { ok: false, code: 'task_limit_reached', message: 'too many scheduled tasks' };
  }
  let next: number;
  try {
    next = nextRunAt(input.schedule.cron, input.schedule.timezone, Date.now());
  } catch (err) {
    return {
      ok: false,
      code: 'schedule_invalid',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const task = ctx.db.createScheduledTask({
    id: randomUUID(),
    name: input.name,
    taskType: 'ai',
    sessionMode: 'existing',
    sessionId: input.session.id,
    workspaceId: input.workspace.id,
    runtime: input.session.runtime,
    model: normalizeModel(input.session.model),
    prompt: input.prompt,
    permissionMode: 'bypass',
    cronExpr: input.schedule.cron,
    timezone: input.schedule.timezone,
    schedulePreset: input.schedule.preset ? JSON.stringify(input.schedule.preset) : null,
    nextRunAt: next,
    createdBy: input.createdBy,
  });
  return { ok: true, task };
}

/** Aggregated command output, tail-capped so a chatty command cannot bloat the response. */
function commandOutput(ctx: AppContext, runId: string): string {
  const parts: string[] = [];
  for (const event of ctx.db.listReplayEvents(runId)) {
    if (event.type !== 'text_delta') continue;
    try {
      const payload = JSON.parse(event.payload) as { delta?: unknown };
      if (typeof payload.delta === 'string') parts.push(payload.delta);
    } catch {
      // A malformed historical event should not hide the rest of the log.
    }
  }
  const text = parts.join('');
  return text.length > 64 * 1024 ? text.slice(-64 * 1024) : text;
}

/** Insert an AI task whose session is created on the first fire. */
export function insertNewAiTask(
  ctx: AppContext,
  input: {
    workspace: WorkspaceRow;
    runtime: string;
    model: string | null;
    name: string;
    prompt: string;
    schedule: NormalizedSchedule;
    createdBy: 'user' | 'mcp';
  },
): { ok: true; task: ScheduledTaskRow } | { ok: false; code: string; message: string } {
  if (taskLimitReached(ctx, null, input.workspace.id)) {
    return { ok: false, code: 'task_limit_reached', message: 'too many scheduled tasks' };
  }
  let next: number;
  try {
    next = nextRunAt(input.schedule.cron, input.schedule.timezone, Date.now());
  } catch (err) {
    return {
      ok: false,
      code: 'schedule_invalid',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const task = ctx.db.createScheduledTask({
    id: randomUUID(),
    name: input.name,
    taskType: 'ai',
    sessionMode: 'new',
    sessionId: null,
    workspaceId: input.workspace.id,
    runtime: input.runtime,
    model: input.model,
    prompt: input.prompt,
    permissionMode: 'bypass',
    cronExpr: input.schedule.cron,
    timezone: input.schedule.timezone,
    schedulePreset: input.schedule.preset ? JSON.stringify(input.schedule.preset) : null,
    nextRunAt: next,
    createdBy: input.createdBy,
  });
  return { ok: true, task };
}

interface LooseTarget {
  mode?: string;
  sessionId?: string;
  workspaceId?: string;
  runtime?: string;
  model?: string | null;
}

async function runtimeAvailable(ctx: AppContext, runtime: string): Promise<boolean> {
  const driver = ctx.registry.driver(runtime);
  if (!driver || driver.internal) return false;
  if (driver.requiresDetection === false) return true;
  const detection = ctx.registry.detection(runtime) ?? (await ctx.registry.detect(runtime, process.env));
  return detection?.available === true;
}

async function pickConfigRuntime(ctx: AppContext, requested?: string): Promise<string | null> {
  if (requested) return (await runtimeAvailable(ctx, requested)) ? requested : null;
  for (const agent of ctx.registry.list()) {
    if (await runtimeAvailable(ctx, agent.id)) return agent.id;
  }
  return null;
}

async function startTaskConfigRun(
  ctx: AppContext,
  session: SessionRow,
  workspace: WorkspaceRow,
): Promise<{ ok: true; runId: string } | { ok: false; code: string; message: string }> {
  const driver = ctx.registry.driver(session.runtime);
  if (!driver || driver.internal) {
    return { ok: false, code: 'unknown_runtime', message: `unknown runtime: ${session.runtime}` };
  }
  if (driver.requiresDetection !== false) {
    const detection =
      ctx.registry.detection(session.runtime) ?? (await ctx.registry.detect(session.runtime, process.env));
    if (!detection?.available) {
      return { ok: false, code: 'runtime_unavailable', message: `runtime not available: ${session.runtime}` };
    }
  }
  const mode: ProductPermissionMode = isProductPermissionMode(session.permission_mode)
    ? session.permission_mode
    : getDefaultPermissionMode(ctx.db, ctx.config);
  const handle = startSessionRun(ctx, {
    session,
    workspace,
    prompt: TASK_CONFIG_PROMPT,
    driver,
    permissionMode: mode,
    model: normalizeModel(session.model) ?? null,
    modelParameters: parseStoredModelParameters(session.model_parameters) ?? null,
    trigger: 'user',
    // The client opens this session and attaches to the running run; no SSE
    // response is needed on this request.
    sink: { frame: () => {} },
  });
  return { ok: true, runId: handle.runId };
}

export function registerScheduledTaskRoutes(app: Express, ctx: AppContext): void {
  /**
   * The AI authoring chat. One config session is reused per workspace; the
   * stored id lives in `settings` so it survives restarts and is shared across
   * clients. A deleted session is simply recreated on the next request.
   */
  app.post('/api/scheduled-tasks/config-session', async (req, res) => {
    const body = (req.body ?? {}) as { workspaceId?: string; runtime?: string };
    const requestedWorkspace =
      typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : undefined;
    const workspace = requestedWorkspace
      ? ctx.db.getWorkspace(requestedWorkspace)
      : ctx.db.getDefaultWorkspace() ?? ctx.db.listWorkspaces()[0];
    if (!workspace) {
      sendError(res, 404, 'workspace_not_found', 'workspace not found');
      return;
    }
    if (workspace.enabled !== 1) {
      sendError(res, 409, 'workspace_disabled', 'workspace is disabled');
      return;
    }

    const key = `task_config_session:${workspace.id}`;
    const storedId = ctx.db.getSetting(key);
    let session = storedId ? ctx.db.getSession(storedId) : undefined;
    if (session && (session.kind !== 'chat' || session.workspace_id !== workspace.id)) session = undefined;
    // The agent CLI may have been removed since this session was created.
    if (session && !(await runtimeAvailable(ctx, session.runtime))) session = undefined;

    const requestedRuntime =
      typeof body.runtime === 'string' && body.runtime ? body.runtime : undefined;
    if (!session) {
      const runtime = await pickConfigRuntime(ctx, requestedRuntime);
      if (!runtime) {
        sendError(res, 503, 'runtime_unavailable', 'no agent runtime is available');
        return;
      }
      session = ctx.db.createSession({
        id: randomUUID(),
        runtime,
        workspaceId: workspace.id,
        permissionMode: getDefaultPermissionMode(ctx.db, ctx.config),
        cwd: workspace.path,
        title: '配置定时任务',
        purpose: 'task_config',
      });
      ctx.db.setSetting(key, session.id);
      ctx.db.audit(
        'scheduled_task_config_session_create',
        JSON.stringify({ workspaceId: workspace.id, sessionId: session.id, runtime }),
      );
    }

    const configSession = session;
    const running = activeRunIdForSession(ctx, configSession.id);
    if (running) {
      res.json({ ok: true, sessionId: configSession.id, runId: running, busy: true });
      return;
    }

    const started = await startTaskConfigRun(ctx, configSession, workspace);
    if (!started.ok) {
      sendError(res, started.code === 'runtime_unavailable' ? 503 : 400, started.code, started.message);
      return;
    }
    ctx.db.audit(
      'scheduled_task_config_session_start',
      JSON.stringify({ sessionId: configSession.id, runId: started.runId }),
    );
    res.status(202).json({
      ok: true,
      sessionId: configSession.id,
      runId: started.runId,
      busy: false,
    });
  });

  app.get('/api/scheduled-tasks', (req, res) => {
    const workspaceId =
      typeof req.query.workspaceId === 'string' && req.query.workspaceId ? req.query.workspaceId : undefined;
    const sessionId =
      typeof req.query.sessionId === 'string' && req.query.sessionId ? req.query.sessionId : undefined;
    if (workspaceId && !ctx.db.getWorkspace(workspaceId)) {
      sendError(res, 404, 'workspace_not_found', 'workspace not found');
      return;
    }
    if (sessionId && !ctx.db.getSession(sessionId)) {
      sendError(res, 404, 'session_not_found', 'session not found');
      return;
    }
    const tasks = ctx.db.listScheduledTasks({ workspaceId, sessionId }).map((task) => scheduledTaskDto(ctx, task));
    res.json({ tasks });
  });

  app.get('/api/scheduled-tasks/:id', (req, res) => {
    const task = ctx.db.getScheduledTask(req.params.id);
    if (!task) {
      sendError(res, 404, 'task_not_found', 'scheduled task not found');
      return;
    }
    const runs = ctx.db
      .listRunsByTask(task.id, 20)
      .map((run) =>
        runDto(
          run,
          ctx.db.getRunCheckpoint(run.id),
          task.workspace_id,
          task.task_type === 'command' ? commandOutput(ctx, run.id) : null,
        ),
      );
    res.json({ task: scheduledTaskDto(ctx, task), runs });
  });

  app.post('/api/scheduled-tasks', (req, res) => {
    const body = (req.body ?? {}) as CreateScheduledTaskRequest;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_NAME_CHARS) {
      sendError(res, 400, 'bad_request', `name is required (max ${MAX_NAME_CHARS} chars)`);
      return;
    }
    const type: ScheduledTaskType | null =
      body.type === 'ai' || body.type === 'command' ? body.type : null;
    if (!type) {
      sendError(res, 400, 'bad_request', 'type must be ai or command');
      return;
    }
    const target = body.target as LooseTarget | undefined;
    if (!target || typeof target !== 'object') {
      sendError(res, 400, 'bad_request', 'target is required');
      return;
    }
    const parsedSchedule = parseSchedule(body.schedule);
    if (!parsedSchedule.ok) {
      sendError(res, 400, 'schedule_invalid', parsedSchedule.message);
      return;
    }
    const schedule = parsedSchedule.schedule;

    let workspace: WorkspaceRow | undefined;
    let session: SessionRow | undefined;
    let sessionMode: ScheduledTaskSessionMode = 'existing';
    let runtime = '';
    let model: string | null = null;
    let prompt: string | null = null;
    let command: string | null = null;

    if (type === 'command') {
      if (target.mode !== 'workspace' || typeof target.workspaceId !== 'string' || !target.workspaceId) {
        sendError(res, 400, 'bad_request', 'command tasks require target.mode=workspace and workspaceId');
        return;
      }
      workspace = ctx.db.getWorkspace(target.workspaceId);
      if (!workspace) {
        sendError(res, 404, 'workspace_not_found', 'workspace not found');
        return;
      }
      if (workspace.enabled !== 1) {
        sendError(res, 409, 'workspace_disabled', 'workspace is disabled');
        return;
      }
      command = typeof body.command === 'string' ? body.command.trim() : '';
      if (!command || command.length > MAX_COMMAND_CHARS) {
        sendError(res, 400, 'bad_request', `command is required (max ${MAX_COMMAND_CHARS} chars)`);
        return;
      }
      runtime = 'command';
      sessionMode = 'internal';
    } else {
      prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
        sendError(res, 400, 'bad_request', `prompt is required (max ${MAX_PROMPT_CHARS} chars)`);
        return;
      }
      if (target.mode === 'existing') {
        if (typeof target.sessionId !== 'string' || !target.sessionId) {
          sendError(res, 400, 'bad_request', 'target.sessionId is required');
          return;
        }
        session = ctx.db.getSession(target.sessionId);
        if (!session || session.kind !== 'chat') {
          sendError(res, 404, 'session_not_found', 'session not found');
          return;
        }
        workspace = ctx.db.getWorkspace(session.workspace_id ?? '');
        if (!workspace) {
          sendError(res, 404, 'workspace_not_found', 'workspace not found');
          return;
        }
        if (!workspaceContains(workspace.path, session.cwd)) {
          sendError(res, 400, 'cwd_not_allowed', 'session cwd is outside its workspace');
          return;
        }
        runtime = session.runtime;
        model = normalizeModel(session.model) ?? null;
        sessionMode = 'existing';
      } else if (target.mode === 'new') {
        if (typeof target.workspaceId !== 'string' || !target.workspaceId) {
          sendError(res, 400, 'bad_request', 'target.workspaceId is required');
          return;
        }
        workspace = ctx.db.getWorkspace(target.workspaceId);
        if (!workspace) {
          sendError(res, 404, 'workspace_not_found', 'workspace not found');
          return;
        }
        if (workspace.enabled !== 1) {
          sendError(res, 409, 'workspace_disabled', 'workspace is disabled');
          return;
        }
        runtime = typeof target.runtime === 'string' && target.runtime ? target.runtime : 'claude';
        const driver = ctx.registry.driver(runtime);
        if (!driver || driver.internal) {
          sendError(res, 400, 'unknown_runtime', `unknown runtime: ${runtime}`);
          return;
        }
        model = normalizeModel(target.model) ?? null;
        sessionMode = 'new';
      } else {
        sendError(res, 400, 'bad_request', 'target.mode must be existing or new for AI tasks');
        return;
      }
    }

    if (!workspace || !runtime) {
      sendError(res, 400, 'bad_request', 'invalid target');
      return;
    }

    const sessionId = session?.id ?? null;
    if (taskLimitReached(ctx, sessionId, workspace.id)) {
      sendError(res, 409, 'task_limit_reached', 'too many scheduled tasks');
      return;
    }

    const now = Date.now();
    let nextRunAtValue: number;
    try {
      nextRunAtValue = nextRunAt(schedule.cron, schedule.timezone, now);
    } catch (err) {
      sendError(res, 400, 'schedule_invalid', err instanceof Error ? err.message : String(err));
      return;
    }

    // Command tasks need a run container before the task row exists, because
    // runs.session_id is NOT NULL and the whole history pipeline keys on it.
    let hiddenSessionId: string | null = null;
    if (type === 'command') {
      const hidden = ctx.db.createSession({
        id: randomUUID(),
        runtime: 'command',
        workspaceId: workspace.id,
        permissionMode: 'bypass',
        cwd: workspace.path,
        title: name,
        kind: 'command',
      });
      hiddenSessionId = hidden.id;
    }

    const taskId = randomUUID();
    try {
      const task = ctx.db.createScheduledTask({
        id: taskId,
        name,
        taskType: type,
        sessionMode,
        sessionId: hiddenSessionId ?? sessionId,
        workspaceId: workspace.id,
        runtime,
        model,
        prompt,
        command,
        permissionMode: 'bypass',
        cronExpr: schedule.cron,
        timezone: schedule.timezone,
        schedulePreset: schedule.preset ? JSON.stringify(schedule.preset) : null,
        nextRunAt: nextRunAtValue,
        createdBy: 'user',
      });
      ctx.db.audit(
        'scheduled_task_create',
        JSON.stringify({ id: task.id, type, target: target.mode, sessionId: task.session_id }),
      );
      res.status(201).json({ ok: true, task: scheduledTaskDto(ctx, task) });
    } catch (err) {
      if (hiddenSessionId) ctx.db.deleteSession(hiddenSessionId);
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  });

  app.patch('/api/scheduled-tasks/:id', (req, res) => {
    const task = ctx.db.getScheduledTask(req.params.id);
    if (!task) {
      sendError(res, 404, 'task_not_found', 'scheduled task not found');
      return;
    }
    const body = (req.body ?? {}) as UpdateScheduledTaskRequest;
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      sendError(res, 400, 'bad_request', 'enabled must be a boolean');
      return;
    }
    const now = Date.now();

    let cron = task.cron_expr;
    let timezone = task.timezone;
    let schedulePreset = task.schedule_preset;
    let next: number | null = task.next_run_at;
    let scheduleChanged = false;
    if (body.schedule !== undefined) {
      const parsed = parseSchedule(body.schedule);
      if (!parsed.ok) {
        sendError(res, 400, 'schedule_invalid', parsed.message);
        return;
      }
      cron = parsed.schedule.cron;
      timezone = parsed.schedule.timezone;
      schedulePreset = parsed.schedule.preset ? JSON.stringify(parsed.schedule.preset) : null;
      scheduleChanged = true;
    }

    const enabling = body.enabled === true;
    if (enabling) {
      const workspace = ctx.db.getWorkspace(task.workspace_id);
      if (!workspace) {
        sendError(res, 409, 'workspace_deleted', 'workspace no longer exists');
        return;
      }
      if (workspace.enabled !== 1) {
        sendError(res, 409, 'workspace_disabled', 'workspace is disabled');
        return;
      }
      if (task.session_id && !ctx.db.getSession(task.session_id)) {
        sendError(res, 409, 'session_deleted', 'the bound session was deleted');
        return;
      }
    }
    if ((enabling || (scheduleChanged && task.enabled === 1))) {
      try {
        next = nextRunAt(cron, timezone, now);
      } catch (err) {
        sendError(res, 400, 'schedule_invalid', err instanceof Error ? err.message : String(err));
        return;
      }
    }

    let name: string | undefined;
    if (body.name !== undefined) {
      name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > MAX_NAME_CHARS) {
        sendError(res, 400, 'bad_request', `name must be 1-${MAX_NAME_CHARS} chars`);
        return;
      }
    }
    let prompt = task.prompt;
    let command = task.command;
    if (task.task_type === 'command') {
      if (body.command !== undefined) {
        command = typeof body.command === 'string' ? body.command.trim() : '';
        if (!command || command.length > MAX_COMMAND_CHARS) {
          sendError(res, 400, 'bad_request', `command must be 1-${MAX_COMMAND_CHARS} chars`);
          return;
        }
      }
    } else if (body.prompt !== undefined) {
      prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
        sendError(res, 400, 'bad_request', `prompt must be 1-${MAX_PROMPT_CHARS} chars`);
        return;
      }
    }

    // Retargeting only changes where the NEXT fire runs. A live run keeps the
    // session it already started with.
    let retarget:
      | {
          sessionId: string | null;
          sessionMode: 'existing' | 'new';
          runtime?: string;
          model?: string | null;
        }
      | undefined;
    if (body.target !== undefined) {
      if (task.task_type === 'command') {
        sendError(res, 400, 'bad_request', 'command tasks cannot be retargeted');
        return;
      }
      const target = body.target as LooseTarget | undefined;
      if (!target || typeof target !== 'object') {
        sendError(res, 400, 'bad_request', 'target must be an object');
        return;
      }
      if (target.mode === 'existing') {
        const sessionId = typeof target.sessionId === 'string' ? target.sessionId : '';
        const session = sessionId ? ctx.db.getSession(sessionId) : undefined;
        if (!session || session.kind !== 'chat') {
          sendError(res, 404, 'session_not_found', 'target session not found');
          return;
        }
        if (session.workspace_id !== task.workspace_id) {
          sendError(res, 400, 'workspace_mismatch', 'target session belongs to another workspace');
          return;
        }
        const workspace = ctx.db.getWorkspace(task.workspace_id);
        if (!workspace) {
          sendError(res, 409, 'workspace_deleted', 'workspace no longer exists');
          return;
        }
        if (!workspaceContains(workspace.path, session.cwd)) {
          sendError(res, 400, 'cwd_not_allowed', 'target session cwd is outside the workspace');
          return;
        }
        retarget = {
          sessionId: session.id,
          sessionMode: 'existing',
          // The bound session is the source of truth for how it must be resumed:
          // keep the task row's runtime/model in sync with it.
          runtime: session.runtime,
          model: normalizeModel(session.model) ?? null,
        };
      } else if (target.mode === 'new') {
        retarget = { sessionId: null, sessionMode: 'new' };
      } else {
        sendError(res, 400, 'bad_request', 'target.mode must be existing or new');
        return;
      }
    }

    ctx.db.updateScheduledTask(task.id, {
      ...(name !== undefined ? { name } : {}),
      ...(task.task_type === 'command' ? { command } : { prompt }),
      ...(scheduleChanged ? { cronExpr: cron, timezone, schedulePreset } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.enabled === true || (scheduleChanged && task.enabled === 1) ? { nextRunAt: next } : {}),
      ...(retarget
        ? {
            sessionId: retarget.sessionId,
            sessionMode: retarget.sessionMode,
            ...(retarget.runtime !== undefined ? { runtime: retarget.runtime } : {}),
            ...(retarget.model !== undefined ? { model: retarget.model } : {}),
          }
        : {}),
    });
    ctx.db.audit('scheduled_task_update', JSON.stringify({ id: task.id, fields: Object.keys(body) }));
    res.json({ ok: true, task: scheduledTaskDto(ctx, ctx.db.getScheduledTask(task.id) as ScheduledTaskRow) });
  });

  app.delete('/api/scheduled-tasks/:id', (req, res) => {
    const task = ctx.db.getScheduledTask(req.params.id);
    if (!task) {
      sendError(res, 404, 'task_not_found', 'scheduled task not found');
      return;
    }
    ctx.db.deleteScheduledTask(task.id);
    // Command tasks own a hidden session; AI tasks keep their visible session.
    if (task.task_type === 'command' && task.session_id) ctx.db.deleteSession(task.session_id);
    ctx.db.audit('scheduled_task_delete', task.id);
    res.json({ ok: true, id: task.id });
  });

  app.post('/api/scheduled-tasks/:id/run-now', async (req, res) => {
    const task = ctx.db.getScheduledTask(req.params.id);
    if (!task) {
      sendError(res, 404, 'task_not_found', 'scheduled task not found');
      return;
    }
    const result = await fireScheduledTask(ctx, task.id, 'run_now');
    if (result.ok) {
      ctx.db.audit('scheduled_task_run_now', JSON.stringify({ id: task.id, runId: result.runId }));
      res.status(202).json({ ok: true, runId: result.runId, sessionId: result.sessionId });
      return;
    }
    const status =
      result.code === 'not_found'
        ? 404
        : result.code === 'runtime_unavailable'
          ? 503
          : result.code === 'failed'
            ? 500
            : result.code === 'missing_prompt' || result.code === 'invalid_schedule'
              ? 400
              : 409;
    sendError(res, status, result.code, result.message);
  });
}
