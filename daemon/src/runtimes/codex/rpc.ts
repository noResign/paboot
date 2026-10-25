import { spawnStdioRpc, type StdioRpcConnection } from '../stdio-rpc.js';

/**
 * Transport for `codex app-server`: newline-delimited JSON-RPC over stdio.
 * The generic peer plumbing lives in `../stdio-rpc.ts`; this file keeps only
 * the Codex-specific launch command and handshake.
 */

export type CodexAppServerConnection = StdioRpcConnection;
export { StdioRpcError as CodexRpcError } from '../stdio-rpc.js';

export interface CodexAppServerOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Default per-request timeout. Long RPCs (history reads) should pass their own. */
  requestTimeoutMs?: number;
}

/** Spawn `codex app-server` and wrap it in a connection. Does not handshake. */
export function spawnCodexAppServer(options: CodexAppServerOptions = {}): CodexAppServerConnection {
  return spawnStdioRpc({
    command: options.command ?? 'codex',
    args: options.args ?? ['app-server'],
    cwd: options.cwd,
    env: options.env,
    requestTimeoutMs: options.requestTimeoutMs,
    label: 'codex app-server',
  });
}

export interface CodexInitializeResult {
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
}

/**
 * The mandatory handshake: `initialize` then the `initialized` notification.
 * `experimentalApi: true` is what opts into the v2 surface (deltas, exec
 * streams); without it those notifications never arrive.
 */
export async function initializeCodexAppServer(
  connection: CodexAppServerConnection,
  clientInfo: { name: string; version: string },
): Promise<CodexInitializeResult> {
  const result = await connection.request('initialize', {
    clientInfo,
    capabilities: { experimentalApi: true },
  });
  connection.notify('initialized', {});
  return (result ?? {}) as CodexInitializeResult;
}
