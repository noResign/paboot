import { spawn } from 'node:child_process';
import { log } from '../platform/log.js';
import { registerActiveRun, type ManagedRun } from './active-runs.js';
import type { RunOutcome } from './engine.js';
import type { RuntimeDriver } from './RuntimeDriver.js';

/**
 * Runs a fixed shell command with no agent. It reuses the whole run pipeline
 * (checkpoint, events, cancel, replay) so a command task's history and diff are
 * as inspectable as an AI run's.
 *
 * Output is streamed as `text_delta` (so it lands in the transcript and the
 * aggregated assistant message); the matching `tool_result` only carries the
 * exit status, avoiding a second copy of the output in the UI.
 */
export function createCommandDriver(options: { idleTimeoutMs?: number } = {}): RuntimeDriver {
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;

  return {
    id: 'command',
    requiresDetection: false,
    internal: true,
    start(req) {
      const toolUseId = `${req.runId}-command`;
      let settled = false;
      let cancelled: string | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      let idleTimer: NodeJS.Timeout | null = null;
      let exitCode: number | null = null;

      req.onEvent({ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: req.prompt } });

      const child = spawn('/bin/sh', ['-c', req.prompt], {
        cwd: req.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A shell runs the command as its own child; killing only the shell
        // leaves that child holding the pipes open. A dedicated process group
        // lets cancellation take the whole tree down.
        detached: true,
      });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      const killTree = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) {
          child.kill(signal);
          return;
        }
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      };

      const cancel = (reason = 'cancelled'): void => {
        if (settled || cancelled !== null) return;
        cancelled = reason;
        killTree('SIGTERM');
        killTimer = setTimeout(() => {
          if (!settled) killTree('SIGKILL');
        }, 3000);
        killTimer.unref();
      };

      const resetIdle = (): void => {
        if (idleTimeoutMs <= 0) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => cancel('idle timeout'), idleTimeoutMs);
        idleTimer.unref();
      };

      const clearTimers = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        if (killTimer) clearTimeout(killTimer);
        idleTimer = null;
        killTimer = null;
      };

      const finish = (code: number | null, error: string | null): RunOutcome => {
        if (settled) return { status: 'cancelled', exitCode: code, error: cancelled };
        settled = true;
        clearTimers();
        const isError = cancelled !== null || code !== 0;
        req.onEvent({
          type: 'tool_result',
          toolUseId,
          content: code === null ? 'command terminated' : `exit code ${code}`,
          isError,
          ...(cancelled !== null ? { interrupted: true } : {}),
        });
        if (cancelled !== null) return { status: 'cancelled', exitCode: code, error: cancelled };
        if (code === 0) return { status: 'succeeded', exitCode: 0, error: null };
        return { status: 'failed', exitCode: code, error: error ?? `command exited with code ${code ?? 'unknown'}` };
      };

      let resolveOutcome!: (outcome: RunOutcome) => void;
      const promise = new Promise<RunOutcome>((resolve) => {
        resolveOutcome = resolve;
      });

      child.stdout?.on('data', (chunk: string) => {
        resetIdle();
        req.onEvent({ type: 'text_delta', delta: chunk });
      });
      child.stderr?.on('data', (chunk: string) => {
        resetIdle();
        req.onEvent({ type: 'text_delta', delta: chunk });
      });
      child.on('error', (err) => {
        log.warn(`command run ${req.runId} failed to spawn`, err);
        resolveOutcome(finish(exitCode, err.message));
      });
      child.on('close', (code) => {
        exitCode = code;
        resolveOutcome(finish(code, null));
      });

      resetIdle();
      const run: ManagedRun<RunOutcome> = { id: req.runId, promise, cancel };
      registerActiveRun(run);
      return run;
    },
  };
}
