import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { log } from '../log.js';

/**
 * Generic newline-delimited JSON-RPC transport over a child process's stdio.
 *
 * Codex (`codex app-server`) and DeepSeek Harness (`dsh acp`) are both peers:
 * they accept requests, emit notifications, and send requests of their own that
 * must be answered (tool approvals). Nothing here knows a method name — the
 * runtime-specific layers (`codex/*`, `deepseek/*`) own that vocabulary.
 */

const STDERR_BUFFER_LIMIT = 8192;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

type JsonRpcId = number | string;

interface JsonRpcResponseMessage {
  id: JsonRpcId;
  result?: unknown;
  error?: { code?: JsonRpcId; message?: string; data?: unknown };
}

interface JsonRpcServerRequestMessage {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotificationMessage {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** `null` when the caller disabled the timeout (`timeoutMs <= 0`). */
  timer: ReturnType<typeof setTimeout> | null;
}

export class StdioRpcError extends Error {
  constructor(
    message: string,
    readonly code: JsonRpcId | undefined = undefined,
    readonly data: unknown = undefined,
  ) {
    super(message);
    this.name = 'StdioRpcError';
  }
}

/** A notification from the server. Fire-and-forget; no reply expected. */
export type NotificationHandler = (method: string, params: unknown) => void;

/** One complete line the child wrote to stderr. */
export type StderrHandler = (line: string) => void;

/**
 * A request from the server that we MUST answer — approvals live here.
 * Return a value to reply with `result`; throw to reply with `error`. An async
 * handler is awaited, which is what lets an approval block on a remote operator.
 * If no handler is registered we reply with an error rather than leaving the
 * server waiting forever.
 */
export type ServerRequestHandler = (
  method: string,
  params: unknown,
  requestId?: string | number,
) => unknown | Promise<unknown>;

export interface StdioRpcOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Name used in error messages and stderr log tags. */
  label?: string;
  /** Default per-request timeout. Long RPCs should pass their own. */
  requestTimeoutMs?: number;
}

