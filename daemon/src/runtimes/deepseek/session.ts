import { registerActiveRun } from '../active-runs.js';
import { grantKeyCandidates } from '../../permissions/tool-grants.js';
import { log } from '../../platform/log.js';
import type { ProductPermissionMode } from '../../permissions/permission-mode.js';
import type { PermissionManager } from '../../permissions/permissions.js';
import type { RunNotifier } from '../../runs/run-notifier.js';
import type { NormalizedEvent } from '../../types/api.js';
import type { ToolServerSpec } from '../types.js';
import { asRecord, createDeepSeekStreamMapper, mapToolName, readString } from './map.js';
import { normalizeModelValue } from './models.js';
import { initializeDeepSeekAcp, spawnDeepSeekAcp } from './rpc.js';
import type { StdioRpcConnection } from '../stdio-rpc.js';

/**
 * One DeepSeek Harness run: spawn `dsh acp`, create or resume one ACP session,
 * submit one prompt, translate updates, and settle when the prompt does.
 *
 * This is the RPC-driven path (like `codex/session.ts`), not the argv engine:
 * ACP is a peer protocol with its own session lifecycle, server-initiated
 * permission requests, and a prompt-response terminal signal instead of
 * process exit.
 */

export interface DeepSeekRunOutcome {
  status: 'succeeded' | 'failed' | 'cancelled';
  exitCode: number | null;
  error: string | null;
}

export interface DeepSeekRunDeps {
  permissions: PermissionManager;
  notifier: Pick<RunNotifier, 'emit'>;
  db: { hasPermissionGrant(sessionId: string, toolName: string): boolean };
}

export interface DeepSeekRunRequest {
  id: string;
  sessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  modelParameters?: Record<string, string>;
  /** DSH session id to resume; omit to create a fresh ACP session. */
  resumeSessionId?: string;
  /** Called with the server-assigned ACP session id so it can be persisted. */
  onNativeSessionId?: (sessionId: string) => void;
  permissionMode: ProductPermissionMode;
  env?: NodeJS.ProcessEnv;
  /** `dsh` executable (defaults to the caller's resolved bin). */
  bin: string;
  /** MCP servers to expose to the harness (the shared `paboot_tasks`). */
  toolServers?: ToolServerSpec[];
  /** Idle watchdog: cancel the run after this many ms with no events (0 = off). */
  idleTimeoutMs?: number;
  deps: DeepSeekRunDeps;
  onEvent: (ev: NormalizedEvent) => void;
}

export interface DeepSeekActiveRun {
  id: string;
  promise: Promise<DeepSeekRunOutcome>;
  cancel(reason?: string): void;
}

const STDERR_PROBLEM = /\b(?:ERROR|WARN(?:ING)?|failed|error)\b/i;
const STDERR_NOTICE_LIMIT = 20;
const STDERR_NOTICE_MAX_CHARS = 300;
const SESSION_CLOSE_TIMEOUT_MS = 5_000;

/**
 * paboot's product modes map onto DSH's own permission presets, which are read
 * from `DSH_PERMISSION_MODE` at process start
 * (`packages/bundle/base/cordis.patch.yml`). Per-run processes make this exact:
 * `read-only` keeps writes/commands behind escalation approvals, while
 * `danger-full-access` turns approval policy to `never`.
 */
function dshPermissionMode(mode: ProductPermissionMode): string {
  switch (mode) {
    case 'ask':
      return 'read-only';
    case 'acceptEdits':
      return 'workspace-write';
    case 'bypass':
      return 'danger-full-access';
  }
}

