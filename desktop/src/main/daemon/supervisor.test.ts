import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDaemonArgs, parseRuntimeFile, resolveDaemonCommand, DaemonSupervisor } from './supervisor';
import type { ManagedDaemonRecord } from '../settings';

/**
 * A private data dir per test. `hintForExit` reads the tail of `<dataDir>/daemon.log`,
 * so a shared dir would let one test's narration decide another's hint.
 */
const tempDirs: string[] = [];
function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-sup-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildDaemonArgs', () => {
  it('spells out --host and defaults to every interface', () => {
    expect(buildDaemonArgs({ workspace: '/w', port: 4780 })).toEqual([
      '--workspace',
      '/w',
      '--port',
      '4780',
      '--host',
      '0.0.0.0',
    ]);
  });

  it('never passes --data-dir: the daemon owns a fixed ~/.paboot', () => {
    expect(buildDaemonArgs({ workspace: '/w', port: 4780 })).not.toContain('--data-dir');
  });

  it('honours an explicit loopback host', () => {
    expect(buildDaemonArgs({ workspace: '/w', port: 1, host: '127.0.0.1' })).toContain('127.0.0.1');
  });
});

describe('resolveDaemonCommand', () => {
  it('prefers the user command and does not set ELECTRON_RUN_AS_NODE for it', () => {
    const cmd = resolveDaemonCommand({
      userCommand: { command: 'pnpm', args: ['exec', 'paboot'] },
      bundledEntry: '/app/dist/index.js',
      execPath: '/electron',
      isPackaged: true,
    });
    expect(cmd).toEqual({ command: 'pnpm', args: ['exec', 'paboot'], env: {} });
  });

  it('runs the bundled daemon with Electron-as-Node', () => {
    const cmd = resolveDaemonCommand({
      userCommand: null,
      bundledEntry: '/app/dist/index.js',
      execPath: '/electron',
      isPackaged: true,
    });
    expect(cmd?.command).toBe('/electron');
    expect(cmd?.args).toEqual(['/app/dist/index.js']);
    expect(cmd?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('returns null when there is nothing to run, instead of failing at spawn', () => {
    expect(
      resolveDaemonCommand({ userCommand: null, bundledEntry: null, execPath: '/e', isPackaged: false }),
    ).toBeNull();
  });
});

describe('parseRuntimeFile', () => {
  const raw = JSON.stringify({ pid: 42, listen: '127.0.0.1:4780', version: '1.8.0' });

  it('accepts a fresh file belonging to our child', () => {
    expect(parseRuntimeFile(raw, 42, 1_000, 900)).toMatchObject({ pid: 42, listen: '127.0.0.1:4780' });
  });

  it('rejects a stale file left behind by kill -9', () => {
    expect(parseRuntimeFile(raw, 42, 100_000, 900)).toBeNull();
  });

  it('rejects a file written by a different process', () => {
    expect(parseRuntimeFile(raw, 7, 1_000, 900)).toBeNull();
  });

  it('rejects garbage instead of throwing', () => {
    expect(parseRuntimeFile('not json', 42, 1_000, 900)).toBeNull();
    expect(parseRuntimeFile('{"pid":"x"}', 42, 1_000, 900)).toBeNull();
  });
});

/** A clock that advances on every read, so the readiness deadline is reachable. */
function movingClock(): () => number {
  let clock = 0;
  // Small steps: the loop checks its conditions between sleeps, so a clock that
  // outruns the 15s budget would make it exit before it could observe the event.
  return () => (clock += 1);
}

/** A fake ChildProcess that never emits — enough to exercise the failure paths. */
function fakeChild(pid = 1234): EventEmitter & { pid: number; exitCode: number | null; kill: () => boolean; unref: () => void } {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    kill: () => boolean;
    unref: () => void;
  };
  child.pid = pid;
  child.exitCode = null;
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  return child;
}

describe('DaemonSupervisor.start', () => {
  const command = { command: '/electron', args: ['/entry.js'], env: {} };
  const args = { workspace: '/w', port: 4780 };

  it('reports a spawn error as a result, and never throws', async () => {
    const sup = new DaemonSupervisor('/tmp/paboot-test', {
      spawnImpl: (() => {
        const child = fakeChild();
        // Node throws on an unheard 'error' event; the supervisor must have a
        // listener attached before this fires.
        setImmediate(() => child.emit('error', new Error('spawn EACCES')));
        return child;
      }) as never,
      env: async () => ({}),
      sleep: () => new Promise((r) => setImmediate(r)),
      now: movingClock(),
    });
    const result = await sup.start(command, args);
    expect(result).toMatchObject({ ok: false, code: 'spawn_failed' });
  });

  it('reports an early exit with a port hint when the log says EADDRINUSE', async () => {
    const sup = new DaemonSupervisor(tempDataDir(), {
      spawnImpl: (() => {
        const child = fakeChild();
        setImmediate(() => {
          child.exitCode = 1;
          child.emit('exit', 1, null);
        });
        return child;
      }) as never,
      env: async () => ({}),
      sleep: () => new Promise((r) => setImmediate(r)),
      now: movingClock(),
    });
    sup.log('Error: listen EADDRINUSE: address already in use 127.0.0.1:4780');
    const result = await sup.start(command, args);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('exited_early');
      expect(result.message).toContain('端口被占用');
    }
  });

  it('points at the data-dir lock when another daemon already holds ~/.paboot', async () => {
    const sup = new DaemonSupervisor(tempDataDir(), {
      spawnImpl: (() => {
        const child = fakeChild();
        setImmediate(() => {
          child.exitCode = 1;
          child.emit('exit', 1, null);
        });
        return child;
      }) as never,
      env: async () => ({}),
      sleep: () => new Promise((r) => setImmediate(r)),
      now: movingClock(),
    });
    sup.log('[2026-01-01T00:00:00.000Z] ERROR /home/me/.paboot 上已经有 daemon 在运行（pid 42）——一个数据目录同时只能跑一个 daemon。');
    const result = await sup.start(command, args);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('exited_early');
      expect(result.message).toContain('已经有一个 daemon 在运行');
    }
  });

  it('survives a synchronous throw from spawn', async () => {
    const sup = new DaemonSupervisor('/tmp/paboot-test', {
      spawnImpl: (() => {
        throw new Error('bad cwd');
      }) as never,
      env: async () => ({}),
    });
    await expect(sup.start(command, args)).resolves.toMatchObject({ ok: false, code: 'spawn_failed' });
  });

  it('strips PABOOT_TOKEN so the daemon reads <dataDir>/token, not an inherited var', async () => {
    const spawnImpl = vi.fn(() => fakeChild());
    let clock = 0;
    const sup = new DaemonSupervisor('/tmp/paboot-test', {
      spawnImpl: spawnImpl as never,
      env: async () => ({ PABOOT_TOKEN: 'from-shell', PATH: '/bin' }),
      sleep: async () => {},
      now: () => (clock += 10_000),
    });
    await sup.start(command, args);
    const [, , options] = spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(options.env['PABOOT_TOKEN']).toBeUndefined();
    // Everything else is still passed through.
    expect(options.env['PATH']).toBe('/bin');
  });

  it('restarts with the same command and args it was started with', async () => {
    const spawned: string[][] = [];
    let clock = 0;
    const sup = new DaemonSupervisor('/tmp/paboot-test', {
      spawnImpl: ((_cmd: string, argv: string[]) => {
        spawned.push(argv);
        const child = fakeChild();
        // A real child dies on SIGKILL; without that, stop() can never finish and
        // the start-after-stop is refused as `already_running`.
        child.kill = () => {
          child.exitCode = 0;
          child.emit('exit', 0, null);
          return true;
        };
        return child;
      }) as never,
      env: async () => ({}),
      sleep: async () => {},
      now: () => (clock += 10_000),
    });
    await sup.start(command, args); // times out waiting for readiness, but records the launch
    await sup.restart();
    expect(spawned).toHaveLength(2);
    expect(spawned[1]).toEqual(spawned[0]);
  });

  it('falls back to the app environment when the login shell capture fails', async () => {
    const spawnImpl = vi.fn(() => fakeChild());
    // The readiness loop is bounded by wall-clock, so the fake clock must move —
    // a frozen one makes it spin forever and hangs the runner.
    let clock = 0;
    const sup = new DaemonSupervisor('/tmp/paboot-test', {
      spawnImpl: spawnImpl as never,
      env: async () => {
        throw new Error('no shell');
      },
      sleep: async () => {},
      now: () => (clock += 10_000),
    });
    await sup.start(command, args); // timeout path is fine — we only check it spawned
    expect(spawnImpl).toHaveBeenCalledOnce();
    const [, , options] = spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(options.env['PATH']).toBe(process.env['PATH']);
  });
});

