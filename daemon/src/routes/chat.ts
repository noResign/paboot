import { randomUUID } from 'node:crypto';
import type { Express, Response } from 'express';
import type { AppContext } from '../app/context.js';
import type { SseFrame } from '../types/api.js';
import { log } from '../platform/log.js';
import { sseHeaders, writeSseFrame } from '../http/sse.js';
import { titleFromPrompt } from '../runs/session-title.js';
import { activeRunIdForSession } from '../runs/session-runs.js';
import { streamRunToResponse } from './runs.js';
import { getDefaultPermissionMode, isProductPermissionMode, type ProductPermissionMode } from '../permissions/permission-mode.js';
import { resolveWorkspaceForRequest, workspaceContains } from '../workspaces/workspace-service.js';
import { startSessionRun, type RunSink } from '../runs/run-service.js';
import {
  isValidModelParameters,
  normalizeModel,
  normalizeModelParameters,
  parseStoredModelParameters,
} from '../db/model-selection.js';

interface ChatBody {
  sessionId?: string;
  workspaceId?: string;
  prompt?: string;
  model?: string;
  /** Generic per-model knobs (e.g. `{reasoningEffort: "high"}`). */
  modelParameters?: Record<string, string>;
  runtime?: string;
  /** Product permission mode: ask | acceptEdits | bypass. Only used for new sessions. */
  permissionMode?: string;
  /**
   * Idempotency key. A retry carrying the same id re-attaches to the run it
   * already started instead of starting a second one. Optional — omit and every
   * request starts a fresh run.
   */
  commandId?: string;
}

