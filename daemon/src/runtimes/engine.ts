import { registerActiveRun } from './active-runs.js';
export { getActiveRun, listActiveRuns } from './active-runs.js';
import { spawn, type ChildProcess } from 'node:child_process';
import type { NormalizedEvent } from '../types/api.js';
import { log } from '../platform/log.js';
import type { RuntimeAdapter, RuntimeCapabilities, StreamParser, SpawnContext, ToolServerSpec } from './types.js';

export type RunStatus = 'succeeded' | 'failed' | 'cancelled';

export interface RunOutcome {
  status: RunStatus;
  exitCode: number | null;
  error: string | null;
}

export interface RunRequest {
  id: string;
  adapter: RuntimeAdapter;
  prompt: string;
  cwd: string;
  model?: string;
  modelParameters?: Record<string, string>;
  resumeSessionId?: string;
  newSessionId?: string;
  permissionMode: string;
  capabilities: RuntimeCapabilities;
  env: NodeJS.ProcessEnv;
  /** Extra dirs beyond `cwd` this run may touch (workspace's granted dirs). */
  extraDirs?: string[];
  /** Wiring for the PreToolUse permission hook (ignored when unsupported). */
  permissionHook?: { hookPath: string; daemonUrl: string; token: string; timeoutMs: number; matcher: string };
  /** External tool servers (MCP) to expose to the agent. */
  toolServers?: ToolServerSpec[];
  /** Idle watchdog: cancel the run after this many ms with no events (0 = off). */
  idleTimeoutMs?: number;
  onEvent: (ev: NormalizedEvent) => void;
}

export interface ActiveRun {
  id: string;
  promise: Promise<RunOutcome>;
  cancel(reason?: string): void;
  writeUserMessage(text: string): void;
}

/**
 * Generic run lifecycle, independent of any runtime. It owns spawn, stdio
 * wiring, cancellation, and exit classification; the adapter supplies the argv
 * and the stdout parser. This is the piece that lets a future runtime slot in
 * without touching transport or persistence.
 */
