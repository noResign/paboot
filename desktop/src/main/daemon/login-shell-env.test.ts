import { describe, expect, it, vi } from 'vitest';
import { captureLoginShellEnv, mergeEnvs, parseEnvOutput, parseSetOutput } from './login-shell-env';

describe('parseEnvOutput', () => {
  it('splits on NUL, not newlines', () => {
    // A value containing a newline is exactly why `env -0` is used.
    expect(parseEnvOutput('PATH=/usr/bin\n/opt/bin\0HOME=/home/me\0')).toEqual({
      PATH: '/usr/bin\n/opt/bin',
      HOME: '/home/me',
    });
  });

  it('ignores the trailing separator and malformed entries', () => {
    expect(parseEnvOutput('A=1\0\0BROKEN\0=oops\0B=2\0')).toEqual({ A: '1', B: '2' });
  });

  it('keeps an empty value', () => {
    expect(parseEnvOutput('EMPTY=\0')).toEqual({ EMPTY: '' });
  });
});

describe('parseSetOutput', () => {
  it('parses cmd.exe `set` output, including CRLF', () => {
    expect(parseSetOutput('A=1\r\nPATH=C:\\bin\r\n=C:=C:\\dir\r\n')).toEqual({
      A: '1',
      PATH: 'C:\\bin',
    });
  });
});

describe('mergeEnvs', () => {
  it('lets the interactive shell win — that is the environment the user sees', () => {
    expect(
      mergeEnvs({ PATH: '/usr/bin', EDITOR: 'vi' }, { PATH: '/opt/homebrew/bin:/usr/bin' }),
    ).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin', EDITOR: 'vi' });
  });
});

describe('captureLoginShellEnv', () => {
  const run = (values: Record<string, string | null>) =>
    vi.fn(async (_shell: string, args: string[]) => {
      const key = args.includes('-i') ? 'interactive' : 'nonInteractive';
      return values[key] ?? null;
    });

  it('merges both passes and lets interactive PATH win', async () => {
    const shell = run({
      nonInteractive: 'PATH=/usr/bin\0EDITOR=vi\0',
      interactive: 'PATH=/opt/homebrew/bin\0',
    });
    const env = await captureLoginShellEnv({ shell: '/bin/zsh', run: shell, baseEnv: {} });
    expect(env['PATH']).toBe('/opt/homebrew/bin');
    expect(env['EDITOR']).toBe('vi');
  });

  it('treats the caller environment as a floor when a shell yields nothing', async () => {
    const env = await captureLoginShellEnv({
      shell: '/bin/zsh',
      run: run({ nonInteractive: null, interactive: null }),
      baseEnv: { PATH: '/fallback', HOME: '/home/me' },
    });
    expect(env).toMatchObject({ PATH: '/fallback', HOME: '/home/me' });
  });

  it('falls back to the base env when the shell throws', async () => {
    const env = await captureLoginShellEnv({
      shell: '/bin/zsh',
      run: vi.fn(async () => {
        throw new Error('spawn failed');
      }),
      baseEnv: { PATH: '/fallback' },
    });
    expect(env['PATH']).toBe('/fallback');
  });

  it('asks for a login shell, and an interactive one on the second pass', async () => {
    const shell = run({ nonInteractive: '', interactive: '' });
    await captureLoginShellEnv({ shell: '/bin/bash', run: shell, baseEnv: {} });
    const calls = shell.mock.calls.map(([, args]) => args.join(' '));
    expect(calls).toContain('-l -c env -0');
    expect(calls).toContain('-i -l -c env -0');
  });

  it('uses Git Bash on Windows when it is explicitly configured', async () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const shell = run({
      nonInteractive: 'PATH=C:\\fallback\0',
      interactive: 'PATH=C:\\user-bin\0',
    });
    const env = await captureLoginShellEnv({
      platform: 'win32',
      env: { CLAUDE_CODE_GIT_BASH_PATH: bash },
      exists: (candidate) => candidate === bash,
      run: shell,
      baseEnv: {},
    });

    expect(shell.mock.calls.every(([command]) => command === bash)).toBe(true);
    // Git Bash prints POSIX paths; native .exe CLIs need the converted form.
    expect(shell.mock.calls.every(([, args]) => String(args[args.length - 1]).includes('cygpath -wp'))).toBe(true);
    expect(env['PATH']).toBe('C:\\user-bin');
  });

  it('uses cmd.exe by default even when Git is installed', async () => {
    const comspec = 'C:\\Windows\\system32\\cmd.exe';
    const shell = vi.fn(async (_command: string, _args: string[]) => 'PATH=C:\\bin\r\n');

    await captureLoginShellEnv({
      platform: 'win32',
      env: { ComSpec: comspec, ProgramFiles: 'C:\\Program Files' },
      exists: () => true, // Git's bash.exe exists, but nobody opted into it
      run: shell,
      baseEnv: {},
    });

    expect(shell).toHaveBeenCalledTimes(1);
    expect(shell.mock.calls[0]?.[0]).toBe(comspec);
  });

  it('falls back to cmd.exe `set` when Git Bash is not configured', async () => {
    const comspec = 'C:\\Windows\\system32\\cmd.exe';
    const shell = vi.fn(async (_command: string, args: string[]) => {
      expect(args).toEqual(['/d', '/s', '/c', 'chcp 65001 >nul && set']);
      return 'A=1\r\nPATH=C:\\bin\r\n';
    });

    const env = await captureLoginShellEnv({
      platform: 'win32',
      env: { ComSpec: comspec },
      exists: () => false,
      run: shell,
      baseEnv: {},
    });

    expect(shell).toHaveBeenCalledTimes(1);
    expect(shell.mock.calls[0]?.[0]).toBe(comspec);
    expect(env).toMatchObject({ A: '1', PATH: 'C:\\bin' });
  });
});
