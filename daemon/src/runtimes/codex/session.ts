import { readCodexInput } from './input.js';
import { registerActiveRun } from '../active-runs.js';
import { isReadOnlyBash } from '../../command-safety.js';
import { log } from '../../log.js';
import type { ProductPermissionMode } from '../../permission-mode.js';
import { ALLOW_ALL_REASON, type PermissionManager } from '../../permissions.js';
import type { RunNotifier } from '../../run-notifier.js';
import { grantKeyCandidates } from '../../tool-grants.js';
import type { NormalizedEvent } from '../../types/api.js';
import { VERSION } from '../../version.js';
import { asRecord, codexApprovalResult, createCodexStreamMapper, readCodexApproval, readString } from './map.js';
import { initializeCodexAppServer, spawnCodexAppServer, type CodexAppServerConnection } from './rpc.js';

/**
 * One Codex run: spawn `codex app-server`, open a thread, start a turn, and
 * translate until the turn ends.
 *
 * The shape mirrors `../engine.ts` on purpose — `startRun` returns an
 * `ActiveRun`-alike so the chat route can pick a runtime and stay otherwise
 * unchanged. What is genuinely different lives in three places:
 *
 *   1. a handshake and a thread/turn protocol instead of argv + a prompt;
 *   2. approvals arrive as server→client requests rather than a hook subprocess;
 *   3. turn completion is a notification, not process exit.
 */

export interface CodexRunOutcome {
  status: 'succeeded' | 'failed' | 'cancelled';
  exitCode: number | null;
  error: string | null;
}

export interface CodexRunDeps {
  permissions: PermissionManager;
  notifier: Pick<RunNotifier, 'emit'>;
  db: { hasPermissionGrant(sessionId: string, toolName: string): boolean };
}

export interface CodexRunRequest {
  id: string;
  sessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  /** Model parameters resolved by the chat route (e.g. reasoningEffort). */
  modelParameters?: Record<string, string>;
  /** Existing, canonical workspace grants, refreshed for every run. */
  extraDirs?: string[];
  /** Codex thread id to continue; omit to start a new thread. */
  resumeThreadId?: string;
  /**
   * Called once the thread exists. Codex allocates the id itself (unlike
   * Claude, where the host picks `--session-id`), so the caller can only learn
   * it here — and must store it to resume next time.
   */
  onNativeSessionId?: (threadId: string) => void;
  permissionMode: ProductPermissionMode;
  env?: NodeJS.ProcessEnv;
  /** Extra `codex app-server` args (e.g. `-c mcp_servers.*` overrides). */
  extraArgs?: string[];
  /** Idle watchdog: cancel the run after this many ms with no events (0 = off). */
  idleTimeoutMs?: number;
  deps: CodexRunDeps;
  onEvent: (ev: NormalizedEvent) => void;
}

export interface CodexActiveRun {
  id: string;
  promise: Promise<CodexRunOutcome>;
  cancel(reason?: string): void;
}

/** Rust tracing writes `<rfc3339> LEVEL target: message` to stderr. */
const STDERR_TIMESTAMP = /^\d{4}-\d\d-\d\dT\S+\s+/;
const STDERR_PROBLEM = /\b(?:ERROR|WARN(?:ING)?)\b/;
/** Cap on forwarded stderr notices: stderr is chatty and each one lands in the transcript. */
const STDERR_NOTICE_LIMIT = 20;
const STDERR_NOTICE_MAX_CHARS = 300;

/** Product mode → Codex `AskForApproval`. */
function codexApprovalPolicy(mode: ProductPermissionMode): string {
  switch (mode) {
    case 'ask':
      // Ask before anything the sandbox does not already cover.
      return 'untrusted';
    case 'acceptEdits':
      // Let the model decide; workspace writes are covered by the sandbox.
      return 'on-request';
    case 'bypass':
      return 'never';
  }
}

/** Product mode → Codex `SandboxMode`. */
function codexSandbox(mode: ProductPermissionMode): string {
  return mode === 'bypass' ? 'danger-full-access' : 'workspace-write';
}