export function startRun(req: RunRequest): ActiveRun {
  let child: ChildProcess | null = null;
  let cancelled = false;
  let cancelReason: string | undefined;
  let stdinClosed = false;
  let stderrTail = '';
  let lastActivity = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;

  const closeStdin = (): void => {
    if (stdinClosed || !child) return;
    stdinClosed = true;
    if (child.stdin && !child.stdin.destroyed) child.stdin.end();
  };

  const hookSettings = req.permissionHook && req.capabilities.permissionHook
    ? {
        settingsJson: JSON.stringify({
          // Omitting reads from the hook does not grant CLI permission to read
          // outside the working directories. Explicit allow rules do that;
          // user/managed deny and ask rules still take precedence.
          permissions: { allow: ['Read', 'Grep'] },
          hooks: {
            PreToolUse: [
              {
                // `ask` gates Bash + Write/Edit; `acceptEdits` gates Bash.
                // WebSearch/WebFetch are gated in both (they send context
                // off-device), and MCP tools (mcp__*) always are, since their
                // side effects are arbitrary and match no edit-ish category.
                // The matcher is chosen by the chat route per session.
                matcher: req.permissionHook.matcher || 'Bash',
                hooks: [
                  {
                    type: 'command',
                    command: `${process.execPath} ${req.permissionHook.hookPath}`,
                    timeout: Math.ceil((req.permissionHook.timeoutMs + 30_000) / 1000),
                  },
                ],
              },
            ],
          },
        }),
      }
    : undefined;

  const spawnEnv: NodeJS.ProcessEnv = { ...req.env };
  if (hookSettings && req.permissionHook) {
    spawnEnv.PABOOT_DAEMON_URL = req.permissionHook.daemonUrl;
    spawnEnv.PABOOT_TOKEN = req.permissionHook.token;
    spawnEnv.PABOOT_RUN_ID = req.id;
    spawnEnv.PABOOT_PERMISSION_TIMEOUT_MS = String(req.permissionHook.timeoutMs);
  }

  // `--add-dir` support is probed from `--help`; on a CLI without it the extra
  // dirs are silently dropped, which would look like a dir the user approved
  // being mysteriously ignored — so say it out loud.
  if (req.extraDirs?.length && !req.capabilities.addDir) {
    log.warn(`[${req.adapter.id}] no --add-dir support; ignoring ${req.extraDirs.length} extra dir(s) for run ${req.id}`);
  }

  const ctx: SpawnContext = {
    prompt: req.prompt,
    cwd: req.cwd,
    model: req.model,
    modelParameters: req.modelParameters,
    resumeSessionId: req.resumeSessionId,
    newSessionId: req.newSessionId,
    permissionMode: req.permissionMode,
    env: spawnEnv,
    capabilities: req.capabilities,
    extraDirs: req.extraDirs,
    permissionHook: hookSettings,
    toolServers: req.toolServers,
  };

  const args = req.adapter.buildArgs(ctx);

  // Tool calls the runtime opened but never returned a result for. They are
  // closed explicitly when the run ends (see `closeOpenTools`), so a run's
  // stream is always well-formed: an unmatched `tool_use` renders as a
  // forever-spinning card, and that state survives into the persisted replay.
  const openTools = new Set<string>();

  const emit = (ev: NormalizedEvent): void => {
    lastActivity = Date.now();
    if (ev.type === 'tool_use') {
      openTools.add(ev.id);
    } else if (ev.type === 'tool_result' && ev.toolUseId) {
      openTools.delete(ev.toolUseId);
    }
    req.onEvent(ev);
    // A clean turn boundary (non tool_use stop_reason) means the runtime is
    // done with this stdin session; close it so the child can exit.
    if (ev.type === 'turn_end' && ev.stopReason !== 'tool_use') {
      closeStdin();
    }
  };

  const parser: StreamParser = req.adapter.createParser(emit);

  /**
   * Close every tool call that never got a result. A cancel, a crash and the
   * idle watchdog all end a run while a tool is still in flight, and the runtime
   * only writes a `tool_result` once the call returns — so without this the
   * stream would end on an unmatched `tool_use`.
   */
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

  const promise = new Promise<RunOutcome>((resolve) => {
    const p = spawn(req.adapter.bin, args, {
      cwd: req.cwd,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = p;

    p.stdout?.setEncoding('utf8');
    p.stdout?.on('data', (chunk: string) => parser.feed(chunk));

    p.stderr?.setEncoding('utf8');
    p.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
      log.warn(`[${req.adapter.id}] ${chunk.trimEnd()}`);
    });

    p.on('error', (err) => {
      closeOpenTools();
      resolve({
        status: 'failed',
        exitCode: null,
        error: `failed to spawn ${req.adapter.bin}: ${err.message}`,
      });
    });

    p.on('exit', (code, signal) => {
      try {
        parser.flush();
      } catch (err) {
        log.warn('parser flush error', err);
      }
      closeOpenTools();
      if (cancelled) {
        resolve({ status: 'cancelled', exitCode: code, error: cancelReason ?? 'cancelled' });
      } else if (code === 0) {
        resolve({ status: 'succeeded', exitCode: code, error: null });
      } else {
        const detail = stderrTail.trim() || `exit code ${code}${signal ? ` (${signal})` : ''}`;
        resolve({ status: 'failed', exitCode: code, error: detail });
      }
    });

    if (req.adapter.keepStdinOpen) {
      p.stdin?.write(req.adapter.encodeUserMessage(req.prompt));
    } else {
      p.stdin?.end(req.adapter.encodeUserMessage(req.prompt));
    }
  });

  const cancel = (reason = 'cancelled'): void => {
    if (cancelled) return;
    cancelled = true;
    cancelReason = reason;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 3000).unref();
    }
  };

  const writeUserMessage = (text: string): void => {
    if (child && child.stdin && !child.stdin.destroyed && !stdinClosed) {
      child.stdin.write(req.adapter.encodeUserMessage(text));
    }
  };

  // Idle watchdog: a run that produces no events for `idleTimeoutMs` is almost
  // certainly stuck (e.g. the child never exited), so cancel it instead of
  // leaking the process forever.
  const idleTimeoutMs = req.idleTimeoutMs ?? 0;
  if (idleTimeoutMs > 0) {
    const intervalMs = Math.max(1000, Math.min(idleTimeoutMs / 2, 30_000));
    watchdog = setInterval(() => {
      if (Date.now() - lastActivity > idleTimeoutMs) {
        log.warn(`run ${req.id} idle for ${idleTimeoutMs}ms, cancelling`);
        cancel('idle timeout');
      }
    }, intervalMs);
    watchdog.unref();
  }

  const run: ActiveRun = { id: req.id, promise, cancel, writeUserMessage };
  registerActiveRun(run);
  void promise.finally(() => {
    if (watchdog) clearInterval(watchdog);
  });
  return run;
}
