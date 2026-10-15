import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.js';
import { log } from './log.js';
import { VERSION } from './version.js';

/**
 * Where this daemon says where it is. Written once the server is accepting
 * connections and removed on the way out.
 *
 * It deliberately holds **no secret** — the token stays in its own `0600` file
 * — so this one is world-readable, and readers are meant to treat it as a
 * coordination hint rather than an authority: a stale file, a reused pid or a
 * copied `serverId` are all outside what it can guarantee. Authenticate with
 * the token, not with this.
 */
export const RUNTIME_INFO_FILENAME = 'daemon_runtime.json';

/**
 * How often the file's mtime is refreshed. There is no heartbeat field: the
 * mtime *is* the heartbeat, which is why the file is written once and only
 * touched afterwards.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Age past which a reader must treat the file as stale (crash or hard kill). */
export const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3;

export interface RuntimeInfo {
  pid: number;
  startedAt: number;
  /** Stable identity of this daemon (persisted in the DB), so a client that
   *  reaches the same machine by a different address can tell it is the same. */
  serverId: string;
  hostname: string;
  /** Connectable `host:port`; a wildcard bind is translated to loopback. */
  listen: string;
  /**
   * The bind host as given: `0.0.0.0` / `::` means every interface, `127.0.0.1`
   * means this machine only. `listen` cannot say which — it is the dial-able form
   * of this value — and "can the phone reach it?" is exactly that question.
   */
  host: string;
  tls: boolean;
  version: string;
  dataDir: string;
  tokenSource: Config['tokenSource'];
}

export function runtimeInfoPath(dataDir: string): string {
  return path.join(dataDir, RUNTIME_INFO_FILENAME);
}

/**
 * The address a client on this machine should dial. `0.0.0.0` / `::` are bind
 * addresses, not connectable ones, so they collapse to loopback.
 */
export function connectableAddress(host: string, port: number): string {
  const dial = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const bracketed = dial.includes(':') && !dial.startsWith('[') ? `[${dial}]` : dial;
  return `${bracketed}:${port}`;
}

/** Write the file. Returns null (and warns) if the data dir is not writable. */
export function writeRuntimeInfo(config: Config, serverId: string): RuntimeInfo | null {
  const info: RuntimeInfo = {
    pid: process.pid,
    startedAt: Date.now(),
    serverId,
    hostname: os.hostname(),
    listen: connectableAddress(config.host, config.port),
    host: config.host,
    tls: config.tls !== null,
    version: VERSION,
    dataDir: config.dataDir,
    tokenSource: config.tokenSource,
  };
  try {
    fs.writeFileSync(runtimeInfoPath(config.dataDir), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o644 });
    return info;
  } catch (err) {
    // A read-only data dir must not keep the daemon from starting; discovery
    // on the client side degrades to probing candidate addresses instead.
    log.warn(`could not write ${RUNTIME_INFO_FILENAME}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Refresh the mtime so readers can tell the daemon is still alive. Failures are
 * swallowed: if the file is gone there is nothing to keep fresh, and retrying
 * every interval would only spam the log.
 */
export function touchRuntimeInfo(dataDir: string): void {
  const now = new Date();
  try {
    fs.utimesSync(runtimeInfoPath(dataDir), now, now);
  } catch {
    /* removed or read-only */
  }
}

/** Start refreshing the mtime. Returns a stop function. */
export function startHeartbeat(dataDir: string, intervalMs: number = HEARTBEAT_INTERVAL_MS): () => void {
  const timer = setInterval(() => touchRuntimeInfo(dataDir), intervalMs);
  // Never let the heartbeat be the reason the process stays alive.
  timer.unref();
  return () => clearInterval(timer);
}

export function clearRuntimeInfo(dataDir: string): void {
  try {
    fs.unlinkSync(runtimeInfoPath(dataDir));
  } catch {
    /* already gone */
  }
}
