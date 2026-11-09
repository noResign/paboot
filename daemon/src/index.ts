#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, printHelp, VERSION, type CliOptions } from './app/cli.js';
import { loadConfig, type Config } from './app/config.js';
import type { AppContext } from './app/context.js';
import { acquireDataDirLock, lockPath } from './app/data-dir-lock.js';
import { log } from './platform/log.js';
import { listLocalAddresses } from './platform/network.js';
import { KnowledgeStore } from './knowledge/store.js';
import { MemoryKnowledgeIndexer } from './memory/knowledge-index.js';
import { configuredMemoryModel, resolveMemoryModel } from './memory/model.js';
import { MemoryStore } from './memory/store.js';
import { MemoryWorker } from './memory/worker.js';
import { AttachmentStore } from './attachments/store.js';
import { DEFAULT_PROVIDERS_FILE } from './llm/credentials.js';
import { ProviderManager } from './providers/provider-manager.js';
import { PermissionManager } from './permissions/permissions.js';
import { fromLegacyPermissionMode } from './permissions/permission-mode.js';
import { RunNotifier } from './runs/run-notifier.js';
import { registerRuntimeDrivers } from './runtimes/drivers.js';
import { loadBuiltinConfig, logBuiltinConfigWarnings } from './runtimes/builtin/config.js';
import { Scheduler } from './scheduling/scheduler.js';
import { createRegistry } from './runtimes/registry.js';
import { clearRuntimeInfo, startHeartbeat, writeRuntimeInfo } from './app/runtime-info.js';
import { startServer } from './app/server.js';
import { resolveServerId } from './db/server-id.js';

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
    token: cli.token,
    permissionMode: cli.permissionMode,
  });
  if (cli.printOperatorToken) {
    // Deliberately before the data-dir lock: printing must work while a
    // daemon is already running and holding the lock.
    process.stdout.write(`${config.token}\n`);
    return;
  }

  // Take the data dir *before* anything opens the DB. A second daemon on the
  // same root would fight over the SQLite file and, worse, its boot-time
  // `interruptOrphanedRuns` would rewrite this process's live runs as
  // interrupted — killing runs that are still streaming (see data-dir-lock.ts).
  const lock = acquireDataDirLock(config.dataDir);
  if (!lock.ok) {
    log.error(
      `${config.dataDir} 上已经有 daemon 在运行${lock.pid ? `（pid ${lock.pid}）` : ''}——` +
        `一个数据目录同时只能跑一个 daemon。确认它已停止后重试，` +
        `或确认没有它的进程后删除 ${lockPath(config.dataDir)}。`,
    );
    process.exitCode = 1;
    return;
  }

  // Lazy-import the DB so `--help` / `--version` don't load node:sqlite
  // (and don't print Node's experimental-sqlite warning on stderr).
  const { Db } = await import('./db/db.js');
  const db = new Db(path.join(config.dataDir, 'paboot.sqlite'));
  db.seedDefaultWorkspace(
    config.workspace,
    fromLegacyPermissionMode(config.permissionMode),
    config.workspaceSource,
    // The desktop offers this as the first-run fallback; the same path is what
    // marks the workspace as built-in instead of a real user choice.
    path.join(config.dataDir, 'defaultworkspace'),
  );
  // The life workspace is built-in and reset-only. Creating it at boot keeps it
  // out of the schema migration and means `GET /api/workspaces` always has the
  // 「生活」entry a client must render (family=life is the one builtin exception).
  db.ensureLifeWorkspace(path.join(config.dataDir, 'life'));
  // Runs are only ever `running` while a process is live. After a restart the
  // active-run registry is empty, so anything still `running` is a run the
  // previous process left behind — reconcile it before serving requests.
  const orphanedRuns = db.interruptOrphanedRuns('daemon restarted while the run was in flight');
  if (orphanedRuns > 0) log.warn(`interrupted ${orphanedRuns} orphaned run(s) left by a previous process`);
  // Older daemons disabled tasks when their session disappeared. Tidy those
  // dangling rows once at boot so the task list cannot show broken entries.
  const orphanedTasks = db.deleteOrphanedScheduledTasks();
  if (orphanedTasks > 0) log.warn(`deleted ${orphanedTasks} scheduled task(s) whose session no longer exists`);
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

  const builtinConfig = await loadBuiltinConfig(config.dataDir);
  logBuiltinConfigWarnings(builtinConfig);

  const notifier = new RunNotifier();
  const memory = new MemoryStore(config.dataDir);
  const ctx: AppContext = {
    config,
    db,
    knowledge: new KnowledgeStore(config.dataDir),
    memory,
    attachments: new AttachmentStore(db, config.dataDir),
    providers: new ProviderManager({
      providersFile: process.env.PABOOT_LLM_PROVIDERS_FILE?.trim() || DEFAULT_PROVIDERS_FILE(),
    }),
    builtinConfig: builtinConfig.config,
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
    mcpServerPath: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'mcp',
      'servers',
      'paboot_tasks',
      'server.js',
    ),
    capabilityMcpServerPath: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'mcp',
      'servers',
      'paboot_capability',
      'server.js',
    ),
    memoryMcpServerPath: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'mcp',
      'servers',
      'paboot_memory',
      'server.js',
    ),
  };

  // K2 lives in memory.db but the files stay authoritative; rebuild the mirror
  // for every known workspace at boot, then keep it fresh from knowledge routes.
  const knowledgeIndex = new MemoryKnowledgeIndexer(memory, ctx.knowledge);
  ctx.knowledgeIndex = knowledgeIndex;
  for (const workspace of db.listWorkspaces()) {
    try {
      knowledgeIndex.syncWorkspace(workspace.id);
    } catch (err) {
      log.warn(`knowledge index sync failed for workspace ${workspace.id}`, err);
    }
  }

  const memoryWorker = new MemoryWorker({
    store: memory,
    // Settings saved from the desktop pick a model; the env var is the
    // headless fallback. Neither = record-only.
    resolveModel: () =>
      resolveMemoryModel(configuredMemoryModel((key) => ctx.db.getSetting(key), config.memoryModel)),
  });
  ctx.memoryWorker = memoryWorker;
  const effectiveMemoryModel = configuredMemoryModel(
    (key) => ctx.db.getSetting(key),
    config.memoryModel,
  );
  if (effectiveMemoryModel) {
    log.info(`memory: extraction model ${effectiveMemoryModel}`);
  } else {
    log.info('memory: record-only (pick a model in Settings → Providers)');
  }

  // Register the execution driver for each runtime (argv and RPC alike) now
  // that the daemon services they depend on exist.
  registerRuntimeDrivers(registry, ctx);

  const scheduler = new Scheduler(ctx);

  // Publish where we are — but only once the socket is actually accepting, so
  // a client that reads the file can connect to what it names.
  let stopHeartbeat: (() => void) | null = null;

  // Until now a signal simply killed the process; now it also retracts the
  // runtime info file so clients stop dialing us. Every event is committed
  // before it reaches a socket, so exiting immediately is safe.
  //
  // Windows has no SIGTERM, so an owning client can ask for this same path over
  // HTTP (`POST /api/system/shutdown`); see `routes/system.ts`.
  let stopping = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info(`${reason} received, shutting down`);
    try {
      scheduler.stop();
      await memoryWorker.stop();
      stopHeartbeat?.();
      memory.close();
    } catch (err) {
      log.warn('shutdown cleanup failed', err);
    } finally {
      clearRuntimeInfo(config.dataDir);
      lock.release();
      process.exit(0);
    }
  };

  const server = startServer(ctx, { requestShutdown: (reason) => void shutdown(reason) });
  printConnectInfo(config);

  server.once('listening', () => {
    const info = writeRuntimeInfo(config, resolveServerId(db));
    if (info) {
      stopHeartbeat = startHeartbeat(config.dataDir);
      log.info(`runtime info: ${info.listen} (serverId ${info.serverId})`);
    }
    scheduler.start();
    memoryWorker.start();
  });

  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  // Windows consoles deliver Ctrl+Break as SIGBREAK. Registering it elsewhere
  // throws ERR_UNKNOWN_SIGNAL, so this must stay platform-gated.
  if (process.platform === 'win32') {
    process.once('SIGBREAK', () => { void shutdown('SIGBREAK'); });
  }

  log.info(`operator token: ${config.token}`);
  log.info(`  (${config.tokenGenerated ? 'generated and persisted at' : 'loaded from'} ${config.tokenPath})`);
  log.info(`permission mode: ${config.permissionMode}`);
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
