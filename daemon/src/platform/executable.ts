import type { ChildProcess, SpawnOptions } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { killProcessTree } from './process-tree.js';

/**
 * Spawning a CLI is not the same on every platform.
 *
 * On Windows the npm-installed agent CLIs are `claude.cmd` / `codex.cmd` /
 * `dsh.cmd`, and `node:child_process` only appends `.exe` when resolving a bare
 * command. `cross-spawn` resolves `PATH` + `PATHEXT` and runs batch shims through
 * `cmd.exe` with argument escaping, which is the part that is unsafe to hand-roll
 * (we pass JSON such as `--mcp-config` and `--settings`).
 *
 * Everything the daemon spawns goes through here so `windowsHide` is never
 * forgotten — a console window flashing for every agent run is a Windows-only
 * regression that is easy to miss from Linux.
 */

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  /** Spawn/timeout/limit failure; null when the process ran to completion. */
  error: string | null;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

export function spawnExecutable(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return crossSpawn(command, [...args], { windowsHide: true, ...options });
}

/**
 * Run a short-lived probe and collect its output. This is the replacement for
 * `execFile` in the detectors: same result shape, but it can execute the npm
 * shims on Windows.
 */
export function runExecutable(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (code: number | null, error: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: error === null && code === 0, stdout, stderr, code, error });
    };

    let child: ChildProcess;
    try {
      child = spawnExecutable(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish(null, err instanceof Error ? err.message : String(err));
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    const append = (target: 'stdout' | 'stderr', chunk: string): void => {
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > maxBuffer) {
        killProcessTree(child);
        finish(null, `output exceeded ${maxBuffer} bytes`);
      }
    };

    child.stdout?.on('data', (chunk: string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => append('stderr', chunk));
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code, null));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killProcessTree(child);
        finish(null, `timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      timer.unref();
    }
  });
}