describe('DaemonSupervisor and the daemon holding the data dir', () => {
  const LIVE_PID = 4242;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-sup-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The runtime file a daemon writes once it is listening. */
  function writeRuntime(body: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, 'daemon_runtime.json'), JSON.stringify({ listen: '127.0.0.1:4780', ...body }));
  }

  /** A record as this app would have written it after starting a daemon. */
  function owned(pid: number, startedAt: number): ManagedDaemonRecord {
    return { running: { pid, startedAt }, launch: null };
  }

  function supervisor(opts: {
    record?: ManagedDaemonRecord | null;
    alive?: () => boolean;
    saved?: Array<ManagedDaemonRecord | null>;
  }): DaemonSupervisor {
    return new DaemonSupervisor(dir, {
      // A tiny clock keeps a freshly written runtime file "fresh" (freshness is
      // `now - mtime`), without touching the real clock.
      now: () => 1_000,
      sleep: async () => {},
      env: async () => ({}),
      isAlive: () => opts.alive?.() ?? true,
      loadRecord: () => opts.record ?? null,
      saveRecord: (r) => opts.saved?.push(r),
    });
  }

  it('recognises a daemon an earlier app run left running as ours', () => {
    writeRuntime({ pid: LIVE_PID, startedAt: 777 });
    expect(supervisor({ record: owned(LIVE_PID, 777) }).pid()).toBe(LIVE_PID);
  });

  it('does not claim a daemon whose start time is not the one we recorded', () => {
    // A reused pid with a different start time is a different process.
    writeRuntime({ pid: LIVE_PID, startedAt: 999 });
    expect(supervisor({ record: owned(LIVE_PID, 777) }).pid()).toBeNull();
  });

  it('does not claim anything when we have never started a daemon', () => {
    writeRuntime({ pid: LIVE_PID, startedAt: 777 });
    expect(supervisor({ record: null }).pid()).toBeNull();
  });

  it('still sees the pid of a daemon someone else started', () => {
    writeRuntime({ pid: LIVE_PID, startedAt: 777 });
    expect(supervisor({ record: null }).livePid()).toBe(LIVE_PID);
  });

  it('stops the daemon holding the data dir even though it is not our child', async () => {
    writeRuntime({ pid: LIVE_PID, startedAt: 777 });
    const saved: Array<ManagedDaemonRecord | null> = [];
    let alive = true;
    const sup = supervisor({ record: owned(LIVE_PID, 777), alive: () => alive, saved });
    const signalled: number[] = [];
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      signalled.push(pid);
      alive = false;
      return true;
    }) as never);
    try {
      // timeout 0: it is gone the moment we signal it, so there is nothing to wait for.
      await expect(sup.stop(0)).resolves.toBe(true);
    } finally {
      kill.mockRestore();
    }
    expect(signalled).toEqual([LIVE_PID]);
    expect(saved).toEqual([null]); // the ownership record goes with the process
  });

  it('refuses to start while any daemon holds the data dir', async () => {
    writeRuntime({ pid: LIVE_PID, startedAt: 777 });
    const res = await supervisor({ record: null }).start({ command: '/electron', args: [], env: {} }, { workspace: '/w', port: 4780 });
    expect(res).toMatchObject({ ok: false, code: 'already_running' });
  });
});

