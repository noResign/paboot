import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { killProcessGroup, killProcessTree } from '../src/platform/process-tree';

function fakeTaskkill() {
  const killer = new EventEmitter() as EventEmitter & { unref: () => void };
  killer.unref = vi.fn();
  return killer;
}

describe('killProcessTree', () => {
  it('uses taskkill /T /F on Windows so grandchildren die too', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const child = { pid: 42, kill: vi.fn(() => true) };

    killProcessTree(child, {
      platform: 'win32',
      spawnImpl: ((command: string, args: string[]) => {
        calls.push({ command, args });
        return fakeTaskkill() as unknown as ChildProcess;
      }) as never,
      warn: () => {},
    });

    expect(calls).toEqual([{ command: 'taskkill', args: ['/PID', '42', '/T', '/F'] }]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('signals the child directly off Windows', () => {
    const child = { pid: 42, kill: vi.fn(() => true) };
    killProcessTree(child, { platform: 'linux', signal: 'SIGTERM' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does nothing when the child never got a pid', () => {
    const child = { pid: undefined, kill: vi.fn(() => true) };
    killProcessTree(child, { platform: 'linux' });
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('killProcessGroup', () => {
  it('signals the whole process group on POSIX', () => {
    const signalled: Array<[number, string | number | undefined]> = [];
    killProcessGroup(42, {
      platform: 'linux',
      signal: 'SIGKILL',
      killImpl: (pid, signal) => {
        signalled.push([pid, signal]);
        return true;
      },
    });
    expect(signalled).toEqual([[-42, 'SIGKILL']]);
  });

  it('falls back to the single pid when the group is gone', () => {
    const signalled: number[] = [];
    killProcessGroup(42, {
      platform: 'linux',
      killImpl: (pid) => {
        signalled.push(pid);
        if (pid < 0) throw new Error('ESRCH');
        return true;
      },
    });
    expect(signalled).toEqual([-42, 42]);
  });

  it('uses taskkill on Windows', () => {
    const calls: string[][] = [];
    killProcessGroup(42, {
      platform: 'win32',
      spawnImpl: ((_command: string, args: string[]) => {
        calls.push(args);
        return fakeTaskkill() as unknown as ChildProcess;
      }) as never,
      warn: () => {},
    });
    expect(calls).toEqual([['/PID', '42', '/T', '/F']]);
  });
});
