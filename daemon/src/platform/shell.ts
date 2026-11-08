import { existsSync } from 'node:fs';

/**
 * The shell used for command tasks (`runtimes/command.ts`).
 *
 * POSIX has `/bin/sh`. Windows has no such path, and `node:child_process` does
 * not translate it through MSYS:
 *
 * 1. **`cmd.exe` is the default** — it is what a Windows user expects from a
 *    scheduled command, and it needs no extra install;
 * 2. Git Bash is used **only when explicitly configured** through
 *    `CLAUDE_CODE_GIT_BASH_PATH` (the same variable Claude Code uses). That is
 *    the opt-in for POSIX syntax; it is never auto-detected, so a machine that
 *    merely has Git installed keeps cmd semantics.
 *
 * `where bash` is deliberately not consulted: with WSL installed it can resolve
 * to `C:\Windows\System32\bash.exe`, which is a Linux shell and would see
 * Windows workspace paths as foreign.
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

  // Explicit opt-in only: having Git installed is not a request to use it.
  const exists = options.exists ?? existsSync;
  const gitBash = env['CLAUDE_CODE_GIT_BASH_PATH']?.trim();
  if (gitBash && exists(gitBash)) {
    return {
      kind: 'git-bash',
      command: gitBash,
      args: (script) => ['-c', script],
      windowsVerbatimArguments: false,
    };
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
