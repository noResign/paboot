import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopback } from '../shared/net';
import type { AppPrefs, RecentConnection } from '../shared/ipc';

export { isLoopback };

/**
 * Persisted desktop settings, in `<userData>/settings.json`. Secrets are split
 * by trust level:
 *
 * - loopback daemons: the token is **never stored** — it is read from the
 *   daemon's own `0600` file on demand (see connection/manager.ts).
 * - remote daemons: the token goes through `safeStorage`. When the platform has
 *   no keyring (Linux without libsecret/kwallet) we deliberately do **not** fall
 *   back to plaintext — it lives in memory for this session only and the UI says
 *   so.
 */
interface StoredConnection {
  host: string;
  port: number;
  tls: boolean;
  name: string | null;
  /** base64 of safeStorage ciphertext. Absent for loopback targets. */
  tokenEnc?: string;
}

/** Last window geometry, so a restart reopens where the user left it. */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

/**
 * The daemon this app spawned, remembered across app runs. Two separate facts:
 *
 * - `running` answers "is the daemon now holding `~/.paboot` the one *we* left
 *   running?" — which nothing else can: the data dir is fixed, so every local
 *   daemon (ours, systemd's, one started by hand) shares its `serverId`. Only
 *   `pid` + `startedAt` of the process we launched is unique to ours.
 * - `launch` is how we started it, so a later app run can start it again (the
 *   command used to live only in memory, so a restart could stop a daemon and
 *   then find it had no way to bring it back).
 *
 * The identity half decides labelling and the quit default **only**. Starting and
 * stopping are open to whichever daemon owns the data dir, whoever started it.
 */
export interface ManagedDaemonRecord {
  running: { pid: number; startedAt: number } | null;
  launch: {
    command: string;
    args: string[];
    env: Record<string, string>;
    /** The daemon's own argv: `--workspace` / `--port` / `--host`. */
    workspace: string;
    port: number;
    host?: string;
  } | null;
}

interface SettingsFile {
  /** Every daemon the user has connected to; main keeps them all alive (§4). */
  connections: StoredConnection[];
  /** Which one the UI was scoped to last. */
  activeConnectionId: string | null;
  recent: RecentConnection[];
  prefs: AppPrefs;
  /** Last window geometry; null until the window has been sized once. */
  windowBounds: WindowBounds | null;
  /** See {@link ManagedDaemonRecord}. Null when we have never started one. */
  managedDaemon: ManagedDaemonRecord | null;
}

const EMPTY: SettingsFile = {
  connections: [],
  activeConnectionId: null,
  recent: [],
  prefs: { closeBehavior: 'ask', desktopNotifications: true, daemonOnQuit: 'ask', autoStartDaemon: true },
  windowBounds: null,
  managedDaemon: null,
};
const MAX_RECENT = 5;

