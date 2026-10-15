import type { DaemonSource, LocalTokenHint, PortConflict, ProbeResult } from '../../shared/ipc';
import type { HealthDto } from '../../shared/contract';

/**
 * Where the daemon says where it is. Mirror of the daemon's `RuntimeInfo`
 * (`daemon/src/runtime-info.ts`) — kept as a local shape because the
 * daemon's copy is not exported over `./protocol` (it is a Node-only module).
 */
export interface RuntimeInfoFile {
  pid: number;
  startedAt: number;
  serverId: string;
  hostname: string;
  listen: string;
  tls: boolean;
  version: string;
  dataDir: string;
  tokenSource: 'env' | 'flag' | 'file';
}

/** Age past which a runtime-info file is treated as stale (daemon touches every 30s). */
export const STALE_AFTER_MS = 90_000;

/** Fixed small port list — ten loopback requests, not a port scan. */
export const PORT_SCAN_FROM = 4780;
export const PORT_SCAN_TO = 4789;

export type ProbeOutcome =
  | { kind: 'paboot'; health: HealthDto }
  | { kind: 'other'; status: number | null; body: string }
  | { kind: 'none' };

/** Everything the discovery walk touches, injected so it can be unit tested. */
export interface ProbeDeps {
  homeDir: string;
  /** pid of the daemon this app spawned, or null — decides `managed` vs `default`. */
  managedPid: number | null;
  saved: string[];
  now(): number;
  readFile(p: string): string | null;
  mtimeMs(p: string): number | null;
  pidAlive(pid: number): boolean;
  probe(baseUrl: string, timeoutMs: number): Promise<ProbeOutcome>;
}

interface Candidate {
  source: DaemonSource;
  listen: string;
  tls: boolean;
  meta: RuntimeInfoFile | null;
  tokenHint: LocalTokenHint | null;
}

export function isFresh(mtimeMs: number, nowMs: number): boolean {
  return nowMs - mtimeMs <= STALE_AFTER_MS;
}

/** Collapse a bind wildcard to something a client can actually dial. */
export function dialHost(host: string): string {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === '0.0.0.0') return '127.0.0.1';
  if (bare === '::' || bare === '0:0:0:0:0:0:0:0') return '::1';
  return bare;
}

/** `127.0.0.0/8`, `localhost` or `::1` — a saved address here points at this machine. */
export function isLoopback(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare === 'localhost' || bare.startsWith('127.') || bare === '::1' || bare === '0:0:0:0:0:0:0:1';
}

/** Split `host:port` (IPv6 bracketed) into a wildcard-collapsed host and a port. */
export function splitListen(listen: string): { host: string; port: number } | null {
  const idx = listen.lastIndexOf(':');
  if (idx < 0) return null;
  const port = Number.parseInt(listen.slice(idx + 1), 10);
  if (!Number.isInteger(port)) return null;
  return { host: dialHost(listen.slice(0, idx)), port };
}

/** `http://127.0.0.1:4780` → `127.0.0.1:4780`; returns null if unparseable. */
export function listenOf(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return `${dialHost(url.hostname)}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return null;
  }
}

export function baseUrlOf(listen: string, tls: boolean): string {
  const parsed = splitListen(listen);
  const host = parsed ? parsed.host : listen;
  const port = parsed ? parsed.port : 4780;
  const bracketed = host.includes(':') ? `[${host}]` : host;
  return `${tls ? 'https' : 'http'}://${bracketed}:${port}`;
}

/** Address identity for matching a saved connection against a runtime-info file. */
function normalize(listen: string): string {
  const parsed = splitListen(listen);
  return parsed ? `${parsed.host}:${parsed.port}` : listen;
}