/** ACP stdio MCP entries: absolute command, args, and name/value env pairs. */
function toAcpMcpServers(servers: ToolServerSpec[]): unknown[] {
  return servers.map((server) => ({
    name: server.name,
    command: server.command,
    args: server.args,
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  }));
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Pick the server-offered option whose kind starts with `allow` / `reject`. */
function offeredOptionId(options: unknown, prefix: 'allow' | 'reject'): string | null {
  if (!Array.isArray(options)) return null;
  for (const option of options) {
    const record = asRecord(option);
    const kind = readString(record, 'kind');
    const optionId = readString(record, 'optionId');
    if (optionId && kind?.startsWith(prefix)) return optionId;
  }
  return null;
}

/** Tools whose edits are auto-approved under `acceptEdits`. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

export function startDeepSeekRun(req: DeepSeekRunRequest): DeepSeekActiveRun {
  const { permissions, notifier, db } = req.deps;

  const openTools = new Set<string>();
  let connection: StdioRpcConnection | null = null;
  let acpSessionId: string | null = null;
  let cancelled = false;
  let cancelReason: string | undefined;
  let settled = false;
  let lastActivity = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;

  let settle!: (outcome: DeepSeekRunOutcome) => void;
  const promise = new Promise<DeepSeekRunOutcome>((resolve) => {
    settle = resolve;
  });

  /** Keep the stream well-formed no matter where the run ends. */
  const emit = (ev: NormalizedEvent): void => {
    lastActivity = Date.now();
    if (ev.type === 'tool_use') openTools.add(ev.id);
    else if (ev.type === 'tool_result' && ev.toolUseId) openTools.delete(ev.toolUseId);
    req.onEvent(ev);
  };

  const mapper = createDeepSeekStreamMapper((ev) => emit(ev));

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

  const finish = (outcome: DeepSeekRunOutcome): void => {
    if (settled) return;
    settled = true;
    if (watchdog) clearInterval(watchdog);
    closeOpenTools();
    permissions.clearRun(req.id);
    settle(outcome);
  };

  /** A cancel wins over whatever transport error happened to be in flight. */
  const failureOutcome = (error: string): DeepSeekRunOutcome =>
    cancelled
      ? { status: 'cancelled', exitCode: null, error: cancelReason ?? 'cancelled' }
      : { status: 'failed', exitCode: null, error };

  const outcomeForStop = (stopReason: string): DeepSeekRunOutcome => {
    if (stopReason === 'cancelled' || cancelled) {
      return { status: 'cancelled', exitCode: null, error: cancelReason ?? null };
    }
    return { status: 'succeeded', exitCode: 0, error: null };
  };

  const seenStderr = new Set<string>();
  /**
   * DSH reports its own operational failures (missing credential, provider
   * outage, broken sandbox) on stderr. Surface only problem lines, deduped and
   * capped; they are non-terminal because the harness may still be retrying.
   */
  const forwardStderr = (line: string): void => {
    if (settled || !STDERR_PROBLEM.test(line)) return;
    const message = line.slice(0, STDERR_NOTICE_MAX_CHARS);
    if (seenStderr.has(message) || seenStderr.size >= STDERR_NOTICE_LIMIT) return;
    seenStderr.add(message);
    emit({ type: 'error', code: 'deepseek_stderr', message: `DeepSeek Harness：${message}`, terminal: false });
  };

  const autoAllowed = (toolName: string): boolean => {
    if (req.permissionMode === 'bypass') return true;
    if (grantKeyCandidates(toolName).some((key) => db.hasPermissionGrant(req.sessionId, key))) return true;
    return req.permissionMode === 'acceptEdits' && EDIT_TOOLS.has(toolName);
  };

  /**
   * ACP asks are one-shot and carry only the tool-call id. The bridge sends the
   * `tool_call` update first (it drains updates before asking), so the cached
   * name/arguments are what makes the paboot approval card readable.
   */
  const handlePermissionRequest = async (params: unknown): Promise<unknown> => {
    if (settled) throw new Error('run already ended');
    const request = asRecord(params);
    const call = asRecord(request?.['toolCall']);
    const callId = readString(call, 'toolCallId') ?? '';
    const info = callId ? mapper.toolCall(callId) : undefined;
    const rawName = info?.name ?? readString(call, 'name') ?? readString(call, 'title') ?? 'tool';
    const toolName = mapToolName(rawName);
    const toolInput = info?.input ?? call?.['rawInput'] ?? {};
    const options = request?.['options'];

    const allowOption = offeredOptionId(options, 'allow');
    const rejectOption = offeredOptionId(options, 'reject');

    if (autoAllowed(toolName)) {
      return allowOption
        ? { outcome: { outcome: 'selected', optionId: allowOption } }
        : { outcome: { outcome: 'cancelled' } };
    }

    const pending = permissions.create(req.id, req.sessionId, toolName, toolInput);
    const announced = notifier.emit(req.id, {
      type: 'permission_request',
      permissionId: pending.id,
      toolName: pending.toolName,
      toolInput: pending.toolInput,
      status: pending.status,
    });
    if (!announced) {
      log.warn(`deepseek run ${req.id}: no listener for permission ${pending.id}; waiting for a decision anyway`);
    }

    const decided = await permissions.wait(pending.id);
    if (decided.status === 'allowed' && allowOption) {
      return { outcome: { outcome: 'selected', optionId: allowOption } };
    }
    if (rejectOption) return { outcome: { outcome: 'selected', optionId: rejectOption } };
    return { outcome: { outcome: 'cancelled' } };
  };

  const handleServerRequest = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'session/request_permission') return handlePermissionRequest(params);
    throw new Error(`unsupported dsh server request: ${method}`);
  };

  const sessionParams = (): Record<string, unknown> => ({
    cwd: req.cwd,
    // ACP rejects `additionalDirectories`; escalation approvals are the only
    // path outside the session workspace.
    mcpServers: toAcpMcpServers(req.toolServers ?? []),
  });

  void (async (): Promise<void> => {
    try {
      const env: NodeJS.ProcessEnv = {
        ...(req.env ?? process.env),
        DSH_PERMISSION_MODE: dshPermissionMode(req.permissionMode),
        // The ACP profile owns stdout; keep ANSI out of the stderr notices.
        NO_COLOR: '1',
      };
      const conn = spawnDeepSeekAcp({ bin: req.bin, cwd: req.cwd, env });
      connection = conn;
      conn.onNotification((method, params) => {
        // Any notification proves the peer is alive, including the ones the
        // mapper drops: the watchdog must not kill a long command.
        lastActivity = Date.now();
        if (settled) return;
        if (method !== 'session/update') return;
        const update = asRecord(params);
        if (!update) return;
        mapper.onUpdate(update['update']);
      });
      conn.onServerRequest((method, params) => handleServerRequest(method, params));
      conn.onStderr(forwardStderr);
      conn.onExit((reason) => finish(failureOutcome(reason.message)));

      await initializeDeepSeekAcp(conn);
      if (settled || cancelled) return;

      const result = req.resumeSessionId
        ? await conn.request(
            'session/resume',
            { sessionId: req.resumeSessionId, ...sessionParams() },
            60_000,
          )
        : await conn.request('session/new', sessionParams(), 60_000);
      if (settled || cancelled) return;

      acpSessionId = req.resumeSessionId ?? readString(asRecord(result), 'sessionId');
      if (!acpSessionId) throw new Error('dsh acp returned no session id');
      if (!req.resumeSessionId) req.onNativeSessionId?.(acpSessionId);

      if (req.model) {
        await conn.request(
          'session/set_config_option',
          { sessionId: acpSessionId, configId: 'model', value: normalizeModelValue(req.model) },
          60_000,
        );
      }
      const effort = req.modelParameters?.['reasoningEffort'];
      if (effort) {
        await conn.request(
          'session/set_config_option',
          { sessionId: acpSessionId, configId: 'reasoning_effort', value: effort },
          60_000,
        );
      }
      if (settled || cancelled) return;

      log.info(`deepseek run ${req.id}: acp session ${acpSessionId}`);
      const response = await conn.request(
        'session/prompt',
        { sessionId: acpSessionId, prompt: [{ type: 'text', text: req.prompt }] },
        0,
      );
      if (settled) return;

      const usage = asRecord(asRecord(response)?.['usage']);
      if (usage) {
        const input = readNumber(usage, 'inputTokens');
        const output = readNumber(usage, 'outputTokens');
        const total = readNumber(usage, 'totalTokens');
        emit({
          type: 'usage',
          usage: {
            ...(input !== null ? { input_tokens: input } : {}),
            ...(output !== null ? { output_tokens: output } : {}),
            ...(total !== null ? { total_tokens: total } : {}),
          },
        });
      }

      const stopReason = readString(asRecord(response), 'stopReason') ?? 'end_turn';
      emit({ type: 'turn_end', stopReason });

      // ACP settles only after updates drain, so closing here persists the
      // complete turn before this run is reported terminal. A cancelled prompt
      // also settles here once its activity quiesces.
      try {
        await conn.request('session/close', { sessionId: acpSessionId }, SESSION_CLOSE_TIMEOUT_MS);
      } catch {
        // The process may already be tearing down after a cancel.
      }
      finish(outcomeForStop(stopReason));
    } catch (err) {
      finish(failureOutcome(err instanceof Error ? err.message : String(err)));
    } finally {
      await connection?.close();
    }
  })();

  const cancel = (reason = 'cancelled'): void => {
    if (settled) return;
    cancelled = true;
    cancelReason = reason;
    const conn = connection;
    if (!conn) return;
    if (!acpSessionId) {
      // Cancelled during the handshake: closing stdin is the only stop.
      void conn.close();
      return;
    }
    try {
      conn.notify('session/cancel', { sessionId: acpSessionId });
    } catch {
      // The connection is already gone; the close below is enough.
    }
    // A cancelled prompt normally settles immediately; force the process down
    // if the provider does not answer.
    setTimeout(() => void conn.close(), SESSION_CLOSE_TIMEOUT_MS).unref();
  };

  const idleTimeoutMs = req.idleTimeoutMs ?? 0;
  if (idleTimeoutMs > 0) {
    const intervalMs = Math.max(1000, Math.min(idleTimeoutMs / 2, 30_000));
    watchdog = setInterval(() => {
      // ACP carries no live tool output: a long command legitimately produces
      // no notification until it finishes, so an open tool call is activity.
      if (openTools.size > 0) return;
      if (Date.now() - lastActivity > idleTimeoutMs) {
        log.warn(`deepseek run ${req.id} idle for ${idleTimeoutMs}ms, cancelling`);
        cancel('idle timeout');
      }
    }, intervalMs);
    watchdog.unref();
  }

  const run = { id: req.id, promise, cancel };
  registerActiveRun(run);
  return run;
}
