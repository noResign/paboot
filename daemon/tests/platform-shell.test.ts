import { describe, expect, it } from 'vitest';
import { quoteCommandArg, resolveShell } from '../src/platform/shell';

describe('resolveShell', () => {
  it('uses /bin/sh off Windows', () => {
    const shell = resolveShell({ platform: 'linux' });
    expect(shell).toMatchObject({ kind: 'posix', command: '/bin/sh', windowsVerbatimArguments: false });
    expect(shell.args('echo hi')).toEqual(['-c', 'echo hi']);
  });

  it('prefers CLAUDE_CODE_GIT_BASH_PATH on Windows', () => {
    const bash = 'D:\\Portable Git\\bin\\bash.exe';
    const shell = resolveShell({
      platform: 'win32',
      env: { CLAUDE_CODE_GIT_BASH_PATH: bash },
      exists: (candidate) => candidate === bash,
    });
    expect(shell).toMatchObject({ kind: 'git-bash', command: bash });
    expect(shell.args('echo hi')).toEqual(['-c', 'echo hi']);
  });

  it('keeps cmd.exe even when Git for Windows is installed', () => {
    // Having Git installed is not a request to run commands through it.
    const shell = resolveShell({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: () => true,
    });
    expect(shell.kind).toBe('cmd');
  });

  it('falls back to ComSpec and passes the script verbatim', () => {
    const shell = resolveShell({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      exists: () => false,
    });
    expect(shell).toMatchObject({
      kind: 'cmd',
      command: 'C:\\Windows\\system32\\cmd.exe',
      windowsVerbatimArguments: true,
    });
    expect(shell.args('echo hi')).toEqual(['/d', '/s', '/c', 'echo hi']);
  });

  it('does not mistake a WSL bash on PATH for Git Bash', () => {
    // Nothing on PATH is consulted; only the explicit env override is.
    const shell = resolveShell({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\System32' },
      exists: (candidate) => candidate === 'C:\\Windows\\System32\\bash.exe',
    });
    expect(shell.kind).toBe('cmd');
  });
});

describe('quoteCommandArg', () => {
  it('quotes a path with spaces', () => {
    expect(quoteCommandArg('C:\\Program Files\\paboot.exe')).toBe('"C:\\Program Files\\paboot.exe"');
  });

  it('escapes embedded double quotes for POSIX shells', () => {
    expect(quoteCommandArg('/home/a"b/hook.js')).toBe('"/home/a\\"b/hook.js"');
  });
});
