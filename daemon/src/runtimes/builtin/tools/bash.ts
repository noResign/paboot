import type { ChildProcess } from 'node:child_process';

import { spawnExecutable } from '../../../platform/executable.js';
import { killProcessGroup } from '../../../platform/process-tree.js';
import { resolveShell, type ShellSpec } from '../../../platform/shell.js';
import type { ToolDescriptor } from '../types.js';
import { isRecord } from './file-utils.js';
import type { SpillStore, SpillWriter } from './spill.js';
import type { ToolCallContext, ToolImplementation, ToolResult } from './types.js';
import { ToolError } from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;
const KILL_GRACE_MS = 3_000;

const BASE_ENV = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'TERM',
  'LANG',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USERPROFILE',
  'SystemRoot',
  'windir',
  'ComSpec',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]);

export interface BashToolOptions {
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  /** Extra environment variables the operator explicitly allows through. */
  envAllow?: readonly string[];
  /** Full-output sink for oversize results; omitted = truncate only. */
  spill?: SpillStore;
  /** Test seam; the product resolves the host shell. */
  shell?: ShellSpec;
  platform?: NodeJS.Platform;
}

interface BashArgs {
  command: string;
  timeoutMs: number;
}

interface Capture {
  head: string;
  tail: string;
  /** Full content until the cap is crossed and a spill writer takes over. */
  buffer: string;
  total: number;
  spill: SpillWriter | null;
}

