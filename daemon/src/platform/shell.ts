import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The shell used for command tasks (`runtimes/command.ts`).
 *
 * POSIX has `/bin/sh`. Windows has no such path — and `node:child_process` does
 * not translate it through MSYS — so a Windows host needs an explicit choice:
 *
 * 1. Git Bash, which is already a requirement for Claude Code on Windows and
 *    gives us the POSIX commands users put in scheduled tasks;
 * 2. `cmd.exe` as a last resort, where POSIX syntax simply will not work.
 *
 * Git Bash is looked up by known paths rather than `where bash`: with WSL
 * installed, PATH may contain `C:\Windows\System32\bash.exe`, which is a Linux
 * shell and would see Windows workspace paths as foreign.
 */

export type ShellKind = 'posix' | 'git-bash' | 'cmd';

export interface ShellSpec {
  kind: ShellKind;
  command: string;
  /** Build the argv for one script. `cmd` consumes the rest of the line. */
  args(script: string): string[];
  /** `cmd /c <script>` must reach cmd verbatim; Node's arg quoting breaks it. */
  windowsVerbatimArguments: boolean;
}

export interface ResolveShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. */
  exists?: (candidate: string) => boolean;
}

function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const win = path.win32;
  const candidates: Array<string | undefined> = [env['CLAUDE_CODE_GIT_BASH_PATH']];
  const localPrograms =
    env['LOCALAPPDATA']?.trim() ? win.join(env['LOCALAPPDATA'].trim(), 'Programs') : undefined;
  for (const root of [env['ProgramFiles'], env['ProgramFiles(x86)'], localPrograms]) {
    if (root?.trim()) candidates.push(win.join(root.trim(), 'Git', 'bin', 'bash.exe'));
  }
  return candidates.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '');
}

export function resolveShell(options: ResolveShellOptions = {}): ShellSpec {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform !== 'win32') {
    return {
      kind: 'posix',
      command: '/bin/sh',
      args: (script) => ['-c', script],
      windowsVerbatimArguments: false,
    };
  }

  const exists = options.exists ?? existsSync;
  for (const candidate of gitBashCandidates(env)) {
    if (exists(candidate)) {
      return {
        kind: 'git-bash',
        command: candidate,
        args: (script) => ['-c', script],
        windowsVerbatimArguments: false,
      };
    }
  }

  return {
    kind: 'cmd',
    command: env['ComSpec']?.trim() || 'cmd.exe',
    args: (script) => ['/d', '/s', '/c', script],
    windowsVerbatimArguments: true,
  };
}

/**
 * Quote one command-line token for the permission hook.
 *
 * The hook command is executed by Claude Code's own shell runner, which we do
 * not control, so the quoting has to survive both `cmd.exe` and POSIX shells.
 * Double quotes work in both; a Windows path cannot contain `"`, and on POSIX
 * `\"` is the escaped form.
 */
export function quoteCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
