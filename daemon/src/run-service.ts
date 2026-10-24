import { randomUUID } from 'node:crypto';
import type { AppContext } from './context.js';
import type { SessionRow, WorkspaceRow } from './db.js';
import type { NormalizedEvent, SseFrame } from './types/api.js';
import type { ProductPermissionMode } from './permission-mode.js';
import type { RuntimeDriver } from './runtimes/RuntimeDriver.js';
import type { RunOutcome } from './runtimes/engine.js';
import { captureCheckpoint, repoRootFor } from './checkpoints.js';
import { log } from './log.js';
import { existingDirs, workspaceRoots } from './workspace-service.js';

/**
 * The transport side of a run. The chat route writes SSE frames; the scheduler
 * and the command runner pass a sink that drops frames (persistence and
 * notifier broadcast still happen inside `startSessionRun`, so replay works).
 */
export interface RunSink {
  begin?(): void;
  frame(frame: SseFrame): void;
  end?(): void;
}

export interface StartSessionRunInput {
  session: SessionRow;
  workspace: WorkspaceRow;
  prompt: string;
  driver: RuntimeDriver;
  permissionMode: ProductPermissionMode;
  model: string | null;
  modelParameters: Record<string, string> | null;
  trigger: 'user' | 'scheduled' | 'run_now';
  taskId?: string | null;
  commandId?: string | null;
  sink: RunSink;
}

export interface RunHandle {
  runId: string;
  /** Resolves after the post-checkpoint and terminal status are persisted. */
  done: Promise<RunOutcome>;
}

/**
 * Start one run against an already-resolved session and workspace. Extracted
 * from the `/api/chat` handler so the scheduler and the command runner share
 * exactly the same persistence, checkpoint, notifier and terminal-frame rules.
 *
 * Callers own validation (session busy, workspace/cwd checks, runtime
 * detection) and session creation; this function owns everything after that.
 */