/** Shell command runner with process-tree cancellation and output spilling. */
export function createBashTool(options: BashToolOptions = {}): ToolImplementation {
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeout = options.maxTimeoutMs ?? MAX_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const shell = options.shell ?? resolveShell();
  const platform = options.platform ?? process.platform;
  const envAllow = new Set([
    ...(options.envAllow ?? []),
    ...(process.env['PABOOT_BUILTIN_BASH_ENV_ALLOW'] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ]);

  const descriptor: ToolDescriptor = {
    name: 'Bash',
    title: 'Bash',
    description:
      'Run a shell command in the session working directory. Uses /bin/sh on POSIX and cmd.exe on Windows (Git Bash only when configured). Returns stdout, stderr and the exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        timeout: {
          type: 'integer',
          minimum: 1,
          description: `Timeout in ms (default ${defaultTimeout}, max ${maxTimeout}).`,
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    source: { kind: 'native', id: 'builtin' },
    sideEffect: 'execute',
    concurrencySafe: false,
    timeoutMs: maxTimeout + KILL_GRACE_MS + 1_000,
  };

  return {
    descriptor,
    async call(input: unknown, context: ToolCallContext): Promise<ToolResult> {
      const args = parseBashArgs(input, defaultTimeout, maxTimeout);
      if (context.signal.aborted) {
        return { content: 'command cancelled before start', isError: true, interrupted: true };
      }

      const headLimit = Math.floor(maxOutputBytes * 0.75);
      const tailLimit = maxOutputBytes - headLimit;
      const makeCapture = (): Capture => ({ head: '', tail: '', buffer: '', total: 0, spill: null });
      const stdout = makeCapture();
      const stderr = makeCapture();

      const append = (target: Capture, name: 'stdout' | 'stderr', chunk: string): void => {
        target.total += chunk.length;
        if (!target.spill && target.total > maxOutputBytes && options.spill) {
          target.spill = options.spill.open(
            context.agent.sessionId ?? context.agent.runId,
            `${context.callId}-${name}`,
          );
          target.spill.write(target.buffer);
          target.buffer = '';
        }
        if (target.spill) {
          target.spill.write(chunk);
        } else if (target.buffer.length <= maxOutputBytes * 2) {
          target.buffer += chunk;
        }
        if (target.head.length < headLimit) {
          target.head += chunk.slice(0, headLimit - target.head.length);
        }
        if (tailLimit > 0) target.tail = (target.tail + chunk).slice(-tailLimit);
      };

      const startedAt = Date.now();
      let child: ChildProcess;
      try {
        child = spawnExecutable(shell.command, shell.args(args.command), {
          cwd: context.agent.cwd,
          env: sanitizeEnv(process.env, envAllow),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: platform !== 'win32',
          windowsVerbatimArguments: shell.windowsVerbatimArguments,
        });
      } catch (error) {
        return {
          content: `failed to start shell: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => append(stdout, 'stdout', chunk));
      child.stderr?.on('data', (chunk: string) => append(stderr, 'stderr', chunk));

      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let spawnError: string | null = null;
      let killTimer: NodeJS.Timeout | null = null;

      const terminate = (signal: NodeJS.Signals): void => {
        if (!child.pid) return;
        killProcessGroup(child.pid, { platform, signal });
        if (signal === 'SIGTERM' && platform !== 'win32' && !killTimer) {
          killTimer = setTimeout(() => {
            if (!settled && child.pid) killProcessGroup(child.pid, { platform, signal: 'SIGKILL' });
          }, KILL_GRACE_MS);
          killTimer.unref?.();
        }
      };

      const onAbort = (): void => {
        cancelled = true;
        terminate('SIGTERM');
      };
      context.signal.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate('SIGTERM');
      }, args.timeoutMs);
      timeout.unref?.();

      await new Promise<void>((resolve) => {
        child.once('error', (error) => {
          spawnError = error.message;
          resolve();
        });
        child.once('close', (code, signal) => {
          exitCode = code;
          exitSignal = signal;
          resolve();
        });
      });
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      context.signal.removeEventListener('abort', onAbort);

      if (stdout.spill) await stdout.spill.end();
      if (stderr.spill) await stderr.spill.end();

      const render = (target: Capture): string => {
        if (target.spill) {
          return (
            `${target.head}\n\n[... output truncated at ${maxOutputBytes} bytes; ` +
            `full output: ${target.spill.path} ...]\n\n${target.tail}`
          );
        }
        if (target.buffer.length <= maxOutputBytes) return target.buffer;
        return (
          `${target.head}\n\n[... output truncated at ${maxOutputBytes} bytes; ` +
          `no spill configured ...]\n\n${target.tail}`
        );
      };

      const parts: string[] = [];
      const stdoutText = render(stdout);
      if (stdoutText) parts.push(stdoutText);
      const stderrText = render(stderr);
      if (stderrText) parts.push(`stderr:\n${stderrText}`);
      if (spawnError) parts.push(`error: ${spawnError}`);
      parts.push(
        exitSignal
          ? `exit code: ${exitCode ?? 'null'} (signal ${exitSignal})`
          : `exit code: ${exitCode ?? 'null'}`,
      );
      if (timedOut) parts.push(`command timed out after ${args.timeoutMs}ms`);
      if (cancelled) parts.push('command cancelled');

      return {
        content: parts.join('\n\n'),
        isError: timedOut || cancelled || spawnError !== null || exitCode !== 0,
        ...(cancelled ? { interrupted: true } : {}),
        meta: {
          exitCode,
          signal: exitSignal,
          durationMs: Date.now() - startedAt,
          timedOut,
          spilled: {
            ...(stdout.spill ? { stdout: stdout.spill.path } : {}),
            ...(stderr.spill ? { stderr: stderr.spill.path } : {}),
          },
        },
      };
    },
  };
}

function parseBashArgs(input: unknown, defaultTimeout: number, maxTimeout: number): BashArgs {
  if (!isRecord(input)) throw new ToolError('Bash input must be an object', 'bash_invalid_input');
  const command = input['command'];
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ToolError('command must be a non-empty string', 'bash_invalid_input');
  }
  const requested = input['timeout'];
  if (
    requested !== undefined &&
    (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1)
  ) {
    throw new ToolError('timeout must be a positive integer', 'bash_invalid_input');
  }
  const timeoutMs = Math.min((requested as number | undefined) ?? defaultTimeout, maxTimeout);
  return { command, timeoutMs };
}

/** Only pass a small allowlist; provider keys and PABOOT_* never reach the shell. */
function sanitizeEnv(source: NodeJS.ProcessEnv, extra: ReadonlySet<string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (BASE_ENV.has(key) || key.startsWith('LC_') || extra.has(key)) env[key] = value;
  }
  return env;
}