export function parseRuntimeInfo(text: string): RuntimeInfoFile | null {
  try {
    const v = JSON.parse(text) as Partial<RuntimeInfoFile>;
    if (typeof v.pid !== 'number' || typeof v.listen !== 'string') return null;
    return {
      pid: v.pid,
      startedAt: typeof v.startedAt === 'number' ? v.startedAt : 0,
      serverId: typeof v.serverId === 'string' ? v.serverId : '',
      hostname: typeof v.hostname === 'string' ? v.hostname : '',
      listen: v.listen,
      tls: v.tls === true,
      version: typeof v.version === 'string' ? v.version : 'unknown',
      dataDir: typeof v.dataDir === 'string' ? v.dataDir : '',
      tokenSource: v.tokenSource === 'env' || v.tokenSource === 'flag' ? v.tokenSource : 'file',
    };
  } catch {
    return null;
  }
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface SystemdUnit {
  port: number | null;
  host: string | null;
  dataDir: string | null;
  envFiles: string[];
  inlineEnv: Record<string, string>;
}

/** Expand the systemd specifiers a unit realistically uses for a config path. */
export function expandUnitPath(p: string, homeDir: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return p
    .replace(/^~(?=\/|$)/, homeDir)
    .replace(/%[ht%]/g, (m) => (m === '%h' ? homeDir : m === '%t' ? `/run/user/${uid}` : '%'));
}

function parseAssignments(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of spec.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    let value = token.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[token.slice(0, eq)] = value;
  }
  return out;
}

/** Read just enough of a unit to guess the bind address (`ExecStart`, `Environment*`). */
export function parseSystemdUnit(text: string): SystemdUnit {
  const out: SystemdUnit = { port: null, host: null, dataDir: null, envFiles: [], inlineEnv: {} };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('EnvironmentFile=')) {
      out.envFiles.push(line.slice('EnvironmentFile='.length).trim().replace(/^-/, ''));
      continue;
    }
    if (line.startsWith('Environment=')) {
      Object.assign(out.inlineEnv, parseAssignments(line.slice('Environment='.length)));
      continue;
    }
    if (!line.startsWith('ExecStart=')) continue;
    const flag = (name: string): string | null => {
      const m = line.match(new RegExp(`--${name}[= ]([^\\s"']+)`));
      return m?.[1] ?? null;
    };
    const port = flag('port');
    if (port) out.port = Number.parseInt(port, 10);
    const host = flag('host');
    if (host) out.host = host;
    const dataDir = flag('data-dir');
    if (dataDir) out.dataDir = dataDir;
  }
  return out;
}

/** `~`-collapse for labels shown to the user. */
function tildify(p: string, homeDir: string): string {
  return p.startsWith(homeDir) ? `~${p.slice(homeDir.length)}` : p;
}

/**
 * Walk the candidate table (§2 of the desktop plan) and return the first
 * paboot daemon that answers. Order: saved → managed runtime info → default
 * runtime info → systemd unit → fixed port list.
 *
 * Probing nothing is *not* the same as "there is no daemon" — the caller must
 * offer the user a choice rather than spawning a second one.
 */
