import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from '../platform/paths.js';
import { DEFAULT_LOCKOUT_MS, DEFAULT_MAX_FAILURES } from '../http/auth.js';

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
  /** 初始 Workspace 根目录；首次启动时注册为默认 Workspace，之后可在手机上切换/新增。 */
  workspace: string;
  /**
   * 初始 workspace 的来源。`flag`(显式 `--workspace`)是**权威值**——每次启动都
   * 确保该目录存在并设为默认工作区;`env` / `default`(cwd) 只是首次安装的一次性
   * 种子,沿用旧语义(删掉的工作区不会重启后复活)。
   */
  workspaceSource: WorkspaceSource;
  token: string;
  tokenPath: string;
  tokenGenerated: boolean;
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

  // The workspace is the directory Claude Code (and future runtimes) operate
  // in directly. It defaults to the daemon's own cwd, so `cd <project> &&
  // paboot` makes that project the workspace.
  const workspace = path.resolve(expandHome(overrides.workspace ?? env.PABOOT_WORKSPACE ?? process.cwd()));
  const workspaceSource: WorkspaceSource =
    overrides.workspace !== undefined ? 'flag' : env.PABOOT_WORKSPACE?.trim() ? 'env' : 'default';
  fs.mkdirSync(workspace, { recursive: true });

  const { token: resolvedToken, tokenPath, generated, source } = resolveToken(env, dataDir);
  const token = overrides.token ?? resolvedToken;

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
  };
}
