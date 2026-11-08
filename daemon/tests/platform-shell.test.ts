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

  it('finds Git in Program Files when the override is not set', () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const shell = resolveShell({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: (candidate) => candidate === bash,
    });
    expect(shell.command).toBe(bash);
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
    // Only known Git locations are probed; `where bash` would find WSL's
    // System32\bash.exe, which cannot run a Windows workspace command.
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
