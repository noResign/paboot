import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { buildDaemonArgs, parseRuntimeFile, resolveDaemonCommand, DaemonSupervisor } from './supervisor';

describe('buildDaemonArgs', () => {
  it('spells out --host, because the daemon defaults to 0.0.0.0', () => {
    expect(buildDaemonArgs({ workspace: '/w', port: 4780 })).toEqual([
      '--workspace',
      '/w',
      '--port',
      '4780',
      '--host',
      '127.0.0.1',
    ]);
  });

  it('never passes --data-dir: the daemon owns a fixed ~/.paboot', () => {
    expect(buildDaemonArgs({ workspace: '/w', port: 4780 })).not.toContain('--data-dir');
  });

  it('honours an explicit host (opening it to the phone is opt-in)', () => {
    expect(buildDaemonArgs({ workspace: '/w', port: 1, host: '0.0.0.0' })).toContain('0.0.0.0');
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
    const sup = new DaemonSupervisor('/tmp/paboot-test', {
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
    const sup = new DaemonSupervisor('/tmp/paboot-test', {
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