describe('DaemonSupervisor restarting a daemon an earlier run started', () => {
  const LAUNCH = { command: '/electron', args: ['/entry.js'], env: {}, workspace: '/w', port: 4780 };

  function supervisor(record: ManagedDaemonRecord | null, spawned: string[][]): DaemonSupervisor {
    return new DaemonSupervisor(tempDataDir(), {
      now: movingClock(),
      sleep: () => new Promise((r) => setImmediate(r)),
      env: async () => ({}),
      isAlive: () => false,
      loadRecord: () => record,
      saveRecord: () => {},
      spawnImpl: ((_cmd: string, argv: string[]) => {
        spawned.push(argv);
        const child = fakeChild();
        setImmediate(() => {
          child.exitCode = 1;
          child.emit('exit', 1, null);
        });
        return child;
      }) as never,
    });
  }

  it('replays the persisted launch spec, not just the one from this run', async () => {
    const spawned: string[][] = [];
    // `running: null` — the process is gone; only the launch survived.
    const sup = supervisor({ running: null, launch: LAUNCH }, spawned);

    expect(sup.hasLaunchSpec()).toBe(true);
    await sup.startLast();

    expect(spawned[0]).toEqual(['/entry.js', '--workspace', '/w', '--port', '4780', '--host', '0.0.0.0']);
  });

  it('says so instead of spawning when there is no launch spec at all', async () => {
    const spawned: string[][] = [];
    const sup = supervisor(null, spawned);

    expect(sup.hasLaunchSpec()).toBe(false);
    await expect(sup.startLast()).resolves.toMatchObject({ ok: false, code: 'never_started' });
    expect(spawned).toEqual([]);
  });
});
