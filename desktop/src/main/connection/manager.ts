import { safeStorage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonClient, probeHealth } from '../daemon/client';
import * as settings from '../settings';
import { ROUTES } from '../../shared/routes';
import {
  baseUrlOf,
  dialHost,
  parseEnvFile,
  probeDaemons,
  splitListen,
  type ProbeDeps,
} from './discovery';
import type {
  BootstrapResult,
  ConnectInput,
  ConnectResult,
  ConnectionView,
  DiscoveredDaemon,
  LocalTokenHint,
  ProbeResult,
} from '../../shared/ipc';

interface Target {
  host: string;
  port: number;
  tls: boolean;
  name: string | null;
}

/** Past this, a probe is too old to vouch for "this address is a local daemon". */
const PROBE_MAX_AGE_MS = 5 * 60_000;

interface Entry {
  target: Target;
  /** The daemon's own identity once known — see `ConnectionView.serverId`. */
  serverId: string | null;
  token: string | null;
  client: DaemonClient | null;
  /** Why a connect attempt failed, so the switcher can say more than "未连接". */
  error: string | null;
  /** The token was read from a local file rather than typed by the user. */
  localTokenSource: string | null;
}

/**
 * Holds every daemon the user is connected to — the plan's §4: 每 host 一条连接，
 * 全部保持连接，「切换」只是导航. The renderer scopes its rail and main area by
 * `connectionId`; switching hosts therefore costs nothing to re-establish.
 *
 * Main is the only place a token lives, so this is also the only place that can
 * reach a daemon at all.
 */
export class ConnectionManager {
  private readonly entries = new Map<string, Entry>();
  private lastProbe: ProbeResult | null = null;
  private lastProbedAt = 0;
  private managedPidProvider: () => number | null = () => null;

  /**
   * Tell discovery which pid belongs to the daemon we spawned, so it can label
   * that hit `managed` and any other `default`. Needed because both now share
   * `~/.paboot` — the old path-based distinction is gone.
   */
  setManagedPidProvider(provider: () => number | null): void {
    this.managedPidProvider = provider;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  clientFor(id: string): DaemonClient | null {
    return this.entries.get(id)?.client ?? null;
  }

  views(): ConnectionView[] {
    return [...this.entries.entries()].map(([id, entry]) => this.viewOf(id, entry));
  }

  view(id: string): ConnectionView | null {
    const entry = this.entries.get(id);
    return entry ? this.viewOf(id, entry) : null;
  }

  private viewOf(id: string, entry: Entry): ConnectionView {
    const t = entry.target;
    return {
      id,
      baseUrl: baseUrlOf(`${dialHost(t.host)}:${t.port}`, t.tls),
      serverId: entry.serverId,
      connected: entry.client !== null,
      name: t.name,
      host: t.host,
      port: t.port,
      tls: t.tls,
      hasToken: entry.token !== null,
      tokenEphemeral: !settings.isLoopback(t.host) && !safeStorage.isEncryptionAvailable(),
      tokenSource: entry.localTokenSource,
      error: entry.error,
    };
  }

  /**
   * Restore the connections the user saved, and run discovery **for information
   * only**: the result tells the UI whether a local daemon is there. Nothing is
   * attached and nothing is spawned — those stay user actions (§2 启动策略).
   *
   * Restored hosts dial in parallel and best-effort: an unreachable one stays in
   * the list with an error so the switcher can show it as down, rather than
   * disappearing or blocking a reachable one.
   */
  async bootstrap(): Promise<BootstrapResult> {
    // Restore only what the user explicitly saved, then probe so the connect
    // page can say「本机有没有 daemon」. Probing has no side effect; attaching and
    // starting do, and both stay user actions.
    for (const { target, token } of settings.loadConnections()) {
      this.applyTarget({ host: target.host, port: target.port, tls: target.tls, name: target.name }, token);
    }

    // Hosts that were only restored (no client yet) get a background attempt.
    // Best-effort and non-blocking on purpose: bootstrap must not wait on a
    // slow dial. The dial is also where a restored entry learns its `serverId`.
    void Promise.all(
      this.ids()
        .filter((id) => !this.entries.get(id)?.client)
        .map((id) => this.reconnect(id)),
    );

    const probe = await this.probe();
    const saved = settings.loadActiveConnectionId();
    return {
      connections: this.views(),
      activeId: saved && this.entries.has(saved) ? saved : (this.ids()[0] ?? null),
      probe,
    };
  }

  async probe(): Promise<ProbeResult> {
    const result = await probeDaemons(this.probeDeps());
    this.lastProbe = result;
    this.lastProbedAt = Date.now();
    return result;
  }

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const host = dialHost(input.host.trim());
    const port = input.port;
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return { ok: false, code: 'bad_address', message: '地址或端口不合法' };
    }
    const tls = input.tls ?? false;

