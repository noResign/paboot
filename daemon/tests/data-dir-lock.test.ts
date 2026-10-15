import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireDataDirLock, lockPath } from '../src/data-dir-lock';

/** A pid that is certainly not running: a child we spawned and then reaped. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  expect(pid).toBeGreaterThan(0);
  return pid as number;
}

const writeLock = (dir: string, body: unknown): void =>
  fs.writeFileSync(lockPath(dir), typeof body === 'string' ? body : `${JSON.stringify(body)}\n`);

describe('acquireDataDirLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-lock-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('grants the lock and records the holder pid', () => {
    const lock = acquireDataDirLock(dir, 111);
    expect(lock.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'))).toMatchObject({ pid: 111 });
  });

  it('refuses while a live holder owns the dir, and reports its pid', () => {
    // `process.pid` is, by definition, alive.
    writeLock(dir, { pid: process.pid, startedAt: Date.now() });

    expect(acquireDataDirLock(dir, 999_999)).toEqual({ ok: false, pid: process.pid });
  });

  it('does not steal or clobber a live holder', () => {
    writeLock(dir, { pid: process.pid, startedAt: 123 });
    acquireDataDirLock(dir, 999_999);
    expect(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('steals a stale lock left by a dead process', () => {
    writeLock(dir, { pid: deadPid(), startedAt: Date.now() });

    const lock = acquireDataDirLock(dir, 222);
    expect(lock.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'))).toMatchObject({ pid: 222 });
  });

  it('treats an unreadable lock file as stale', () => {
    writeLock(dir, 'not json');

    expect(acquireDataDirLock(dir, 333).ok).toBe(true);
  });

  it('releases the lock, and a fresh acquire then succeeds', () => {
    const lock = acquireDataDirLock(dir, 111);
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;

    lock.release();
    expect(fs.existsSync(lockPath(dir))).toBe(false);
    expect(acquireDataDirLock(dir, 444).ok).toBe(true);
  });

  it('never unlinks a lock that someone else has taken over', () => {
    const lock = acquireDataDirLock(dir, 111);
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;

    // Simulate another daemon stealing it after our pid died.
    writeLock(dir, { pid: 555, startedAt: Date.now() });
    lock.release();

    expect(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'))).toMatchObject({ pid: 555 });
  });
});
