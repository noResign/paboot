import { randomUUID } from 'node:crypto';
import type { AppContext } from '../app/context.js';
import type { SessionRow, WorkspaceRow } from '../db/db.js';
import { parseStoredModelParameters } from '../db/model-selection.js';
import type { NormalizedEvent, SseFrame } from '../types/api.js';
import type { ProductPermissionMode } from '../permissions/permission-mode.js';
import {
  resolveEffectivePermissionMode,
} from '../permissions/security-profile.js';
import type { RuntimeDriver } from '../runtimes/RuntimeDriver.js';
import type { RunOutcome } from '../runtimes/engine.js';
import { captureCheckpoint, repoRootFor } from '../workspaces/checkpoints.js';
import { log } from '../platform/log.js';
import { existingDirs, workspaceRoots } from '../workspaces/workspace-service.js';
import { ensureKnowledgeRoot } from '../knowledge/paths.js';
import { captureRunMessages } from '../memory/ingest.js';
import { captureRunObservation } from '../memory/observe.js';
import { resolveRunMemoryScope } from '../memory/scope-resolver.js';
import { mergePreludes } from '../context/prelude.js';
import { perRunToolServers } from '../mcp/injection.js';
import { endsContext } from './end-context.js';
import { knowledgeContext } from './knowledge-context.js';
import { memoryContext } from './memory-context.js';
import { memoryRecall } from './memory-recall.js';

/** Claude's resume failure when the conversation is gone from its own storage. */
const MISSING_NATIVE_SESSION_RE = /No conversation found with session ID/i;
const RESET_NATIVE_SESSION_MESSAGE = '会话记录已不存在，已重置；请重新发送';

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
  /** Image attachment ids admitted with this run. */
  attachmentIds?: string[];
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
 * Extra directories for one run: workspace roots plus the dev knowledge root.
 * The knowledge root behaves like any attached directory for runtimes with
 * add-dir support; DeepSeek reaches it through escalation approvals instead.
 */
