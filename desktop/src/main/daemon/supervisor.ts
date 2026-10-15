import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loginShellEnv } from './login-shell-env';

/**
 * Runs a daemon **we** own. Attaching to someone else's daemon is
 * `connection/manager.ts`'s job; this file only exists for the case the plan
 * describes as「确实没在跑 → 启动一个」.
 *
 * Two rules shape everything below, both from real failure modes:
 *
 * 1. **Nothing here may take the desktop app down.** A machine's environment
 *    varies wildly — no shell, a broken rc file, a daemon that exits instantly, a
 *    port taken by something else. Every path is wrapped, every child gets its
 *    `error`/`exit` handlers attached immediately (an unheard `error` event on a
 *    ChildProcess is thrown by Node and would kill Electron), and public methods
 *    return a result object rather than throwing.
 * 2. **Everything is logged to a file.** A spawned daemon's output goes to
 *    `<dataDir>/daemon.log` and we append our own lines there too, so "it didn't
 *    start" is diagnosable after the fact instead of a silent no-op.
 */

export interface DaemonArgsInput {
  /** The agent's writable root — must come from the user, never guessed (§2). */
  workspace: string;
  port: number;
  /** Loopback unless the user explicitly opens it to the phone. */
  host?: string;
}

/**
 * `--host` is spelled out: the daemon defaults to `0.0.0.0`. The data root is
 * deliberately not passed — it is fixed at `~/.paboot` inside the daemon, so the
 * two can never disagree about where the DB (and the `serverId` in it) lives.
 */
export function buildDaemonArgs(input: DaemonArgsInput): string[] {
  return [
    '--workspace',
    input.workspace,
    '--port',
    String(input.port),
    '--host',
    input.host ?? '127.0.0.1',
  ];
}

export interface CommandInput {
  /** `userSetting.daemonCommand` — the escape hatch, e.g. `pnpm exec paboot`. */
  userCommand?: { command: string; args?: string[] } | null;
  /** This app's own `dist/` copy of the daemon, resolved relative to the app. */
  bundledEntry: string | null;
  /** `process.execPath` — Electron's own binary. */
  execPath: string;
  isPackaged: boolean;
}

export interface DaemonCommand {
  command: string;
  args: string[];
  /**
   * `ELECTRON_RUN_AS_NODE=1` is what lets us use Electron's bundled Node instead
   * of shipping a runtime (plan 已定 10). Not set for the user's own command.
   */
  env: Record<string, string>;
}

/**
 * Resolution order: the user's explicit command wins (it is the documented
 * escape hatch), then the daemon bundled with the app. Returns null when neither
 * exists, so the caller can say so instead of failing at `spawn`.
 */