export class StdioRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private buffer = '';
  private stderrTail = '';
  private stderrBuffer = '';
  private closed = false;
  private notificationHandler: NotificationHandler | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;
  private exitHandler: ((reason: Error) => void) | null = null;
  private stderrHandler: StderrHandler | null = null;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly defaultTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
    private readonly label = 'rpc',
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.feed(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_BUFFER_LIMIT);
      log.warn(`[${this.label}] ${chunk.trimEnd()}`);
      this.feedStderr(chunk);
    });

    child.on('exit', (code, signal) => {
      // The last line often has no trailing newline; hand it over before the
      // listener above is told the process is gone.
      this.flushStderr();
      const reason = new StdioRpcError(
        `${this.label} exited (code=${code ?? 'null'} signal=${signal ?? 'null'})${
          this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ''
        }`,
      );
      this.failPending(reason);
      this.exitHandler?.(reason);
    });

    child.on('error', (err) => {
      const reason = new StdioRpcError(`${this.label} process error: ${err.message}`);
      this.failPending(reason);
      this.exitHandler?.(reason);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /**
   * Receive the child's stderr, one complete line at a time. Runtimes report
   * their own operational failures (network, auth, quota, sandbox) here and
   * nowhere else on the wire, so a caller that wants to explain a silent run
   * has to read this. Lines are buffered, so a chunk boundary never splits one.
   */
  onStderr(handler: StderrHandler): void {
    this.stderrHandler = handler;
  }

  /**
   * Fires once when the child exits. A run waits on a turn's terminal
   * notification, so without this a crashed process would leave that wait
   * hanging forever.
   */
  onExit(handler: (reason: Error) => void): void {
    this.exitHandler = handler;
  }

  /**
   * Send a request and await its response. Rejects on timeout, exit, or
   * `error`. A non-positive timeout disables the timer, which long-running
   * peers (an agent turn) need — their own idle watchdog is the liveness bound.
   */
  request(method: string, params: unknown = {}, timeoutMs = this.defaultTimeoutMs): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new StdioRpcError(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new StdioRpcError(String(err)));
      }
    });
  }

  /** Send a notification. No response, no id. */
  notify(method: string, params: unknown = {}): void {
    this.write({ method, params });
  }

  /**
   * Shut the child down: close stdin, then SIGTERM, then SIGKILL. Pending
   * requests are rejected rather than left hanging on a dead process.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new StdioRpcError(`${this.label} connection closed`));

    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (await waitForExit(this.child, GRACEFUL_SHUTDOWN_TIMEOUT_MS)) return;

    this.child.kill('SIGTERM');
    if (await waitForExit(this.child, FORCE_SHUTDOWN_TIMEOUT_MS)) return;

    this.child.kill('SIGKILL');
  }

  // ---- internals ----

  private write(message: unknown): void {
    if (this.closed) throw new StdioRpcError('connection is closed');
    if (this.child.stdin.destroyed) throw new StdioRpcError(`${this.label} stdin is closed`);
    // ACP validates JSON-RPC envelopes; Codex tolerates the version field too,
    // so every outgoing frame carries it.
    const frame = { jsonrpc: '2.0', ...(message as Record<string, unknown>) };
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /** Accumulate stdout and dispatch every complete line. */
  private feed(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  /** Split stderr into whole lines. A line without a newline yet stays buffered. */
  private feedStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    let nl: number;
    while ((nl = this.stderrBuffer.indexOf('\n')) !== -1) {
      const line = this.stderrBuffer.slice(0, nl).trim();
      this.stderrBuffer = this.stderrBuffer.slice(nl + 1);
      if (line) this.stderrHandler?.(line);
    }
    // A child that never emits a newline must not grow this without bound.
    if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) this.stderrBuffer = '';
  }

  private flushStderr(): void {
    const line = this.stderrBuffer.trim();
    this.stderrBuffer = '';
    if (line) this.stderrHandler?.(line);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      log.warn(`[${this.label}] unparseable line from peer: ${line.slice(0, 200)}`);
      return;
    }
    if (!message || typeof message !== 'object') return;
    const record = message as Record<string, unknown>;

    if (typeof record['method'] === 'string' && 'id' in record) {
      void this.handleServerRequest(record as unknown as JsonRpcServerRequestMessage);
      return;
    }
    if ('id' in record) {
      this.handleResponse(record as unknown as JsonRpcResponseMessage);
      return;
    }
    if (typeof record['method'] === 'string') {
      const notification = record as unknown as JsonRpcNotificationMessage;
      this.notificationHandler?.(notification.method, notification.params);
      return;
    }
  }

  private handleResponse(message: JsonRpcResponseMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) return; // a response we already timed out on
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) {
      const base = message.error.message ?? `${this.label} error`;
      // ACP puts the actionable cause (e.g. a failed MCP mount) in
      // `error.data.details`; the top-level message is only "Internal error".
      const details = asErrorDetail(message.error.data);
      pending.reject(
        new StdioRpcError(details ? `${base}: ${details}` : base, message.error.code, message.error.data),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(message: JsonRpcServerRequestMessage): Promise<void> {
    if (!this.serverRequestHandler) {
      this.replyError(message.id, -32601, `no handler for server request: ${message.method}`);
      return;
    }
    try {
      const result = await this.serverRequestHandler(message.method, message.params, message.id);
      this.replyResult(message.id, result ?? {});
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.replyError(message.id, -32000, text);
    }
  }

  private replyResult(id: JsonRpcId, result: unknown): void {
    try {
      this.write({ id, result });
    } catch {
      // connection already gone; nothing to answer
    }
  }

  private replyError(id: JsonRpcId, code: number, message: string): void {
    try {
      this.write({ id, error: { code, message } });
    } catch {
      // connection already gone; nothing to answer
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** ACP's `error.data.details`; other peers may omit `data` or use another shape. */
function asErrorDetail(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const details = (data as Record<string, unknown>)['details'];
  return typeof details === 'string' && details.trim().length > 0 ? details : null;
}

function assertPiped(child: ChildProcess): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new StdioRpcError('child spawned without stdio pipes');
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

/** Spawn a child and wrap it in a connection. Does not handshake. */
export function spawnStdioRpc(options: StdioRpcOptions): StdioRpcConnection {
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertPiped(child);
  return new StdioRpcConnection(child, options.requestTimeoutMs, options.label);
}