function readThreadId(result: unknown): string | null {
  const r = asRecord(result);
  const thread = asRecord(r?.['thread']);
  return readString(thread, 'id') ?? readString(r, 'threadId') ?? readString(r, 'id');
}

function readTurnId(result: unknown): string | null {
  const r = asRecord(result);
  const turn = asRecord(r?.['turn']);
  return readString(turn, 'id') ?? readString(r, 'turnId') ?? readString(r, 'id');
}

export function startCodexRun(req: CodexRunRequest): CodexActiveRun {
  const { permissions, notifier, db } = req.deps;
  const mapper = createCodexStreamMapper((ev) => emit(ev), { resumed: Boolean(req.resumeThreadId) });

  const openTools = new Set<string>();
  const serverRequests = new Map<string | number, string>();
  const fileChanges = new Map<string, unknown>();
  let connection: CodexAppServerConnection | null = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let cancelled = false;
  let cancelReason: string | undefined;
  let lastError: string | null = null;
  let settled = false;
  let lastActivity = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;

  let settle!: (outcome: CodexRunOutcome) => void;
  const promise = new Promise<CodexRunOutcome>((resolve) => {
    settle = resolve;
  });

  /**
   * Wraps the sink so the stream invariant holds regardless of what Codex does:
   * every `tool_use` gets a matching `tool_result` before the terminal event.
   */
  const emit = (ev: NormalizedEvent): void => {
    lastActivity = Date.now();
    if (ev.type === 'tool_use') openTools.add(ev.id);
    else if (ev.type === 'tool_result' && ev.toolUseId) openTools.delete(ev.toolUseId);
    if (ev.type === 'error') lastError = ev.message;
    req.onEvent(ev);
    if (ev.type === 'turn_end') finish(outcomeForTurnStatus(ev.stopReason));
  };

  const closeOpenTools = (): void => {
    for (const id of [...openTools]) {
      emit({
        type: 'tool_result',
        toolUseId: id,
        content: '运行已结束，工具未返回结果',
        isError: true,
        interrupted: true,
      });
    }
    openTools.clear();
  };

  const finish = (outcome: CodexRunOutcome): void => {
    if (settled) return;
    settled = true;
    if (watchdog) clearInterval(watchdog);
    closeOpenTools();
    permissions.clearRun(req.id);
    serverRequests.clear();
    settle(outcome);
  };

  /** A cancel wins over whatever the transport error happened to be. */
  const failureOutcome = (error: string): CodexRunOutcome =>
    cancelled
      ? { status: 'cancelled', exitCode: null, error: cancelReason ?? 'cancelled' }
      : { status: 'failed', exitCode: null, error };

  const seenStderr = new Set<string>();

  /**
   * Codex reports its own operational failures — network unreachable, quota
   * exhausted, sandbox broken — on stderr and nowhere else on the wire. Without
   * this, a run that can never produce output is an endless spinner with no
   * explanation, which is exactly what a blocked network looks like from the
   * phone.
   *
   * Only problem lines are forwarded, deduped and capped, and they are
   * non-terminal: codex is usually retrying underneath, so this informs without
   * ending the run.
   */
  const forwardStderr = (line: string): void => {
    if (settled || !STDERR_PROBLEM.test(line)) return;
    const message = line.replace(STDERR_TIMESTAMP, '').slice(0, STDERR_NOTICE_MAX_CHARS);
    if (seenStderr.has(message) || seenStderr.size >= STDERR_NOTICE_LIMIT) return;
    seenStderr.add(message);
    emit({ type: 'error', code: 'codex_stderr', message: `Codex：${message}`, terminal: false });
  };

  const outcomeForTurnStatus = (status: string): CodexRunOutcome => {
    switch (status) {
      case 'completed':
        return { status: 'succeeded', exitCode: 0, error: null };
      case 'interrupted':
        return { status: 'cancelled', exitCode: null, error: cancelReason ?? null };
      case 'failed':
        return { status: 'failed', exitCode: null, error: lastError ?? 'turn failed' };
      default:
        return { status: 'failed', exitCode: null, error: `unexpected turn status: ${status}` };
    }
  };

  /**
   * Mirror of the auto-allow rules in `routes/permissions.ts`. That route is
   * HTTP/hook-shaped and cannot be reused directly; keep the two in sync until
   * the rule is extracted.
   */
  const autoAllowed = (toolName: string, toolInput: unknown): boolean => {
    if (grantKeyCandidates(toolName).some((key) => db.hasPermissionGrant(req.sessionId, key))) return true;
    if (toolName !== 'Bash') return false;
    const command = readString(asRecord(toolInput), 'command');
    return command !== null && isReadOnlyBash(command);
  };

  /**
   * Answer a server→client request. Approvals block here until the operator
   * decides — that pending promise IS the remote-approval feature. Everything
   * else must still be answered, or Codex waits forever.
   */
  const handleServerRequest = async (method: string, params: unknown, requestId?: string | number): Promise<unknown> => {
    if (settled) throw new Error('run already ended');
    const input = readCodexInput(method, params);
    if (input) {
      const pending = permissions.create(req.id, req.sessionId, 'UserInput', input.toolInput);
      pending.validateResponse = input.validate;
      if (requestId !== undefined) serverRequests.set(requestId, pending.id);
      pending.announced = notifier.emit(req.id, {
        type: 'permission_request', permissionId: pending.id, toolName: pending.toolName,
        toolInput: pending.toolInput, status: pending.status,
      });
      const decided = await permissions.wait(pending.id);
      if (requestId !== undefined) serverRequests.delete(requestId);
      return input.result(decided.status === 'allowed', decided.response);
    }
    const approval = readCodexApproval(method, params, fileChanges);
    if (!approval) throw new Error(`unsupported codex server request: ${method}`);

    if (autoAllowed(approval.toolName, approval.toolInput)) {
      return codexApprovalResult('allow', approval);
    }

    const pending = permissions.create(req.id, req.sessionId, approval.toolName, approval.toolInput);
    if (requestId !== undefined) serverRequests.set(requestId, pending.id);
    pending.announced = notifier.emit(req.id, {
      type: 'permission_request',
      permissionId: pending.id,
      toolName: pending.toolName,
      toolInput: pending.toolInput,
      status: pending.status,
    });
    if (!pending.announced) {
      log.warn(`codex run ${req.id}: no listener for permission ${pending.id}; waiting for a decision anyway`);
    }

    const decided = await permissions.wait(pending.id);
    if (requestId !== undefined) serverRequests.delete(requestId);
    if (decided.status !== 'allowed') return codexApprovalResult('deny', approval);
    return codexApprovalResult(decided.decisionReason === ALLOW_ALL_REASON ? 'allow_all' : 'allow', approval);
  };

  const openThread = async (conn: CodexAppServerConnection): Promise<string> => {
    const params: Record<string, unknown> = {
      cwd: req.cwd,
      sandbox: codexSandbox(req.permissionMode),
      approvalPolicy: codexApprovalPolicy(req.permissionMode),
      ...(req.model ? { model: req.model } : {}),
    };
    const result = req.resumeThreadId
      ? await conn.request('thread/resume', { ...params, threadId: req.resumeThreadId })
      : await conn.request('thread/start', params);
    const id = readThreadId(result);
    if (!id) throw new Error('codex returned no thread id');
    req.onNativeSessionId?.(id);
    return id;
  };

  void (async (): Promise<void> => {
    try {
      const conn = spawnCodexAppServer({
        cwd: req.cwd,
        env: req.env,
        ...(req.extraArgs?.length ? { args: ['app-server', ...req.extraArgs] } : {}),
      });
      connection = conn;
      conn.onNotification((method, params) => {
        // Any notification proves the peer is alive, including the many the
        // mapper drops (output deltas, progress): the watchdog must not kill a
        // long command just because it produced nothing we translate.
        lastActivity = Date.now();
        if (settled) return;
        if (method === 'serverRequest/resolved') {
          const id = asRecord(params)?.['requestId'];
          const pendingId = typeof id === 'string' || typeof id === 'number' ? serverRequests.get(id) : undefined;
          if (pendingId) permissions.decide(pendingId, 'deny', 'resolved by provider');
          return;
        }
        const item = asRecord(asRecord(params)?.['item']);
        const itemId = readString(item, 'id');
        if (method === 'item/started' && item?.['type'] === 'fileChange' && itemId) {
          fileChanges.set(itemId, item['changes']);
        }
        mapper.onNotification(method, params);
        if (method === 'item/completed' && itemId) fileChanges.delete(itemId);
      });
      conn.onServerRequest((method, params, id) => handleServerRequest(method, params, id));
      conn.onStderr(forwardStderr);
      conn.onExit((reason) => {
        // A turn that already ended settles first; this only covers a process
        // that died with the turn still open.
        finish(failureOutcome(reason.message));
      });

      await initializeCodexAppServer(conn, { name: 'paboot', version: VERSION });
      if (settled) return;

      threadId = await openThread(conn);
      if (settled) return;

      mapper.beginTurn();
      const response = await conn.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: req.prompt }],
        // Override on every turn, including resume, so removed workspace grants
        // cannot survive in the thread's previous sandbox configuration.
        sandboxPolicy: req.permissionMode === 'bypass'
          ? { type: 'dangerFullAccess' }
          : { type: 'workspaceWrite', writableRoots: [...new Set([req.cwd, ...(req.extraDirs ?? [])])], networkAccess: false },
        ...(req.model ? { model: req.model } : {}),
        ...(req.modelParameters?.['reasoningEffort']
          ? { effort: req.modelParameters['reasoningEffort'] }
          : {}),
        approvalPolicy: codexApprovalPolicy(req.permissionMode),
        // Ask for reasoning summaries explicitly: without them Codex reports
        // `summary: []` / `content: []` and the phone shows no thinking card at
        // all (`item/reasoning/*` deltas never fire). `concise` suits a phone —
        // the alternatives are `auto`, `detailed` and `none`.
        summary: 'concise',
      });
      turnId = readTurnId(response);
      log.info(`codex run ${req.id}: thread ${threadId} turn ${turnId ?? '?'}`);
    } catch (err) {
      // A cancel landing mid-handshake rejects the in-flight RPC (see `close`),
      // which surfaces here as an error — report it as the cancel it was.
      finish(failureOutcome(err instanceof Error ? err.message : String(err)));
    }
  })();

  const cancel = (reason = 'cancelled'): void => {
    if (settled) return;
    cancelled = true;
    cancelReason = reason;
    // Interrupt first so the thread stays resumable; closing the connection is
    // the guaranteed stop behind it.
    const conn = connection;
    if (conn && threadId && turnId) {
      void conn.request('turn/interrupt', { threadId, turnId }, 5_000).catch(() => undefined);
    }
    void conn?.close();
  };

  // Same watchdog as the argv engine: a run that reports nothing for
  // `idleTimeoutMs` is stuck (app-server wedged, turn never completing), and
  // without this it would hold its process and its `running` row forever.
  const idleTimeoutMs = req.idleTimeoutMs ?? 0;
  if (idleTimeoutMs > 0) {
    const intervalMs = Math.max(1000, Math.min(idleTimeoutMs / 2, 30_000));
    watchdog = setInterval(() => {
      if (Date.now() - lastActivity > idleTimeoutMs) {
        log.warn(`codex run ${req.id} idle for ${idleTimeoutMs}ms, cancelling`);
        cancel('idle timeout');
      }
    }, intervalMs);
    watchdog.unref();
  }

  void promise.finally(() => {
    if (watchdog) clearInterval(watchdog);
    void connection?.close();
  });

  const run = { id: req.id, promise, cancel };
  registerActiveRun(run);
  return run;
}
