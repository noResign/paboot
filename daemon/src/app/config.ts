import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from '../platform/paths.js';
import { DEFAULT_LOCKOUT_MS, DEFAULT_MAX_FAILURES } from '../http/auth.js';
import type { DebugMode } from '../platform/debug-flag.js';

export interface TlsConfig {
  cert: string;
  key: string;
}

/** Where the initial workspace came from — see {@link Config.workspaceSource}. */
export type WorkspaceSource = 'flag' | 'env' | 'default';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /**
   * 显式启动目录（`--workspace` / `PABOOT_WORKSPACE`）。没有显式指定时指向
   * 内置「个人空间」工作区，仅用于日志与 health；个人空间本身由
   * `ensureLifeWorkspace` 创建。
   */
  workspace: string;
  /**
   * 初始 workspace 的来源。`flag`(显式 `--workspace`)是**权威值**——每次启动都
   * 确保该目录存在并设为默认工作区;`env` 只是首次安装的一次性种子；`default`
   * 表示没有显式目录，启动时以「个人空间」为默认工作区。
   */
  workspaceSource: WorkspaceSource;
  token: string;
  tokenPath: string;
  tokenGenerated: boolean;
  /**
   * Internal token injected into the agent runtime / permission hook. Not
   * persisted and never shown to clients: it is read-only for the public API
   * plus the permission-hook internal endpoints.
   */
  agentToken: string;
  /**
   * Internal token injected only into MCP server processes (e.g.
   * paboot_tasks). It can call `/api/internal/*` but nothing public, and is
   * never present in the agent's own environment.
   */
  serverToken: string;
  /**
   * Where the bearer token came from. Clients read it from `tokenPath`, so they
   * must not do that unless this is `file` — otherwise they would pick up a
   * stale token that a previous run generated (see {@link resolveToken}).
   */
  tokenSource: 'env' | 'flag' | 'file';
  permissionMode: string;
  /** 同一来源连续认证失败多少次后进入冷却；0 = 关闭冷却。 */
  authMaxFailures: number;
  /** 首次冷却时长（ms）；再次触发翻倍，上限 15 分钟。 */
  authLockoutMs: number;
  /** 工具审批决策窗口（ms），超时自动拒绝。 */
  permissionTimeoutMs: number;
  /** 空闲看门狗：run 多久无事件则自动取消（ms，0 = 禁用）。 */
  runIdleTimeoutMs: number;
  tls: TlsConfig | null;
  /** 是否允许通过 /api/deploy 触发部署（PABOOT_ALLOW_DEPLOY=1）。 */
  allowDeploy: boolean;
  /** 部署脚本绝对路径（PABOOT_DEPLOY_SCRIPT 可覆盖）。 */
  deployScript: string;
  /**
   * `<provider>:<model>` used only for background memory extraction.
   * Unset = record-only (`none`): sources stay pending until configured.
   * This is separate from the agent model on purpose (D35).
   */
  memoryModel: string | null;
  /**
   * [debug] In-memory context audit for the `/debug` live page (no
   * persistence). `auto` captures only while a debug client is attached.
   */
  debugMode: DebugMode;
  /** Per-snapshot payload cap after redaction/truncation. */
  debugMaxBytes: number;
  /** Total in-memory cap across all live snapshots. */
  debugMaxTotalBytes: number;
  /** How long finished runs stay visible in the live page. */
  debugKeepMinutes: number;
}

/**
 * Resolve the bearer token. `env` wins over the persisted file, and the file is
 * only written when a token is generated — so an `env`-sourced token leaves the
 * file holding whatever a previous run generated. That stale value is why the
 * source is reported alongside the token: readers of `tokenPath` must check it.
 */
function resolveToken(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): { token: string; tokenPath: string; generated: boolean; source: 'env' | 'file' } {
  const tokenPath = path.join(dataDir, 'token');
  if (env.PABOOT_TOKEN && env.PABOOT_TOKEN.trim() !== '') {
    return { token: env.PABOOT_TOKEN.trim(), tokenPath, generated: false, source: 'env' };
  }
  if (fs.existsSync(tokenPath)) {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return { token: existing, tokenPath, generated: false, source: 'file' };
  }
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return { token, tokenPath, generated: true, source: 'file' };
}

function resolveTls(env: NodeJS.ProcessEnv): TlsConfig | null {
  const cert = env.PABOOT_TLS_CERT?.trim();
  const key = env.PABOOT_TLS_KEY?.trim();
  if (cert && key) return { cert, key };
  return null;
}

function resolvePermissionMode(env: NodeJS.ProcessEnv): string {
  const mode = env.PABOOT_PERMISSION_MODE?.trim();
  // Valid legacy Claude Code permission modes. The product default is `ask`
  // (mapped to Claude's `default`); set PABOOT_PERMISSION_MODE to override
  // the initial value of settings.default_permission_mode.
  const allowed = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
  if (mode && allowed.has(mode)) return mode;
  return 'default';
}

/** `PABOOT_AUTH_MAX_FAILURES`，默认 5；0 关闭冷却；负数/非法值回退默认。 */
function resolveAuthMaxFailures(env: NodeJS.ProcessEnv): number {
  const raw = env.PABOOT_AUTH_MAX_FAILURES?.trim();
  if (!raw) return DEFAULT_MAX_FAILURES;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_FAILURES;
}

/** `PABOOT_AUTH_LOCKOUT_SECONDS`，默认 60；非法值回退默认。 */
function resolveAuthLockoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.PABOOT_AUTH_LOCKOUT_SECONDS?.trim();
  if (!raw) return DEFAULT_LOCKOUT_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 1) return DEFAULT_LOCKOUT_MS;
  return seconds * 1000;
}