/** SSE sink for `/api/chat`: the run itself is independent of this response. */
class ChatSseSink implements RunSink {
  private closed = false;
  private ended = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly res: Response) {
    res.on('close', () => {
      this.closed = true;
      this.stopHeartbeat();
      // The daemon keeps the run alive so the phone can reconnect and resume
      // watching via `GET /api/runs/:id/stream`. Cancel explicitly instead.
      if (!this.ended) log.info('chat stream closed; run keeps running');
    });
  }

  begin(): void {
    this.res.writeHead(200, sseHeaders());
    this.res.write(': connected\n\n');
    this.heartbeat = setInterval(() => {
      if (this.closed || this.res.writableEnded) return;
      this.res.write(': keepalive\n\n');
    }, 15000);
  }

  frame(frame: SseFrame): void {
    if (this.closed || this.res.writableEnded) return;
    writeSseFrame(this.res, frame);
  }

  end(): void {
    this.ended = true;
    this.stopHeartbeat();
    if (!this.res.writableEnded) this.res.end();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

/**
 * The main entry point: `POST /api/chat` with a JSON body, answered as an SSE
 * stream of normalized events. Each request is one "run" against a session:
 * a fresh session starts a new Claude Code session (`--session-id`), a known
 * session resumes it (`--resume`).
 */
export function registerChatRoutes(app: Express, ctx: AppContext): void {
  app.post('/api/chat', async (req, res) => {
    const body = (req.body ?? {}) as ChatBody;
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const requestedRuntime = typeof body.runtime === 'string' && body.runtime ? body.runtime : undefined;
    const model = normalizeModel(body.model) ?? undefined;

    if (!prompt) {
      res.status(400).json({ error: 'prompt is required', code: 'prompt_required' });
      return;
    }
    if (body.modelParameters !== undefined && !isValidModelParameters(body.modelParameters)) {
      res.status(400).json({ error: 'modelParameters must be an object or null', code: 'bad_request' });
      return;
    }
    if (body.permissionMode !== undefined && !isProductPermissionMode(body.permissionMode)) {
      res.status(400).json({ error: 'permissionMode must be ask, acceptEdits or bypass', code: 'bad_request' });
      return;
    }

    // Idempotency: if this command already started a run, re-attach to it rather
    // than starting a second one. Checked before the session/busy guards, since
    // a retry must attach whether the original run is still live or finished.
    const commandId = typeof body.commandId === 'string' && body.commandId.trim() ? body.commandId.trim() : undefined;
    if (commandId) {
      const existing = ctx.db.getRunByCommandId(commandId);
      if (existing) {
        // Reusing a command id for a different session would stream a run the
        // caller never asked for; refuse instead of silently reporting it.
        if (body.sessionId && existing.session_id !== body.sessionId) {
          res.status(409).json({ error: 'commandId already used for another session', code: 'command_id_conflict' });
          return;
        }
        streamRunToResponse(ctx, existing, 0, res);
        return;
      }
    }

    // Resolve or create the session, and decide resume vs. fresh-start.
    let session = body.sessionId ? ctx.db.getSession(body.sessionId) : undefined;
    if (body.sessionId && !session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }

    // One prompt at a time per session. Without this, a second run would
    // `--resume` the same native session id as the first, i.e. two agents
    // appending to one transcript. Clients disable their composer while a run
    // is live, but that is only politeness — two devices can race past it.
    // Checked before runtime detection, which spawns the CLI.
    if (session) {
      const runningRunId = activeRunIdForSession(ctx, session.id);
      if (runningRunId) {
        res.status(409).json({
          error: 'session already has a running run',
          code: 'session_busy',
          runId: runningRunId,
        });
        return;
      }
    }

    if (session && requestedRuntime && requestedRuntime !== session.runtime) {
      res.status(400).json({ error: 'runtime does not match session', code: 'runtime_mismatch' });
      return;
    }
    const runtime = session?.runtime ?? requestedRuntime ?? 'claude';

    // The execution seam is the registered driver; argv (Claude) and RPC
    // (Codex) runtimes both provide one. The route never branches on the
    // runtime name — an unknown runtime is simply one without a driver.
    const driver = ctx.registry.driver(runtime);
    if (!driver || driver.internal) {
      res.status(400).json({ error: `unknown runtime: ${runtime}`, code: 'unknown_runtime' });
      return;
    }

    if (driver.requiresDetection !== false) {
      const detection = ctx.registry.detection(runtime) ?? (await ctx.registry.detect(runtime, process.env));
      if (!detection?.available) {
        res.status(503).json({ error: `runtime not available: ${runtime}`, code: 'runtime_unavailable' });
        return;
      }
    }

    // Detection may yield before a run row exists. Recheck both guards before
    // the synchronous session/run creation below claims the session.
    if (commandId) {
      const existing = ctx.db.getRunByCommandId(commandId);
      if (existing) {
        if (body.sessionId && existing.session_id !== body.sessionId) {
          res.status(409).json({ error: 'commandId already used for another session', code: 'command_id_conflict' });
          return;
        }
        streamRunToResponse(ctx, existing, 0, res);
        return;
      }
    }
    if (session) {
      const runningRunId = activeRunIdForSession(ctx, session.id);
      if (runningRunId) {
        res.status(409).json({ error: 'session already has a running run', code: 'session_busy', runId: runningRunId });
        return;
      }
      // Another request may have established the native id during detection.
      session = ctx.db.getSession(session.id);
      if (!session) {
        res.status(404).json({ error: 'session not found', code: 'session_not_found' });
        return;
      }
    }

    // Existing sessions keep their own workspace; new sessions use the
    // requested workspace or the daemon default.
    const requestedWorkspaceId =
      typeof body.workspaceId === 'string' && body.workspaceId.trim() ? body.workspaceId.trim() : undefined;
    const workspace = resolveWorkspaceForRequest(ctx.db, session?.workspace_id ?? requestedWorkspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }

    // Resuming an existing session: cwd must still be inside its workspace.
    if (session && !workspaceContains(workspace.path, session.cwd)) {
      res.status(400).json({ error: `session cwd not allowed: ${session.cwd}`, code: 'cwd_not_allowed' });
      return;
    }

    const defaultPermissionMode = getDefaultPermissionMode(ctx.db, ctx.config);
    const sessionPermissionMode: ProductPermissionMode = session && isProductPermissionMode(session.permission_mode)
      ? session.permission_mode
      : isProductPermissionMode(body.permissionMode)
        ? body.permissionMode
        : defaultPermissionMode;
    // A request-level model overrides for this run; otherwise the session's
    // creation-time choice decides, and absent both the runtime's default wins.
    const effectiveModel = model ?? normalizeModel(session?.model) ?? undefined;
    // Same precedence for the knobs: a request-level override wins, otherwise
    // the session's saved selection, otherwise the provider defaults.
    const effectiveParameters = body.modelParameters !== undefined
      ? normalizeModelParameters(body.modelParameters)
      : parseStoredModelParameters(session?.model_parameters);

    // A session with a native id resumes it. Otherwise the driver decides how
    // the session gets named — a host-picking runtime (Claude `--session-id`)
    // names it up front; one that allocates its own (Codex) reports it later.
    if (!session) {
      const id = randomUUID();
      session = ctx.db.createSession({
        id,
        runtime,
        workspaceId: workspace.id,
        permissionMode: sessionPermissionMode,
        model: effectiveModel ?? null,
        modelParameters: effectiveParameters,
        cwd: workspace.path,
        title: titleFromPrompt(prompt),
      });
    }

    const sink = new ChatSseSink(res);
    try {
      const handle = startSessionRun(ctx, {
        session,
        workspace,
        prompt,
        driver,
        permissionMode: sessionPermissionMode,
        model: effectiveModel ?? null,
        modelParameters: effectiveParameters ?? null,
        trigger: 'user',
        commandId: commandId ?? null,
        sink,
      });
      await handle.done;
    } catch (err) {
      log.error('failed to start run', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'failed to start run', code: 'internal_error' });
      } else {
        sink.end();
      }
    }
  });
}