export async function probeDaemons(deps: ProbeDeps): Promise<ProbeResult> {
  const tried: string[] = [];
  let portConflict: PortConflict | null = null;

  const candidates: Candidate[] = [];

  // 0. saved connections — loopback only. The connect page renders this probe
  // as「本机 daemon」, so a saved *remote* target would make it label another
  // machine as local. Remote targets belong in the recent-connections list; a
  // loopback one is still how a custom-port local daemon with no runtime-info
  // (and no systemd unit) gets remembered.
  let savedLocal = 0;
  for (const base of deps.saved) {
    const listen = listenOf(base);
    const parsed = listen ? splitListen(listen) : null;
    if (!listen || !parsed || !isLoopback(parsed.host)) continue;
    candidates.push({ source: 'saved', listen, tls: base.startsWith('https:'), meta: null, tokenHint: null });
    savedLocal++;
  }
  if (savedLocal) tried.push(`已保存的连接（${savedLocal} 个）`);

  // 1. runtime-info file at the default data dir — the one place every local
  // daemon writes (the one we spawn shares `~/.paboot` too, §已定 6). Which
  // *source* it is has to come from the pid: path no longer tells them apart.
  const runtimeFile = `${deps.homeDir}/.paboot/daemon_runtime.json`;
  const runtimeText = deps.readFile(runtimeFile);
  if (runtimeText) {
    tried.push(tildify(runtimeFile, deps.homeDir));
    const info = parseRuntimeInfo(runtimeText);
    const mtime = deps.mtimeMs(runtimeFile) ?? 0;
    if (info && isFresh(mtime, deps.now()) && deps.pidAlive(info.pid)) {
      candidates.push({
        source: info.pid === deps.managedPid ? 'managed' : 'default',
        listen: info.listen,
        tls: info.tls,
        meta: info,
        tokenHint:
          info.tokenSource === 'file' && info.dataDir
            ? { path: `${info.dataDir}/token`, kind: 'token-file', source: `${tildify(info.dataDir, deps.homeDir)}/token` }
            : null,
      });
    }
  }

  // 3. systemd user unit (Linux) — also the place we might learn a token from.
  // A unit routinely declares neither --port nor --host (both come from the
  // EnvironmentFile), and paths carry `%h`; both have to be resolved here.
  const unitPath = `${deps.homeDir}/.config/systemd/user/paboot.service`;
  const unitText = deps.readFile(unitPath);
  if (unitText) {
    const unit = parseSystemdUnit(unitText);
    const envFilePath = unit.envFiles[0] ? expandUnitPath(unit.envFiles[0], deps.homeDir) : null;
    const envLabel = envFilePath ? tildify(envFilePath, deps.homeDir) : null;
    tried.push(`systemd：${tildify(unitPath, deps.homeDir)}${envLabel ? ` + ${envLabel}` : ''}`);
    const envText = envFilePath ? deps.readFile(envFilePath) : null;
    const env = { ...unit.inlineEnv, ...(envText ? parseEnvFile(envText) : {}) };
    const port = env['PABOOT_PORT'] ? Number.parseInt(env['PABOOT_PORT'], 10) : (unit.port ?? PORT_SCAN_FROM);
    const host = env['PABOOT_HOST'] ?? unit.host ?? '127.0.0.1';
    candidates.push({
      source: 'systemd',
      listen: `${dialHost(host)}:${port}`,
      tls: false,
      meta: null,
      tokenHint:
        env['PABOOT_TOKEN'] && envFilePath
          ? { path: envFilePath, kind: 'env-file', source: tildify(envFilePath, deps.homeDir) }
          : null,
    });
  }

  // 4. fixed port list
  tried.push(`127.0.0.1:${PORT_SCAN_FROM}-${PORT_SCAN_TO}`);
  for (let port = PORT_SCAN_FROM; port <= PORT_SCAN_TO; port++) {
    candidates.push({ source: 'port-scan', listen: `127.0.0.1:${port}`, tls: false, meta: null, tokenHint: null });
  }

  // Saved connections and the port list carry no metadata of their own, so a
  // match there would report "—" for hostname/dataDir/token source even though
  // the runtime-info file right next to it knows all of it. Enrich by address.
  const enrich = new Map<string, Candidate>();
  for (const cand of candidates) {
    if (cand.meta) enrich.set(normalize(cand.listen), cand);
  }

  for (const cand of candidates) {
    const baseUrl = baseUrlOf(cand.listen, cand.tls);
    const outcome = await deps.probe(baseUrl, 1000);
    if (outcome.kind === 'paboot') {
      const known = cand.meta ? cand : enrich.get(normalize(cand.listen));
      const meta = known?.meta ?? null;
      return {
        found: {
          source: cand.source,
          listen: cand.listen,
          tls: cand.tls,
          version: outcome.health.version,
          workspace: outcome.health.workspace,
          // Health is authoritative and works against a remote daemon; the local
          // runtime-info file is only a fallback for daemons too old to send it.
          serverId: outcome.health.serverId ?? meta?.serverId ?? null,
          dataDir: meta?.dataDir ?? null,
          hostname: meta?.hostname ?? null,
          tokenSource: meta?.tokenSource ?? null,
        },
        tried,
        portConflict,
        localToken: cand.tokenHint ?? known?.tokenHint ?? null,
      };
    }
    if (outcome.kind === 'other' && cand.source === 'port-scan' && !portConflict) {
      portConflict = {
        port: Number.parseInt(cand.listen.slice(cand.listen.lastIndexOf(':') + 1), 10),
        status: outcome.status,
        body: outcome.body.slice(0, 500),
      };
    }
  }

  return { found: null, tried, portConflict, localToken: null };
}