/** `PABOOT_PERMISSION_TIMEOUT_SECONDS`，默认 120；0 或非法值回退 120。 */
function resolvePermissionTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.PABOOT_PERMISSION_TIMEOUT_SECONDS?.trim();
  if (!raw) return 120 * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 1) return 120 * 1000;
  return seconds * 1000;
}

/** `PABOOT_RUN_IDLE_TIMEOUT_SECONDS`，默认 900（15 分钟）；0 = 禁用。 */
function resolveRunIdleTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.PABOOT_RUN_IDLE_TIMEOUT_SECONDS?.trim();
  if (!raw) return 15 * 60 * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return 15 * 60 * 1000;
  return seconds * 1000;
}

/**
 * [debug] `PABOOT_DEBUG`：`auto`（默认）只在有 debug 客户端连接时采集；
 * `on` 常开；`off` 关闭。`0/false` 等价 off，`1/true` 等价 on。
 */
function resolveDebugMode(env: NodeJS.ProcessEnv): DebugMode {
  const raw = env.PABOOT_DEBUG?.trim().toLowerCase();
  if (!raw || raw === 'auto') return 'auto';
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return 'off';
  return 'on';
}

/** [debug] `PABOOT_DEBUG_MAX_BYTES`，默认 1 MiB；非法值回退默认。 */
function resolveDebugMaxBytes(env: NodeJS.ProcessEnv): number {
  const raw = env.PABOOT_DEBUG_MAX_BYTES?.trim();
  if (!raw) return 1024 * 1024;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 4096) return 1024 * 1024;
  return Math.min(Math.floor(value), 64 * 1024 * 1024);
}

/** [debug] `PABOOT_DEBUG_MAX_TOTAL_BYTES`，默认 32 MiB；非法值回退默认。 */
function resolveDebugMaxTotalBytes(env: NodeJS.ProcessEnv): number {
  const raw = env.PABOOT_DEBUG_MAX_TOTAL_BYTES?.trim();
  if (!raw) return 32 * 1024 * 1024;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 64 * 1024) return 32 * 1024 * 1024;
  return Math.min(Math.floor(value), 512 * 1024 * 1024);
}

/** [debug] `PABOOT_DEBUG_KEEP_MINUTES`，默认 10；0 = 结束即移除。 */
function resolveDebugKeepMinutes(env: NodeJS.ProcessEnv): number {
  const raw = env.PABOOT_DEBUG_KEEP_MINUTES?.trim();
  if (!raw) return 10;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 10;
  return Math.min(Math.floor(value), 24 * 60);
}

/** CLI flag values that take precedence over env vars. */
export interface ConfigOverrides {
  host?: string;
  port?: number;
  workspace?: string;
  token?: string;
  permissionMode?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: ConfigOverrides = {}): Config {
  // Fixed, not configurable: one data root per user keeps `serverId` a stable
  // identity for this machine (it is minted once and persisted in the DB here),
  // which is what lets a client recognise the same daemon behind a different
  // address. A movable root would move the identity with it.
  const dataDir = path.join(os.homedir(), '.paboot');
  fs.mkdirSync(dataDir, { recursive: true });

  // With no explicit --workspace / PABOOT_WORKSPACE the only workspace is the
  // built-in life workspace. Keeping that path here means a bare `paboot` never
  // registers wherever it happened to be launched from.
  const workspace = path.resolve(
    expandHome(overrides.workspace ?? env.PABOOT_WORKSPACE ?? path.join(dataDir, 'life')),
  );
  const workspaceSource: WorkspaceSource =
    overrides.workspace !== undefined ? 'flag' : env.PABOOT_WORKSPACE?.trim() ? 'env' : 'default';
  fs.mkdirSync(workspace, { recursive: true });

  const { token: resolvedToken, tokenPath, generated, source } = resolveToken(env, dataDir);
  const token = overrides.token ?? resolvedToken;
  // Internal credentials rotate on every daemon start. They are not files and
  // not configurable: a long-lived agent token is exactly the leak this split
  // is meant to avoid. Child processes get the current value at spawn time.
  const agentToken = randomBytes(32).toString('hex');
  const serverToken = randomBytes(32).toString('hex');

  const host = overrides.host ?? (env.PABOOT_HOST?.trim() || '0.0.0.0');
  const port = overrides.port ?? Number(env.PABOOT_PORT ?? 4780);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${port}`);
  }

  return {
    host,
    port,
    dataDir,
    workspace,
    workspaceSource,
    token,
    tokenPath,
    tokenGenerated: overrides.token ? false : generated,
    tokenSource: overrides.token ? 'flag' : source,
    agentToken,
    serverToken,
    permissionMode: overrides.permissionMode ?? resolvePermissionMode(env),
    authMaxFailures: resolveAuthMaxFailures(env),
    authLockoutMs: resolveAuthLockoutMs(env),
    permissionTimeoutMs: resolvePermissionTimeoutMs(env),
    runIdleTimeoutMs: resolveRunIdleTimeoutMs(env),
    tls: resolveTls(env),
    allowDeploy: env.PABOOT_ALLOW_DEPLOY === '1' || env.PABOOT_ALLOW_DEPLOY === 'true',
    deployScript: path.resolve(
      env.PABOOT_DEPLOY_SCRIPT ?? path.join(process.cwd(), '..', '.claude/skills/deploy/scripts/deploy.sh'),
    ),
    memoryModel: env.PABOOT_MEMORY_MODEL?.trim() || null,
    debugMode: resolveDebugMode(env),
    debugMaxBytes: resolveDebugMaxBytes(env),
    debugMaxTotalBytes: resolveDebugMaxTotalBytes(env),
    debugKeepMinutes: resolveDebugKeepMinutes(env),
  };
}