/** Tokens kept only for this process lifetime (no keyring, or loopback), by connection id. */
const memoryTokens = new Map<string, string>();

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function read(): SettingsFile {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SettingsFile> & { connection?: StoredConnection | null };
    // `connection` (singular) is the pre-multi-host shape; fold it in rather than
    // dropping a remembered remote token on upgrade.
    const connections = Array.isArray(parsed.connections)
      ? parsed.connections
      : parsed.connection
        ? [parsed.connection]
        : [];
    return {
      connections,
      activeConnectionId: parsed.activeConnectionId ?? null,
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      prefs: { ...EMPTY.prefs, ...(parsed.prefs ?? {}) },
      windowBounds: parsed.windowBounds ?? null,
      managedDaemon: normalizeManagedDaemon(parsed.managedDaemon),
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Read back a persisted record, dropping anything that is not the shape we wrote. */
function normalizeManagedDaemon(raw: unknown): ManagedDaemonRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<ManagedDaemonRecord>;
  const running =
    value.running && typeof value.running.pid === 'number' && typeof value.running.startedAt === 'number'
      ? { pid: value.running.pid, startedAt: value.running.startedAt }
      : null;
  const l = value.launch;
  const launch =
    l && typeof l.command === 'string' && Array.isArray(l.args) && typeof l.workspace === 'string' && typeof l.port === 'number'
      ? {
          command: l.command,
          args: l.args.filter((a): a is string => typeof a === 'string'),
          env: l.env && typeof l.env === 'object' ? (l.env as Record<string, string>) : {},
          workspace: l.workspace,
          port: l.port,
          host: typeof l.host === 'string' ? l.host : undefined,
        }
      : null;
  return running || launch ? { running, launch } : null;
}

function write(next: SettingsFile): void {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

export interface StoredTarget {
  host: string;
  port: number;
  tls: boolean;
  name: string | null;
}

/** `http(s)://host:port` — the id every layer keys a connection by. */
export function connectionId(target: StoredTarget): string {
  return `http${target.tls ? 's' : ''}://${target.host}:${target.port}`;
}

/** Restore every remembered target with whatever token can be recovered for it. */
export function loadConnections(): Array<{ target: StoredTarget; token: string | null }> {
  return read().connections.map((connection) => {
    const target: StoredTarget = {
      host: connection.host,
      port: connection.port,
      tls: connection.tls,
      name: connection.name,
    };
    const id = connectionId(target);
    if (connection.tokenEnc && isLoopback(connection.host) === false) {
      try {
        return { target, token: safeStorage.decryptString(Buffer.from(connection.tokenEnc, 'base64')) };
      } catch {
        return { target, token: null };
      }
    }
    return { target, token: memoryTokens.get(id) ?? null };
  });
}

/** Upsert by id, and make it the active one. Returns the connection's id. */
export function saveConnection(target: StoredTarget, token: string | null): string {
  const next = read();
  const id = connectionId(target);
  const stored: StoredConnection = {
    host: target.host,
    port: target.port,
    tls: target.tls,
    name: target.name,
  };
  if (token && !isLoopback(target.host)) {
    if (safeStorage.isEncryptionAvailable()) {
      stored.tokenEnc = safeStorage.encryptString(token).toString('base64');
      memoryTokens.delete(id);
    } else {
      memoryTokens.set(id, token);
    }
  } else if (token) {
    memoryTokens.set(id, token);
  }
  next.connections = [...next.connections.filter((c) => connectionId(c) !== id), stored];
  next.activeConnectionId = id;
  write(next);
  addRecentInternal(next, id, target.name);
  return id;
}

export function removeConnection(id: string): void {
  const next = read();
  next.connections = next.connections.filter((c) => connectionId(c) !== id);
  memoryTokens.delete(id);
  if (next.activeConnectionId === id) next.activeConnectionId = null;
  write(next);
}

export function clearConnections(): void {
  const next = read();
  next.connections = [];
  next.activeConnectionId = null;
  memoryTokens.clear();
  write(next);
}

export function loadActiveConnectionId(): string | null {
  return read().activeConnectionId;
}

export function saveActiveConnectionId(id: string | null): void {
  const next = read();
  next.activeConnectionId = id;
  write(next);
}

export function listRecent(): RecentConnection[] {
  return read().recent;
}

function addRecentInternal(file: SettingsFile, baseUrl: string, name: string | null): void {
  const rest = file.recent.filter((r) => r.baseUrl !== baseUrl);
  file.recent = [{ baseUrl, name, lastUsedAt: Date.now() }, ...rest].slice(0, MAX_RECENT);
  write(file);
}

/** Record a connection only after it has actually succeeded. */
export function rememberConnection(baseUrl: string, name: string | null): void {
  const next = read();
  addRecentInternal(next, baseUrl, name);
}

/**
 * Window close behaviour and notifications. These live in main rather than the
 * renderer's localStorage because main has to act on them before (and without)
 * a renderer: the close button is handled by the window, not by React.
 */
export function loadPrefs(): AppPrefs {
  return read().prefs;
}

/** The daemon we spawned (and may have left running) — see {@link ManagedDaemonRecord}. */
export function loadManagedDaemon(): ManagedDaemonRecord | null {
  return read().managedDaemon;
}

export function saveManagedDaemon(record: ManagedDaemonRecord | null): void {
  const next = read();
  next.managedDaemon = record;
  write(next);
}

export function savePrefs(patch: Partial<AppPrefs>): AppPrefs {
  const file = read();
  file.prefs = { ...file.prefs, ...patch };
  write(file);
  return file.prefs;
}

/** Last window geometry, or null on a first run / after a reset. */
export function loadWindowBounds(): WindowBounds | null {
  return read().windowBounds;
}

export function saveWindowBounds(bounds: WindowBounds): void {
  const file = read();
  file.windowBounds = bounds;
  write(file);
}
