import { registerActiveRun } from './active-runs.js';
export { getActiveRun, listActiveRuns } from './active-runs.js';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { NormalizedEvent } from '../types/api.js';
import { spawnExecutable } from '../platform/executable.js';
import { log } from '../platform/log.js';
import { killProcessTree } from '../platform/process-tree.js';
import { quoteCommandArg } from '../platform/shell.js';
import type {
  EncodedImage,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeImageInput,
  StreamParser,
  SpawnContext,
  ToolServerSpec,
} from './types.js';

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
  /** Native system-prompt context, when the runtime advertises support. */
  systemContext?: string;
  /** Idle watchdog: cancel the run after this many ms with no events (0 = off). */
  idleTimeoutMs?: number;
  /** Daemon data dir; per-run files (the hook settings) are written here. */
  dataDir: string;
  /** Image attachments for the initial user turn. */
  images?: RuntimeImageInput[];
  /**
   * Called once the runtime confirms the native session id. A host-picking
   * runtime (Claude `--session-id`) only proves the conversation exists when it
   * emits its init event; writing the id earlier leaves a ghost that a later
   * resume cannot attach to.
   */
  onNativeSessionId?: (id: string) => void;
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

  let encodedImages: EncodedImage[] = [];
  try {
    encodedImages = (req.images ?? []).map((image) => ({
      mediaType: image.mediaType,
      data: fs.readFileSync(image.storagePath).toString('base64'),
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`run ${req.id}: failed to read image attachment: ${message}`);
    return {
      id: req.id,
      promise: Promise.resolve({
        status: 'failed',
        exitCode: null,
        error: `failed to read image attachment: ${message}`,
      }),
      cancel: () => undefined,
      writeUserMessage: () => undefined,
    };
  }

  const closeStdin = (): void => {
    if (stdinClosed || !child) return;
    stdinClosed = true;
    if (child.stdin && !child.stdin.destroyed) child.stdin.end();
  };

  const settingsJson =
    req.permissionHook && req.capabilities.permissionHook
      ? JSON.stringify({
          // Omitting reads from the hook does not grant CLI permission to read
          // outside the working directories. Explicit allow rules do that;
          // user/managed deny and ask rules still take precedence.
          //
          // The memory server self-gates inside its own process (see
          // mcp/gate.ts); it is excluded from the PreToolUse matcher. Claude
          // still needs its own allow rule, otherwise the call is denied before
          // the server can ask the operator (which looked like「没有授权」with no
          // prompt). `paboot_tasks` stays out: its tools are hook-gated.
          permissions: {
            // One rule per self-gated server, so adding a tool never requires
            // touching this list. `mcp__<server>__*` is Claude Code's supported
            // allow-glob form.
            allow: ['Read', 'Grep', 'mcp__paboot_memory__*'],
          },
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
                    // Quoted: the daemon's install path (or the user name) may
                    // contain spaces, and Claude runs this through a shell.
                    command: `${quoteCommandArg(process.execPath)} ${quoteCommandArg(req.permissionHook.hookPath)}`,
                    timeout: Math.ceil((req.permissionHook.timeoutMs + 30_000) / 1000),
                  },
                ],
              },
            ],
          },
        })
      : null;

  // Hand Claude a file instead of inline JSON. A Windows npm `.cmd` shim goes
  // through cmd.exe a second time, and the matcher's `|` separators would be
  // read as pipes there. The file lives in the daemon data dir (not os.tmpdir)
  // and is removed when the run ends, including spawn failures and cancels.
  let settingsPath: string | undefined;
  if (settingsJson !== null) {
    const safeId = req.id.replace(/[^A-Za-z0-9._-]/g, '_');
    const candidate = path.join(req.dataDir, `.run-${safeId}-settings.json`);
    try {
      fs.writeFileSync(candidate, settingsJson, { mode: 0o600 });
      settingsPath = candidate;
    } catch (err) {
      log.warn(`run ${req.id}: could not write the hook settings file; falling back to inline JSON`, err);
    }
  }
  const hookSettings =
    settingsJson !== null
      ? { settingsJson, ...(settingsPath ? { settingsPath } : {}) }
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
    systemContext: req.systemContext,
  };

  const args = req.adapter.buildArgs(ctx);

  // Tool calls the runtime opened but never returned a result for. They are
  // closed explicitly when the run ends (see `closeOpenTools`), so a run's
  // stream is always well-formed: an unmatched `tool_use` renders as a
  // forever-spinning card, and that state survives into the persisted replay.
  const openTools = new Set<string>();
  let nativeIdReported = false;

  const emit = (ev: NormalizedEvent): void => {
    lastActivity = Date.now();
    if (ev.type === 'tool_use') {
      openTools.add(ev.id);
    } else if (ev.type === 'tool_result' && ev.toolUseId) {
      openTools.delete(ev.toolUseId);
    } else if (!nativeIdReported && ev.type === 'status' && ev.sessionId) {
      // Claude's `system/init` is the first proof that the conversation exists.
      // Persisting the generated id before this point leaves a ghost id when the
      // CLI never starts, which every later resume then fails against.
      nativeIdReported = true;
      try {
        req.onNativeSessionId?.(ev.sessionId);
      } catch (err) {
        log.warn(`run ${req.id}: failed to persist the native session id`, err);
      }
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
    const p = spawnExecutable(req.adapter.bin, args, {
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
      p.stdin?.write(req.adapter.encodeUserMessage(req.prompt, encodedImages));
    } else {
      p.stdin?.end(req.adapter.encodeUserMessage(req.prompt, encodedImages));
    }
  });

  const cancel = (reason = 'cancelled'): void => {
    if (cancelled) return;
    cancelled = true;
    cancelReason = reason;
    if (child && child.exitCode === null && child.signalCode === null) {
      killProcessTree(child, { signal: 'SIGTERM' });
      setTimeout(() => {
        if (child && child.exitCode === null && child.signalCode === null) {
          killProcessTree(child, { signal: 'SIGKILL' });
        }
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
  void promise
    .finally(() => {
      if (watchdog) clearInterval(watchdog);
      if (settingsPath) {
        try {
          fs.rmSync(settingsPath, { force: true });
        } catch (err) {
          log.warn(`run ${req.id}: could not remove the hook settings file`, err);
        }
      }
    })
    // The cleanup itself must not surface as an unhandled rejection; the run
    // outcome is delivered through `promise` to the caller.
    .catch(() => {});
  return run;
}
