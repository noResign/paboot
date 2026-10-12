#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, printHelp, VERSION, type CliOptions } from './cli.js';
import { loadConfig, type Config } from './config.js';
import type { AppContext } from './context.js';
import type { Db } from './db.js';
import { log } from './log.js';
import { listLocalAddresses } from './network.js';
import { PermissionManager } from './permissions.js';
import { fromLegacyPermissionMode } from './permission-mode.js';
import { RunNotifier } from './run-notifier.js';
import { registerRuntimeDrivers } from './runtimes/drivers.js';
import { createRegistry } from './runtimes/registry.js';
import { clearRuntimeInfo, startHeartbeat, writeRuntimeInfo } from './runtime-info.js';
import { startServer } from './server.js';

/**
 * Load a `.env` file into `process.env` (never overrides an already-set env
 * var). Defaults to `./.env`; pass `--env-file` or set `PABOOT_ENV_FILE` to
 * override. Missing file is fine; a malformed file only warns.
 */
function loadDotEnvFile(envFile?: string): void {
  const file = envFile ?? process.env.PABOOT_ENV_FILE ?? path.join(process.cwd(), '.env');
  try {
    process.loadEnvFile(file);
    log.info(`loaded config from ${file}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    log.warn(`failed to load ${file}: ${(err as Error).message}`);
  }
}

function printConnectInfo(config: Config): void {
  const protocol = config.tls ? 'https' : 'http';
  const port = config.port;
  const lan = listLocalAddresses();
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);

  if (loopback) {
    log.warn(`bound to ${config.host} — remote clients on the LAN cannot reach it.`);
    log.warn('to accept LAN connections, start with: PABOOT_HOST=0.0.0.0');
    if (lan.length > 0) {
      log.info(`your LAN address(es): ${lan.map((a) => `${protocol}://${a}:${port}`).join(', ')}`);
    }
  } else if (lan.length > 0) {
    log.info('connect from another device using one of:');
    for (const addr of lan) log.info(`  ${protocol}://${addr}:${port}`);
  } else {
    log.info(`listening on ${protocol}://${config.host}:${port} (no LAN IPv4 detected)`);
  }
}

/**
 * This daemon's stable identity, minted once and kept in the DB so it survives
 * restarts. Clients use it to recognise the same machine reached by a different
 * address (LAN today, a tunnel or relay later).
 */
function resolveServerId(db: Db): string {
  const existing = db.getSetting('server_id');
  if (existing) return existing;
  const id = randomUUID();
  db.setSetting('server_id', id);
  return id;
}

async function main(): Promise<void> {
  let cli: CliOptions;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${printHelp()}\n`);
    process.exitCode = 1;
    return;
  }
  if (cli.help) {
    process.stdout.write(printHelp());
    return;
  }
  if (cli.version) {
    process.stdout.write(`paboot ${VERSION}\n`);
    return;
  }

  loadDotEnvFile(cli.envFile);

  const config = loadConfig(process.env, {
    host: cli.host,
    port: cli.port,
    workspace: cli.workspace,
    dataDir: cli.dataDir,
    token: cli.token,
    permissionMode: cli.permissionMode,
  });
  // Lazy-import the DB so `--help` / `--version` don't load node:sqlite
  // (and don't print Node's experimental-sqlite warning on stderr).
  const { Db } = await import('./db.js');
  const db = new Db(path.join(config.dataDir, 'paboot.sqlite'));
  db.seedDefaultWorkspace(config.workspace, fromLegacyPermissionMode(config.permissionMode), config.workspaceSource);
  // Runs are only ever `running` while a process is live. After a restart the
  // active-run registry is empty, so anything still `running` is a run the
  // previous process left behind — reconcile it before serving requests.
  const orphanedRuns = db.interruptOrphanedRuns('daemon restarted while the run was in flight');
  if (orphanedRuns > 0) log.warn(`interrupted ${orphanedRuns} orphaned run(s) left by a previous process`);
  const registry = createRegistry();

  log.info('paboot daemon starting');
  log.info(`data dir: ${config.dataDir}`);
  log.info(`workspace: ${config.workspace}`);

  const claude = await registry.detect('claude', process.env);
  if (claude?.available) {
    const authState = claude.authed === true ? 'authenticated' : claude.authed === false ? 'NOT authenticated' : 'auth unknown';
    log.info(`claude: v${claude.version ?? '?'} (${authState})`);
    log.info(`claude capabilities: ${JSON.stringify(claude.capabilities)}`);
  } else {
    log.warn(`claude runtime NOT available: ${claude?.error ?? 'not found'}`);
  }

  const notifier = new RunNotifier();
  const ctx: AppContext = {
    config,
    db,
    registry,
    permissions: new PermissionManager(
      config.permissionTimeoutMs,
      (req) => {
        db.updateEventPermissionStatus(req.id, req.status);
        // Pending requests may be resolved by timeout / run cleanup / allow-all
        // without a direct client action. Push the new status so every attached
        // client can remove it from its approval queue.
        if (req.announced) {
          notifier.emit(req.runId, {
            type: 'permission_request',
            permissionId: req.id,
            toolName: req.toolName,
            toolInput: req.toolInput,
            status: req.status,
          });
        }
      },
    ),
    notifier,
    hookPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'permission-hook.js'),
  };

  // Register the execution driver for each runtime (argv and RPC alike) now
  // that the daemon services they depend on exist.
  registerRuntimeDrivers(registry, ctx);

  const server = startServer(ctx);
  printConnectInfo(config);

  // Publish where we are — but only once the socket is actually accepting, so
  // a client that reads the file can connect to what it names.
  let stopHeartbeat: (() => void) | null = null;
  server.once('listening', () => {
    const info = writeRuntimeInfo(config, resolveServerId(db));
    if (info) {
      stopHeartbeat = startHeartbeat(config.dataDir);
      log.info(`runtime info: ${info.listen} (serverId ${info.serverId})`);
    }
  });

  // Until now a signal simply killed the process; now it also retracts the
  // runtime info file so clients stop dialing us. Every event is committed
  // before it reaches a socket, so exiting immediately is safe.
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    stopHeartbeat?.();
    clearRuntimeInfo(config.dataDir);
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  log.info(`auth token: ${config.token}`);
  log.info(`  (${config.tokenGenerated ? 'generated and persisted at' : 'loaded from'} ${config.tokenPath})`);
  log.info(`permission mode: ${config.permissionMode}`);
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
