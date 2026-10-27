import fs from 'node:fs';
import path from 'node:path';

/**
 * One daemon per data dir, enforced.
 *
 * The daemon assumes it is the only writer of `~/.paboot`: it opens the SQLite
 * file directly, publishes `daemon_runtime.json` (and *unlinks* it on the way
 * out), and at boot repairs "orphaned" runs by marking every DB row still
 * `running` as `interrupted`. That last one is actively destructive when a
 * second daemon starts while the first is alive — it would rewrite the first
 * daemon's in-flight runs as interrupted, and inject terminal frames into
 * streams whose processes are still running.
 *
 * A lock file taken with `O_EXCL` makes "am I alone?" an atomic question, asked
 * *before* anything touches the DB. A holder that is still alive means refuse;
 * a lock whose pid is gone is stale (the daemon crashed) and is safe to steal —
 * which is exactly the case `interruptOrphanedRuns` was written for.
 */
export const DATA_DIR_LOCK_FILENAME = 'paboot.lock';

export interface DataDirLock {
  pid: number;
  startedAt: number;
}

export type AcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; /** The live process holding it, when it could be read. */ pid: number | null };

export function lockPath(dataDir: string): string {
  return path.join(dataDir, DATA_DIR_LOCK_FILENAME);
}

/**
 * `kill(pid, 0)` probes liveness without signalling. `EPERM` means the process
 * exists but belongs to someone else — alive, and not ours to touch.
 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file: string): DataDirLock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DataDirLock>;
    return typeof parsed.pid === 'number' ? { pid: parsed.pid, startedAt: parsed.startedAt ?? 0 } : null;
  } catch {
    return null;
  }
}

/**
 * Take the data dir, or report the live process that already holds it. Steals a
 * stale lock (dead pid, unreadable/garbage file) — but only once, so two
 * processes racing to steal cannot both win.
 */
export function acquireDataDirLock(dataDir: string, pid: number = process.pid): AcquireResult {
  const file = lockPath(dataDir);
  const payload = `${JSON.stringify({ pid, startedAt: Date.now() })}\n`;

  for (let attempt = 0; ; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o644);
      try {
        fs.writeSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, release: () => releaseLock(file, pid) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const held = readLock(file);
    if (held && held.pid !== pid && isAlive(held.pid)) return { ok: false, pid: held.pid };
    // Stale, or our own leftover. Clear it and retry exactly once: if that retry
    // also loses, someone else is there now and we report rather than spin.
    if (attempt >= 1) return { ok: false, pid: held?.pid ?? null };
    try {
      fs.unlinkSync(file);
    } catch {
      // Raced with another process — the retry below sees whoever won.
    }
  }
}

/** Remove the lock, but only while it is still ours. */
function releaseLock(file: string, pid: number): void {
  const held = readLock(file);
  if (held && held.pid !== pid) return;
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone — nothing to release.
  }
}
