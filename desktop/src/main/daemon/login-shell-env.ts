import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Capture the environment the user's **login shell** would hand a child process.
 *
 * Why this exists (`electron_desktop_plan.md` §2): an app launched from Finder or
 * a desktop icon inherits a minimal `PATH`, while the agent CLIs (`claude`,
 * `codex`) live in the *user's* shell PATH. Bundling a Node runtime does not help
 * with that at all — `runtimes/claude/detect.ts` probes `claude --version`, so a
 * daemon spawned with our own env would report "no agent installed" on a machine
 * where both are installed. This is the M4 blocker, and it is invisible until you
 * spawn something.
 *
 * The plan's recipe: run the login shell **twice** — interactive and
 * non-interactive — because the two can disagree (many users only set `PATH` in
 * `.zshrc`, which non-interactive shells skip), then merge.
 *
 * Windows has no login shell in the POSIX sense. Git Bash is the closest thing
 * (and is already required by Claude Code there), so it is used when installed;
 * otherwise `cmd.exe`'s `set` is the fallback. Git Bash prints POSIX paths, so
 * the script converts `PATH`/`HOME` back to Windows form before dumping the env —
 * a daemon spawning native `.exe` CLIs cannot use `/c/Users/...` entries.
 */

/** Values with newlines are common (`PS1`, function exports) — NUL is the safe separator. */
export function parseEnvOutput(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const eq = entry.indexOf('=');
    // A bare name or a line without `=` is not an assignment we can use.
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/** `cmd.exe /d /s /c set` prints one `NAME=VALUE` per line (CRLF). */
export function parseSetOutput(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    // `=C:=C:\...` style internal variables start with `=`, hence `eq <= 0`.
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

/**
 * The interactive shell is the authority: it is the environment the user actually
 * sees in a terminal, which is where agents were installed from. The
 * non-interactive pass only fills in what interaction did not define.
 */
export function mergeEnvs(
  nonInteractive: Record<string, string>,
  interactive: Record<string, string>,
): Record<string, string> {
  return { ...nonInteractive, ...interactive };
}

export interface CaptureOptions {
  shell?: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to actually running the shell. */
  run?: (shell: string, args: string[], timeoutMs: number) => Promise<string | null>;
  baseEnv?: NodeJS.ProcessEnv;
  /** Injected for tests. */
  platform?: NodeJS.Platform;
  /** Environment used to locate Git Bash; defaults to `baseEnv`. */
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. */
  exists?: (candidate: string) => boolean;
}

function runShell(shell: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout) => resolve(error && !stdout ? null : stdout),
    );
  });
}

function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const win = path.win32;
  const candidates: Array<string | undefined> = [env['CLAUDE_CODE_GIT_BASH_PATH']];
  const localPrograms =
    env['LOCALAPPDATA']?.trim() ? win.join(env['LOCALAPPDATA'].trim(), 'Programs') : undefined;
  for (const root of [env['ProgramFiles'], env['ProgramFiles(x86)'], localPrograms]) {
    if (root?.trim()) candidates.push(win.join(root.trim(), 'Git', 'bin', 'bash.exe'));
  }
  return candidates.filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '',
  );
}

/**
 * `where bash` is deliberately not used: with WSL installed it can resolve to
 * `C:\Windows\System32\bash.exe`, which is a Linux shell and sees Windows paths
 * as foreign.
 */
export function findGitBash(
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  for (const candidate of gitBashCandidates(env)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Git Bash prints POSIX paths; native CLIs need Windows ones. */
const GIT_BASH_ENV_SCRIPT =
  'PATH="$(cygpath -wp "$PATH")"; [ -n "$HOME" ] && HOME="$(cygpath -w "$HOME")"; /usr/bin/env -0';

/**
 * `-l` for a login shell, `-i` additionally interactive; `env -0` prints the
 * environment NUL-separated so no value can be split by a newline in it.
 *
 * Never throws: a shell that is missing, hangs or exits non-zero degrades to
 * `baseEnv`. A wrong-but-usable PATH beats refusing to start a daemon.
 */
export async function captureLoginShellEnv(options: CaptureOptions = {}): Promise<Record<string, string>> {
  const platform = options.platform ?? process.platform;
  const base = options.baseEnv ?? process.env;
  const lookupEnv = options.env ?? base;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const run = options.run ?? runShell;

  // A rejected run (missing binary, EMFILE, …) must degrade like an empty one —
  // "the shell misbehaved" is not a reason to refuse to start a daemon.
  const safe = (shell: string, args: string[]): Promise<string | null> =>
    run(shell, args, timeoutMs).catch(() => null);

  let merged: Record<string, string>;

  if (options.shell) {
    // Explicit override keeps the POSIX contract (and the existing tests).
    const [nonInteractiveRaw, interactiveRaw] = await Promise.all([
      safe(options.shell, ['-l', '-c', 'env -0']),
      safe(options.shell, ['-i', '-l', '-c', 'env -0']),
    ]);
    merged = mergeEnvs(
      parseEnvOutput(nonInteractiveRaw ?? ''),
      parseEnvOutput(interactiveRaw ?? ''),
    );
  } else if (platform === 'win32') {
    const gitBash = findGitBash(lookupEnv, options.exists ?? existsSync);
    if (gitBash) {
      const [nonInteractiveRaw, interactiveRaw] = await Promise.all([
        safe(gitBash, ['-l', '-c', GIT_BASH_ENV_SCRIPT]),
        safe(gitBash, ['-i', '-l', '-c', GIT_BASH_ENV_SCRIPT]),
      ]);
      merged = mergeEnvs(
        parseEnvOutput(nonInteractiveRaw ?? ''),
        parseEnvOutput(interactiveRaw ?? ''),
      );
    } else {
      const comspec = lookupEnv['ComSpec']?.trim() || 'cmd.exe';
      // `chcp 65001` makes `set` write UTF-8, so non-ASCII user paths survive.
      const raw = await safe(comspec, ['/d', '/s', '/c', 'chcp 65001 >nul && set']);
      merged = parseSetOutput(raw ?? '');
    }
  } else {
    const shell = lookupEnv['SHELL'] ?? '/bin/bash';
    const [nonInteractiveRaw, interactiveRaw] = await Promise.all([
      safe(shell, ['-l', '-c', 'env -0']),
      safe(shell, ['-i', '-l', '-c', 'env -0']),
    ]);
    merged = mergeEnvs(
      parseEnvOutput(nonInteractiveRaw ?? ''),
      parseEnvOutput(interactiveRaw ?? ''),
    );
  }

  // Shells can return an env that is missing even the basics (a broken rc file);
  // the caller's own environment is the floor, not the ceiling.
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) result[key] = value;
  return { ...result, ...merged };
}

let cached: Promise<Record<string, string>> | null = null;

/** Once per process: the shell's environment does not change under us. */
export function loginShellEnv(): Promise<Record<string, string>> {
  cached ??= captureLoginShellEnv().catch(() => ({ ...process.env }) as Record<string, string>);
  return cached;
}