export function extraDirsForRun(
  ctx: AppContext,
  session: SessionRow,
  workspace: WorkspaceRow,
): string[] {
  const wanted = workspaceRoots(ctx.db, workspace).filter((root) => root !== session.cwd);
  if (workspace.family === 'dev') {
    try {
      wanted.push(ensureKnowledgeRoot(ctx.knowledge.root(workspace.id)));
    } catch (err) {
      log.warn(`run ${session.id}: could not prepare knowledge root`, err);
    }
  }
  const extraDirs = existingDirs(wanted);
  if (extraDirs.length < wanted.length) {
    const dropped = wanted.filter((root) => !extraDirs.includes(root));
    log.warn(`run ${session.id}: ignoring missing extra dir(s): ${dropped.join(', ')}`);
  }
  return extraDirs;
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
  const { session, workspace, prompt, driver, model, modelParameters } = input;
  // Single security boundary for every runtime and every entry point (chat,
  // scheduled runs, run-now). A stored `bypass` is honored only when the
  // daemon-wide policy allows it.
  const permissionMode = resolveEffectivePermissionMode(
    input.permissionMode,
    ctx.builtinConfig,
  );
  const runId = randomUUID();

  ctx.db.touchWorkspace(workspace.id);
  ctx.db.addMessage(session.id, 'user', prompt);
  // Bump recency when the run starts, not only when it ends: the session list
  // is ordered by last_active_at, so waiting for a long run to finish would
  // leave the session buried mid-list while it is clearly the active one.
  ctx.db.touchSession(session.id);
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
    attachmentIds: input.attachmentIds ?? [],
    status: 'running',
    commandId: input.commandId ?? null,
    taskId: input.taskId ?? null,
    trigger: input.trigger,
    permissionMode,
  });
  for (const id of input.attachmentIds ?? []) {
    ctx.attachments.bind(id, { runId });
  }

  // [debug] Live-only entry so `/debug` can show the run before its first
  // model step; it disappears from the page when the process ends or it ages out.
  ctx.debug?.startRun({
    runId,
    sessionId: session.id,
    workspaceId: workspace.id,
    runtime: session.runtime,
    model: model ?? session.model ?? null,
  });

  const done = (async (): Promise<RunOutcome> => {
    let seq = 0;
    let assistantText = '';
    // 运行期间会话可能被删（删会话 / 删工作区级联）。run 行一没，再写事件和消息就只是
    // 往不存在的东西上挂孤儿行，所以置位后 send 直接静默。
    let runDeleted = false;

    const send = (ev: NormalizedEvent): void => {
      if (runDeleted) return;
      // Thinking comes as thousands of tiny deltas per run (a long turn can
      // carry >100k of them). Clients only need the `thinking_start` marker to
      // show their indicator, so the content is neither persisted nor streamed.
      if (ev.type === 'thinking_delta') return;
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
    const extraDirs = extraDirsForRun(ctx, session, workspace);

    // Knowledge goes to the runtime only: the user message and `runs.prompt`
    // stay raw so replay/capture see what the user actually typed.
    //   native system prompt → every run (Claude --append-system-prompt), so an
    //     edited doc takes effect next turn while an unchanged block keeps the
    //     cache warm;
    //   otherwise → first-message prelude only (K0 behavior), never on resume.
    const knowledge = knowledgeContext(ctx, session, workspace);
    const ends = endsContext(ctx, session, workspace);
    const memory = memoryContext(ctx, session, workspace);
    const recall = memoryRecall(ctx, session, workspace, prompt);
    const injected = mergePreludes(knowledge, ends, memory, recall);
    const nativeSystemPrompt =
      injected !== null && ctx.registry.detection(session.runtime)?.capabilities.nativeSystemPrompt === true;
    const usePrelude = injected !== null && !nativeSystemPrompt && !session.native_session_id;
    if (knowledge) {
      const mode = nativeSystemPrompt
        ? 'system prompt'
        : usePrelude
          ? 'first-message prelude'
          : 'skipped (resume without native injection)';
      log.info(
        `run ${runId}: knowledge ${mode}, ${knowledge.documents} pointer(s), ` +
          `${knowledge.used} chars (index ${knowledge.indexVersion}` +
          `${knowledge.overBudget ? ', truncated' : ''})`,
      );
    }

    const sessionId = session.id;
    ctx.notifier.register(runId, send);
    // One list for every runtime: argv/RPC drivers translate these specs into
    // their own MCP config, the builtin driver consumes them in-process.
    const toolServers = perRunToolServers(ctx, runId, session.runtime, session.id);

    // [debug] Capture what paboot is about to inject before the driver
    // starts, so a provider/spawn failure still leaves it in the debug view.
    const injectionMode =
      injected === null
        ? 'none'
        : nativeSystemPrompt
          ? 'native-system-prompt'
          : usePrelude
            ? 'first-message-prelude'
            : 'skipped-resume';
    ctx.debug?.recordRunInjection({
      sessionId: session.id,
      workspaceId: workspace.id,
      runId,
      runtime: session.runtime,
      sessionKind: session.kind,
      purpose: session.purpose,
      memoryMode: session.memory_mode,
      model: model ?? session.model ?? null,
      modelParameters: modelParameters ?? parseStoredModelParameters(session.model_parameters),
      permissionMode,
      extraDirs,
      toolServers,
      resumeNativeSession: session.native_session_id !== null,
      knowledge: knowledge === null ? null : {
        prefix: knowledge.prefix,
        used: knowledge.used,
        overBudget: knowledge.overBudget,
        omitted: knowledge.omitted,
        documents: knowledge.documents,
        indexVersion: knowledge.indexVersion,
      },
      memory: memory === null ? null : {
        prefix: memory.prefix,
        used: memory.used,
        overBudget: memory.overBudget,
        omitted: memory.omitted,
        claims: memory.claims,
        truncated: memory.truncated,
        usedClaimIds: memory.usedClaimIds,
      },
      recall: recall === null ? null : {
        prefix: recall.prefix,
        used: recall.used,
        overBudget: recall.overBudget,
        omitted: recall.omitted,
        hits: recall.hits,
        cue: recall.cue,
        query: recall.query,
        terms: recall.terms,
        dropped: recall.dropped,
        droppedCount: recall.droppedCount,
      },
      merged: injected === null ? null : {
        prefix: injected.prefix,
        used: injected.used,
        overBudget: injected.overBudget,
        omitted: injected.omitted,
      },
      injectionMode,
      prompt,
      promptSent: usePrelude && injected ? `${injected.prefix}\n\n${prompt}` : prompt,
      systemContext: nativeSystemPrompt && injected ? injected.prefix : null,
    });

    const images = (input.attachmentIds ?? []).flatMap((id) => {
      const row = ctx.attachments.get(id);
      return row
        ? [{ id: row.id, mediaType: row.mediaType, storagePath: row.storagePath }]
        : [];
    });

    try {
      const active = driver.start({
        runId,
        sessionId,
        prompt: usePrelude && injected ? `${injected.prefix}\n\n${prompt}` : prompt,
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
        attachmentIds: input.attachmentIds,
        images,
        systemContext: nativeSystemPrompt && injected ? injected.prefix : undefined,
        toolServers,
        // The service owns the terminal frame: provider errors may arrive before
        // exit, while the final checkpoint and run metadata are not ready yet.
        onEvent: (event) => send('terminal' in event && event.terminal ? { ...event, terminal: false } : event),
      });

      const outcome = await active.promise;
      // A resume can fail because the runtime no longer has that conversation
      // (deleted outside paboot, or a ghost id left by a run that never started).
      // Forget the id so the next message opens a fresh conversation instead of
      // failing against the same dead one forever.
      let finalOutcome = outcome;
      if (
        outcome.status === 'failed' &&
        session.native_session_id &&
        MISSING_NATIVE_SESSION_RE.test(outcome.error ?? '') &&
        ctx.db.getRun(runId)
      ) {
        ctx.db.clearNativeSessionId(sessionId);
        finalOutcome = { ...outcome, error: RESET_NATIVE_SESSION_MESSAGE };
        log.warn(
          `run ${runId}: native session ${session.native_session_id} no longer exists; reset for the next run`,
        );
      }
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
        // Memory capture is post-run and best-effort: the SSE stream and the
        // terminal frame must never wait for memory.db or an extraction call.
        scheduleMemoryCapture(ctx, session, workspace, runId);
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
        status: finalOutcome.status,
        endedAt: Date.now(),
        exitCode: finalOutcome.exitCode,
        error: finalOutcome.error,
      });
      // [debug] mark the live run finished; retention/pruning is in-memory only
      ctx.debug?.finishRun(runId, {
        status: runDeleted ? 'deleted' : finalOutcome.status,
        error: finalOutcome.error,
      });
      if (finalOutcome.error && finalOutcome.status === 'failed') {
        send({ type: 'error', code: 'run_failed', message: finalOutcome.error, terminal: true });
      }
      send({ type: 'status', label: finalOutcome.status, terminal: true });
      return finalOutcome;
    } catch (err) {
      log.error('run failed unexpectedly', err);
      const message = err instanceof Error ? err.message : String(err);
      ctx.db.updateRun(runId, { status: 'failed', endedAt: Date.now(), error: message });
      // [debug]
      ctx.debug?.finishRun(runId, { status: 'failed', error: message });
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

/**
 * Copy the run's visible messages into L0 after the terminal state is durable.
 * The snapshot is taken synchronously (cheap) and the insert runs on the next
 * turn so capture failures cannot affect the run outcome.
 */
function scheduleMemoryCapture(
  ctx: AppContext,
  session: SessionRow,
  workspace: WorkspaceRow,
  runId: string,
): void {
  const memory = ctx.memory;
  if (!memory) return;
  const ends = ctx.db.listEnds(workspace.id);
  const messages = ctx.db.listMessages(session.id);
  setImmediate(() => {
    try {
      // Re-read policy at capture time: if the user turned memory off while the
      // run was finishing, the stale run-start snapshot must not win.
      const latestSession = ctx.db.getSession(session.id);
      const latestWorkspace = ctx.db.getWorkspace(workspace.id);
      if (!latestSession || !latestWorkspace) return;
      const settings = ctx.db.getMemorySettings(latestWorkspace.id);
      const captured = captureRunMessages({
        store: memory,
        session: latestSession,
        workspace: latestWorkspace,
        ends,
        messages,
        runId,
        settings,
      });
      const scope = resolveRunMemoryScope(latestSession, latestWorkspace, ends, runId, settings);
      if (scope) {
        const observed = captureRunObservation({
          store: memory,
          scope,
          messages,
          toolEvents: ctx.db.listToolEvents(runId),
        });
        if (observed.observation) {
          log.info(
            `run ${runId}: observation ${observed.observation.id.slice(0, 8)}, ` +
              `${observed.observation.filesRead.length} read / ` +
              `${observed.observation.filesModified.length} modified file(s)`,
          );
        }
      }
      if (captured > 0) {
        log.info(`run ${runId}: captured ${captured} memory source(s)`);
        ctx.memoryWorker?.kick();
      }
    } catch (err) {
      log.warn(`memory capture failed for run ${runId}`, err);
    }
  });
}