    let token = input.token?.trim() || null;
    let source: string | null = null;
    if (!token) {
      // A local daemon must not make the user retype its token just because the
      // probe aged out while this page sat open: refresh it and look again.
      if (settings.isLoopback(host)) await this.refreshProbeIfStale();
      const local = this.readLocalToken(host, port, tls);
      if (local) {
        token = local.token;
        source = local.source;
      }
    }
    if (!token) {
      return { ok: false, code: 'token_required', message: '需要提供 token' };
    }

    const baseUrl = baseUrlOf(`${host}:${port}`, tls);
    const health = await probeHealth(baseUrl, 2000);
    if (!health) {
      return { ok: false, code: 'unreachable', message: `无法连接到 ${baseUrl}` };
    }

    const probeClient = new DaemonClient({ baseUrl, token });
    const check = await probeClient.request({ method: 'GET', path: ROUTES.workspaces, timeoutMs: 5000 });
    if (check.status === 401) {
      return { ok: false, code: 'unauthorized', message: 'token 无效' };
    }
    if (!check.ok) {
      return { ok: false, code: 'unreachable', message: `daemon 返回 ${check.status}` };
    }

    const target: Target = { host, port, tls, name: input.name ?? null };
    const id = settings.connectionId(target);
    // Same daemon, new address (LAN ↔ loopback ↔ a tunnel later): re-point the
    // entry we already have instead of adding a second one for it. A daemon too
    // old to send `serverId` leaves us unable to tell, so the address stays the
    // identity there.
    const serverId = health.serverId ?? null;
    const existing = serverId ? this.findByServerId(serverId) : null;
    if (existing && existing !== id) {
      this.entries.delete(existing);
      settings.removeConnection(existing);
    }
    this.applyTarget(target, token, source, serverId);
    settings.saveConnection(target, token);
    settings.saveActiveConnectionId(id);
    return { ok: true, view: this.view(id) as ConnectionView };
  }

  /**
   * Mark the connections to *this machine* as down. Called when we stop the local
   * daemon: their client is only an HTTP handle, so it would happily stay "connected"
   * and leave the window sitting on stale data with no way back to the connect page.
   * The saved target is kept — only the live client goes.
   */
  markLocalDown(): void {
    for (const entry of this.entries.values()) {
      if (!settings.isLoopback(entry.target.host)) continue;
      entry.client = null;
      entry.error = '本机 daemon 已停止';
      entry.serverId = null;
    }
  }

  /**
   * Re-dial the connections to this machine, picking up the token file as we go.
   * Used after the local daemon (re)starts — including a token change, which
   * rewrites `<data-dir>/token` and would leave the old client 401-ing. Reading
   * it here is safe: these targets are loopback and we just started that daemon.
   */
  async reDialLocal(): Promise<void> {
    let token: string | null = null;
    try {
      token = fs.readFileSync(path.join(daemonDataDir(), 'token'), 'utf8').trim() || null;
    } catch {
      token = null; // no token file: fall back to whatever the entry already holds
    }
    for (const [id, entry] of [...this.entries]) {
      if (!settings.isLoopback(entry.target.host)) continue;
      if (token) entry.token = token;
      await this.reconnect(id);
    }
  }

  /** Re-dial a restored connection using the token we already hold for it. */
  private async reconnect(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      const health = await probeHealth(baseUrlOf(`${entry.target.host}:${entry.target.port}`, entry.target.tls), 2000);
      if (!health) {
        entry.error = '连不上';
        return;
      }
      // A restored entry learns who it is talking to here (it did not go through
      // the connect flow, so it had no chance to).
      entry.serverId = health.serverId ?? entry.serverId;
      entry.client = entry.token
        ? new DaemonClient({ baseUrl: baseUrlOf(`${entry.target.host}:${entry.target.port}`, entry.target.tls), token: entry.token })
        : null;
      entry.error = entry.client ? null : '缺少 token';
    } catch {
      entry.error = '连不上';
    }
  }

  async disconnect(id: string): Promise<void> {
    this.entries.delete(id);
    settings.removeConnection(id);
    if (settings.loadActiveConnectionId() === id) {
      settings.saveActiveConnectionId(this.ids()[0] ?? null);
    }
  }

  clear(id?: string): void {
    if (id) {
      this.entries.delete(id);
      settings.removeConnection(id);
      return;
    }
    this.entries.clear();
    settings.clearConnections();
  }

  /** The entry already holding this daemon identity, if any. */
  private findByServerId(serverId: string): string | null {
    for (const [id, entry] of this.entries) {
      if (entry.serverId === serverId) return id;
    }
    return null;
  }

  private applyTarget(
    target: Target,
    token: string | null,
    localTokenSource: string | null = null,
    serverId: string | null = null,
  ): void {
    const id = settings.connectionId(target);
    this.entries.set(id, {
      target,
      serverId,
      token,
      localTokenSource,
      error: null,
      client: token
        ? new DaemonClient({ baseUrl: baseUrlOf(`${target.host}:${target.port}`, target.tls), token })
        : null,
    });
    settings.rememberConnection(baseUrlOf(`${target.host}:${target.port}`, target.tls), target.name);
  }

  /**
   * Read a token from disk — only for a target that matches a freshly probed
   * daemon. Without the match, "read `<dataDir>/token`" would be a generic
   * read-any-file primitive aimed at the renderer's choosing.
   */
  private readLocalToken(host: string, port: number, tls: boolean): { token: string; source: string } | null {
    const probe = this.lastProbe;
    if (!probe?.found || !probe.localToken) return null;
    if (Date.now() - this.lastProbedAt > PROBE_MAX_AGE_MS) return null;
    const foundAt = splitListen(probe.found.listen);
    if (!foundAt || foundAt.host !== host || foundAt.port !== port) return null;
    if (probe.found.tls !== tls) return null;
    return readTokenHint(probe.localToken);
  }

  /** Re-probe when the last scan is too old to vouch for a local token read. */
  private async refreshProbeIfStale(): Promise<void> {
    if (Date.now() - this.lastProbedAt > PROBE_MAX_AGE_MS) await this.probe();
  }

  private probeDeps(): ProbeDeps {
    return {
      homeDir: os.homedir(),
      managedPid: this.managedPidProvider(),
      saved: settings.listRecent().map((r) => r.baseUrl),
      now: () => Date.now(),
      readFile: (p) => {
        try {
          return fs.readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      },
      mtimeMs: (p) => {
        try {
          return fs.statSync(p).mtimeMs;
        } catch {
          return null;
        }
      },
      pidAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      probe: async (baseUrl, timeoutMs) => {
        const health = await probeHealth(baseUrl, timeoutMs);
        if (health) return { kind: 'paboot', health };
        return await probeOther(baseUrl, timeoutMs);
      },
    };
  }
}

function readTokenHint(hint: LocalTokenHint): { token: string; source: string } | null {
  try {
    const text = fs.readFileSync(hint.path, 'utf8');
    if (hint.kind === 'token-file') {
      const token = text.trim();
      return token ? { token, source: hint.source } : null;
    }
    const token = parseEnvFile(text)['PABOOT_TOKEN'];
    return token ? { token, source: hint.source } : null;
  } catch {
    return null;
  }
}

/** Distinguish "port answered but is not paboot" from "nothing there". */
async function probeOther(baseUrl: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(ROUTES.health, baseUrl), { signal: controller.signal });
    const body = await res.text();
    return { kind: 'other' as const, status: res.status, body };
  } catch {
    return { kind: 'none' as const };
  } finally {
    clearTimeout(timer);
  }
}

export function discoveredName(found: DiscoveredDaemon): string {
  return found.hostname || '本机 daemon';
}

/**
 * Where a daemon we spawn keeps its data. Deliberately the same `~/.paboot`
 * every other local daemon uses (§已定 6), so a daemon started here and one
 * started by hand see **one** set of sessions/workspaces/token instead of two
 * disconnected worlds.
 */
export function daemonDataDir(): string {
  return path.join(os.homedir(), '.paboot');
}