export function resolveDaemonCommand(input: CommandInput): DaemonCommand | null {
  if (input.userCommand) {
    return { command: input.userCommand.command, args: input.userCommand.args ?? [], env: {} };
  }
  if (!input.bundledEntry) return null;
  return { command: input.execPath, args: [input.bundledEntry], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** The shape the daemon writes once it is *listening* (see `daemon_runtime.json`). */
export interface RuntimeFile {
  pid: number;
  listen: string;
  version?: string;
}

/**
 * A runtime file only counts when it is *this* process and it is fresh: the file
 * survives a `kill -9`, so "it exists" alone would let a stale one convince us a
 * dead daemon is up.
 */
export function parseRuntimeFile(raw: string, expectedPid: number, now: number, mtimeMs: number): RuntimeFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const file = parsed as Partial<RuntimeFile>;
  if (typeof file.pid !== 'number' || typeof file.listen !== 'string' || !file.listen) return null;
  if (file.pid !== expectedPid) return null;
  if (now - mtimeMs > 60_000) return null;
  return { pid: file.pid, listen: file.listen, version: file.version };
}

export type StartResult =
  | { ok: true; pid: number; listen: string | null }
  | { ok: false; code: string; message: string };

export interface SupervisorDeps {
  /** Overridable for tests; defaults to the real clock and fs. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  spawnImpl?: typeof spawn;
  env?: () => Promise<Record<string, string>>;
}

const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 250;

export class DaemonSupervisor {
  private child: ChildProcess | null = null;
  private logFd: number | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly spawnImpl: typeof spawn;
  private readonly env: () => Promise<Record<string, string>>;
  /** The last command/args we launched, so we can start the same daemon again. */
  private lastStart: { command: DaemonCommand; args: DaemonArgsInput } | null = null;

  constructor(private readonly dataDir: string, deps: SupervisorDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.spawnImpl = deps.spawnImpl ?? spawn;
    this.env = deps.env ?? loginShellEnv;
  }

  get logPath(): string {
    return path.join(this.dataDir, 'daemon.log');
  }

  get runtimePath(): string {
    return path.join(this.dataDir, 'daemon_runtime.json');
  }

  running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /**
   * pid of the daemon we spawned, or null when we hold no live child. Discovery
   * uses it to tell "the daemon this app owns" from "some daemon on this machine"
   * now that both share `~/.paboot` (there is no longer a path to tell them apart).
   */
  pid(): number | null {
    return this.running() ? (this.child?.pid ?? null) : null;
  }

  /** Append one line of our own narration next to the daemon's output. */
  log(line: string): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.appendFileSync(this.logPath, `[${new Date(this.now()).toISOString()}] [desktop] ${line}\n`);
    } catch {
      /* a missing log file must never break the caller */
    }
  }

  /** Last `lines` of the combined log, for the management page. */
  tail(lines = 200): string[] {
    try {
      return fs
        .readFileSync(this.logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-lines);
    } catch {
      return [];
    }
  }

  /**
   * Start a daemon and wait until it says it is listening. Never throws — every
   * failure comes back as `{ ok: false, code }` so the UI can explain it.
   */
  async start(command: DaemonCommand, args: DaemonArgsInput): Promise<StartResult> {
    if (this.running()) return { ok: false, code: 'already_running', message: '本机 daemon 已经在运行' };

    let env: Record<string, string>;
    try {
      env = { ...(await this.env()), ...command.env };
    } catch (err) {
      this.log(`login shell env failed, falling back to the app environment: ${describe(err)}`);
      env = { ...process.env, ...command.env } as Record<string, string>;
    }
    // The daemon reads `$PABOOT_TOKEN` *before* `<dataDir>/token` (daemon/src/config.ts),
    // but we authenticate with the file. An inherited variable would make those two
    // disagree and every client hit 401, so the child never sees it (§2).
    delete env.PABOOT_TOKEN;

    // The daemon's stdout *is* our log: no pipe (nothing may block on the app
    // reading it), no inherited terminal (app is detached from a terminal).
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.logFd = fs.openSync(this.logPath, 'a');
    } catch (err) {
      this.logFd = null;
      this.log(`could not open ${this.logPath}: ${describe(err)}`);
    }

    try {
      this.child = this.spawnImpl(command.command, [...command.args, ...buildDaemonArgs(args)], {
        env,
        detached: true,
        stdio: ['ignore', this.logFd ?? 'ignore', this.logFd ?? 'ignore'],
        windowsHide: true,
      });
    } catch (err) {
      // `spawn` itself can throw synchronously (bad cwd, EACCES on the binary).
      this.child = null;
      this.log(`spawn threw: ${describe(err)}`);
      return { ok: false, code: 'spawn_failed', message: `无法启动：${describe(err)}` };
    }

    // Attach both handlers *before* awaiting anything: an unheard 'error' event
    // is thrown by Node and would take the whole app down.
    let spawnError: Error | null = null;
    let exited: number | null = null;
    this.child.on('error', (err) => {
      spawnError = err;
      this.log(`child error: ${describe(err)}`);
    });
    this.child.on('exit', (code, signal) => {
      exited = code;
      this.log(`child exited: code=${code ?? 'null'} signal=${signal ?? 'none'}`);
      this.child = null;
    });
    this.child.unref();

    // Remembered so「改 token」can bring the daemon back with the exact same
    // workspace/port/host it was launched with.
    this.lastStart = { command, args };

    const pid = this.child.pid ?? -1;
    this.log(`spawned pid=${pid} ${command.command} ${command.args.join(' ')} ${buildDaemonArgs(args).join(' ')}`);

    const deadline = this.now() + READY_TIMEOUT_MS;
    while (this.now() < deadline) {
      if (spawnError) return { ok: false, code: 'spawn_failed', message: describe(spawnError) };
      if (exited !== null || !this.running()) {
        return { ok: false, code: 'exited_early', message: this.hintForExit() };
      }
      const ready = this.readRuntime(pid);
      if (ready) {
        this.log(`ready at ${ready.listen}`);
        return { ok: true, pid, listen: ready.listen };
      }
      await this.sleep(READY_POLL_MS);
    }

    this.log('timed out waiting for daemon_runtime.json');
    return { ok: false, code: 'timeout', message: `启动超时（${READY_TIMEOUT_MS / 1000}s）` };
  }

  /** SIGTERM → wait for the runtime file to disappear → SIGKILL. */
  async stop(timeoutMs = 8_000): Promise<boolean> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.cleanupFd();
      return true;
    }
    try {
      child.kill('SIGTERM');
    } catch (err) {
      this.log(`SIGTERM failed: ${describe(err)}`);
    }
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      // The daemon's own handler deletes the runtime file, so its absence means
      // it really stopped — not merely that it stopped answering.
      if (!this.running() && !fs.existsSync(this.runtimePath)) {
        this.cleanupFd();
        this.log('stopped cleanly');
        return true;
      }
      await this.sleep(READY_POLL_MS);
    }
    this.log('stop timed out, sending SIGKILL');
    try {
      child.kill('SIGKILL');
    } catch (err) {
      this.log(`SIGKILL failed: ${describe(err)}`);
    }
    this.cleanupFd();
    return false;
  }

  /** Start again with the last command/args we used — the other half of a restart. */
  async startLast(): Promise<StartResult> {
    const last = this.lastStart;
    if (!last) return { ok: false, code: 'never_started', message: '没有本应用启动过的 daemon 可以重启' };
    return this.start(last.command, last.args);
  }

  /** Stop, then start again with the same command/args. */
  async restart(): Promise<StartResult> {
    await this.stop();
    return this.startLast();
  }

  /** Read the runtime file and accept it only if it belongs to our child. */
  private readRuntime(pid: number): RuntimeFile | null {
    try {
      const stat = fs.statSync(this.runtimePath);
      return parseRuntimeFile(fs.readFileSync(this.runtimePath, 'utf8'), pid, this.now(), stat.mtimeMs);
    } catch {
      return null;
    }
  }

  /** The daemon's last words are in the log; point at the likely cause. */
  private hintForExit(): string {
    const tail = this.tail(20).join('\n');
    // The daemon refuses to start when another one holds the (fixed) data dir —
    // that is a different fix from "the port is taken".
    if (/已经有 daemon 在运行/.test(tail)) {
      return '这个数据目录上已经有一个 daemon 在运行——同一台机器同时只能跑一个，先停掉它（详见日志）';
    }
    if (/EADDRINUSE|address already in use/i.test(tail)) {
      return '端口被占用，换一个端口或先关掉占用它的程序（详见日志）';
    }
    return 'daemon 启动后立刻退出了，详见日志';
  }

  private cleanupFd(): void {
    if (this.logFd === null) return;
    try {
      fs.closeSync(this.logFd);
    } catch {
      /* already closed */
    }
    this.logFd = null;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
