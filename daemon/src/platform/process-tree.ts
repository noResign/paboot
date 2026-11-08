import { spawn, type ChildProcess } from 'node:child_process';
import { log } from './log.js';

/**
 * Cancelling a run must take the whole process tree down.
 *
 * POSIX uses a process group (`kill(-pid)`) when the caller spawned the child
 * detached; Windows has no signals and no negative pids, so it uses
 * `taskkill /T /F`, which walks the child tree. A plain `child.kill()` on
 * Windows only terminates the direct child and leaves an agent's own children
 * (Bash tools, MCP servers) running.
 */

export interface KillableProcess {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: boolean },
) => ChildProcess;

export interface TerminateOptions {
  platform?: NodeJS.Platform;
  signal?: NodeJS.Signals;
  /** Injected for tests. */
  spawnImpl?: SpawnLike;
  killImpl?: (pid: number, signal?: NodeJS.Signals | number) => unknown;
  warn?: (message: string) => void;
}

function taskkill(pid: number, options: TerminateOptions): void {
  const spawnImpl = (options.spawnImpl ?? spawn) as unknown as SpawnLike;
  const warn = options.warn ?? ((message: string) => log.warn(message));
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const killer = spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', (err) => warn(`taskkill ${pid} failed: ${err.message}`));
    killer.unref();
  } catch (err) {
    warn(`taskkill ${pid} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Terminate one child: tree-kill on Windows, a signal otherwise. */
export function killProcessTree(target: KillableProcess, options: TerminateOptions = {}): void {
  const pid = target.pid;
  if (!pid || !Number.isInteger(pid)) return;
  if ((options.platform ?? process.platform) === 'win32') {
    taskkill(pid, options);
    return;
  }
  try {
    target.kill(options.signal ?? 'SIGTERM');
  } catch {
    // Already gone.
  }
}

/**
 * Terminate a detached process group. The pid must belong to the group leader
 * (`detached: true` at spawn time), otherwise the POSIX path falls back to the
 * single process — losing grandchildren is worse than not signalling the group.
 */
export function killProcessGroup(pid: number, options: TerminateOptions = {}): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if ((options.platform ?? process.platform) === 'win32') {
    taskkill(pid, options);
    return;
  }
  const signal = options.signal ?? 'SIGTERM';
  const killImpl = options.killImpl ?? process.kill;
  try {
    killImpl(-pid, signal);
  } catch {
    try {
      killImpl(pid, signal);
    } catch {
      // Already gone.
    }
  }
}