export function startSessionRun(ctx: AppContext, input: StartSessionRunInput): RunHandle {
  const { session, workspace, prompt, driver, permissionMode, model, modelParameters } = input;
  const runId = randomUUID();

  ctx.db.touchWorkspace(workspace.id);
  ctx.db.addMessage(session.id, 'user', prompt);
  ctx.db.audit(
    input.trigger === 'user' ? 'chat' : 'scheduled_run',
    JSON.stringify({
      sessionId: session.id,
      runtime: session.runtime,
      model: model ?? null,
      modelParameters: modelParameters ?? null,
      trigger: input.trigger,
      taskId: input.taskId ?? null,
      permissionMode,
    }),
  );
  ctx.db.createRun({
    id: runId,
    sessionId: session.id,
    runtime: session.runtime,
    model,
    modelParameters,
    prompt,
    status: 'running',
    commandId: input.commandId ?? null,
    taskId: input.taskId ?? null,
    trigger: input.trigger,
    permissionMode,
  });

  const done = (async (): Promise<RunOutcome> => {
    let seq = 0;
    let assistantText = '';
    // 运行期间会话可能被删（删会话 / 删工作区级联）。run 行一没，再写事件和消息就只是
    // 往不存在的东西上挂孤儿行，所以置位后 send 直接静默。
    let runDeleted = false;

    const send = (ev: NormalizedEvent): void => {
      if (runDeleted) return;
      seq += 1;
      if (ev.type === 'text_delta') assistantText += ev.delta;
      try {
        ctx.db.appendEvent(runId, seq, ev.type, ev);
      } catch (err) {
        log.warn('failed to persist event', err);
      }
      const frame: SseFrame = { runId, seq, event: ev };
      try {
        input.sink.frame(frame);
      } catch (err) {
        log.warn('failed to write run frame', err);
      }
      ctx.notifier.broadcast(runId, frame);
    };

    // Snapshot the workspace before the run can touch it, so its changes can be
    // diffed and rolled back later. Best-effort: a non-git cwd or a git failure
    // just means no checkpoint, and the run proceeds anyway.
    const repoRoot = await repoRootFor(session.cwd);
    const preRef = repoRoot ? await captureCheckpoint(repoRoot, `${runId}-pre`) : null;
    if (repoRoot) {
      ctx.db.upsertRunCheckpoint({
        runId,
        repoRoot,
        preRef,
        postRef: null,
        status: preRef ? 'complete' : 'unavailable',
      });
    }

    input.sink.begin?.();
    send({
      type: 'status',
      label: 'starting',
      runtime: session.runtime,
      sessionId: session.id,
    });

    // Roots this session may touch without an ask: the workspace's primary dir
    // plus every dir granted to it. `--add-dir` covers the ones that aren't the
    // spawn cwd (an imported TUI session can have a subdir as its cwd, leaving
    // the primary to be granted explicitly). The engine also exports the same
    // set to the hook as its spawn-time allowlist.
    const wanted = workspaceRoots(ctx.db, workspace).filter((root) => root !== session.cwd);
    const extraDirs = existingDirs(wanted);
    if (extraDirs.length < wanted.length) {
      const dropped = wanted.filter((root) => !extraDirs.includes(root));
      log.warn(`run ${runId}: ignoring missing workspace dir(s): ${dropped.join(', ')}`);
    }

    const sessionId = session.id;
    ctx.notifier.register(runId, send);

    try {
      const active = driver.start({
        runId,
        sessionId,
        prompt,
        cwd: session.cwd,
        model: model ?? undefined,
        modelParameters: modelParameters ?? undefined,
        permissionMode,
        resumeNativeSessionId: session.native_session_id ?? undefined,
        // The driver reports the session's native id once known: a host-picking
        // runtime names it up front, a self-allocating one (Codex) when the
        // provider reports it.
        onNativeSessionId: (nativeId) => ctx.db.setNativeSessionId(sessionId, nativeId),
        extraDirs,
        // The service owns the terminal frame: provider errors may arrive before
        // exit, while the final checkpoint and run metadata are not ready yet.
        onEvent: (event) => send('terminal' in event && event.terminal ? { ...event, terminal: false } : event),
      });

      const outcome = await active.promise;
      if (!ctx.db.getRun(runId)) {
        // 会话/工作区在运行期间被删了：清掉从 cancel 到进程退出之间迟到写入的事件，
        // 并跳过收尾持久化（会话行都没了，写消息只会留下孤儿行）。
        runDeleted = true;
        ctx.db.deleteEventsForRun(runId);
      } else {
        ctx.db.touchSession(sessionId);
        // Persist the assistant's aggregated visible text as a message so the
        // transcript is complete without replaying every event. Tool / thinking
        // detail stays in the events table.
        if (assistantText.trim()) {
          ctx.db.addMessage(sessionId, 'assistant', assistantText.trim());
        }
        // Close the checkpoint pair so the run's diff (pre..post) is available.
        // Cancelled runs converge here too, so they stay diffable/rollback-able.
        if (repoRoot) {
          const postRef = await captureCheckpoint(repoRoot, `${runId}-post`);
          ctx.db.upsertRunCheckpoint({
            runId,
            repoRoot,
            preRef,
            postRef,
            status: preRef && postRef ? 'complete' : 'unavailable',
          });
        }
      }
      // Keep the session busy until its post-checkpoint is durable. A new run
      // must not edit files while the previous run is still taking its snapshot.
      ctx.db.updateRun(runId, {
        status: outcome.status,
        endedAt: Date.now(),
        exitCode: outcome.exitCode,
        error: outcome.error,
      });
      if (outcome.error && outcome.status === 'failed') {
        send({ type: 'error', code: 'run_failed', message: outcome.error, terminal: true });
      }
      send({ type: 'status', label: outcome.status, terminal: true });
      return outcome;
    } catch (err) {
      log.error('run failed unexpectedly', err);
      const message = err instanceof Error ? err.message : String(err);
      ctx.db.updateRun(runId, { status: 'failed', endedAt: Date.now(), error: message });
      send({ type: 'error', code: 'run_error', message, terminal: true });
      return { status: 'failed', exitCode: null, error: message };
    } finally {
      ctx.notifier.unregister(runId);
      ctx.permissions.clearRun(runId);
      input.sink.end?.();
    }
  })();

  return { runId, done };
}
