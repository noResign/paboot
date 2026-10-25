import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import { toClaudePermissionMode } from '../permission-mode.js';
import { startRun } from './engine.js';
import { startCodexRun } from './codex/session.js';
import { DEEPSEEK_BIN } from './deepseek/detect.js';
import { startDeepSeekRun } from './deepseek/session.js';
import { createCommandDriver } from './command.js';
import { codexToolServerArgs, taskToolServer } from '../tool-server.js';
import { defaultCapabilities, type RuntimeAdapter, type RuntimeCapabilities } from './types.js';
import type { Registry } from './registry.js';
import type { RuntimeDriver } from './RuntimeDriver.js';

/**
 * Execution drivers keyed by runtime id. argv-driven runtimes (Claude) reuse the
 * generic `engine.startRun`; each RPC-driven runtime (Codex, DeepSeek Harness)
 * supplies its own. This is the single wiring point — adding a runtime means
 * registering a driver here, not editing the chat route.
 */
export function registerRuntimeDrivers(registry: Registry, ctx: AppContext): void {
  const capabilities = (id: string): RuntimeCapabilities =>
    registry.detection(id)?.capabilities ?? defaultCapabilities;

  for (const adapter of registry.adapters()) {
    registry.registerDriver(createArgvDriver(adapter, { ctx, capabilities }));
  }
  registry.registerDriver(createCodexDriver(ctx));
  registry.registerDriver(createDeepSeekDriver(ctx));
  registry.registerDriver(createCommandDriver({ idleTimeoutMs: ctx.config.runIdleTimeoutMs }));
}

interface ArgvDriverDeps {
  ctx: AppContext;
  capabilities(id: string): RuntimeCapabilities;
}

/** argv runtime: build the `startRun` request the generic engine expects. */
function createArgvDriver(adapter: RuntimeAdapter, deps: ArgvDriverDeps): RuntimeDriver {
  const { config, hookPath } = deps.ctx;
  const daemonHost = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  const daemonUrl = `${config.tls ? 'https' : 'http'}://${daemonHost}:${config.port}`;

  return {
    id: adapter.id,
    start(req) {
      const capabilities = deps.capabilities(adapter.id);
      // Host-picking runtimes (Claude `--session-id`) name the session up front
      // so it can be resumed later; a runtime that allocates its own id reports
      // it through `onNativeSessionId` instead.
      const newSessionId =
        !req.resumeNativeSessionId && capabilities.sessionId ? randomUUID() : undefined;
      if (newSessionId) req.onNativeSessionId(newSessionId);

      return startRun({
        id: req.runId,
        adapter,
        prompt: req.prompt,
        cwd: req.cwd,
        model: req.model,
        modelParameters: req.modelParameters,
        resumeSessionId: req.resumeNativeSessionId,
        newSessionId,
        permissionMode: toClaudePermissionMode(req.permissionMode),
        capabilities,
        env: process.env,
        extraDirs: req.extraDirs,
        toolServers: [taskToolServer(deps.ctx, req.runId)],
        permissionHook:
          req.permissionMode === 'bypass'
            ? undefined
            : {
                hookPath,
                daemonUrl,
                token: config.token,
                timeoutMs: config.permissionTimeoutMs,
                matcher:
                  req.permissionMode === 'ask'
                    ? 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebSearch|WebFetch|mcp__.*'
                    : 'Bash|WebSearch|WebFetch|mcp__.*',
              },
        idleTimeoutMs: config.runIdleTimeoutMs,
        onEvent: req.onEvent,
      });
    },
  };
}

/** RPC runtime: Codex drives `codex app-server` and reports its own thread id. */
function createCodexDriver(ctx: AppContext): RuntimeDriver {
  return {
    id: 'codex',
    start(req) {
      return startCodexRun({
        id: req.runId,
        sessionId: req.sessionId,
        prompt: req.prompt,
        cwd: req.cwd,
        model: req.model,
        modelParameters: req.modelParameters,
        resumeThreadId: req.resumeNativeSessionId,
        extraDirs: req.extraDirs,
        onNativeSessionId: req.onNativeSessionId,
        permissionMode: req.permissionMode,
        env: process.env,
        extraArgs: codexToolServerArgs([taskToolServer(ctx, req.runId)]),
        idleTimeoutMs: ctx.config.runIdleTimeoutMs,
        deps: { permissions: ctx.permissions, notifier: ctx.notifier, db: ctx.db },
        onEvent: req.onEvent,
      });
    },
  };
}

/** RPC runtime: DeepSeek Harness drives `dsh acp` and allocates its own session id. */
function createDeepSeekDriver(ctx: AppContext): RuntimeDriver {
  return {
    id: 'deepseek',
    start(req) {
      return startDeepSeekRun({
        id: req.runId,
        sessionId: req.sessionId,
        prompt: req.prompt,
        cwd: req.cwd,
        model: req.model,
        modelParameters: req.modelParameters,
        resumeSessionId: req.resumeNativeSessionId,
        onNativeSessionId: req.onNativeSessionId,
        permissionMode: req.permissionMode,
        env: process.env,
        bin: DEEPSEEK_BIN,
        toolServers: [taskToolServer(ctx, req.runId)],
        idleTimeoutMs: ctx.config.runIdleTimeoutMs,
        deps: { permissions: ctx.permissions, notifier: ctx.notifier, db: ctx.db },
        onEvent: req.onEvent,
      });
    },
  };
}
