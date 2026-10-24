import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorkspaceSource } from './config.js';
import { serializeModelParameters } from './model-selection.js';

/** Setting key: the `env` / `cwd` startup workspace has already been seeded once. */
const SEEDED_WORKSPACE_KEY = 'workspace_seeded';

export interface SessionRow {
  id: string;
  runtime: string;
  /** `chat` for agent sessions, `command` for the hidden sessions behind command tasks. */
  kind: string;
  /**
   * The provider's own session handle: a Claude session id or a Codex thread
   * id. Name it for the role, not the provider — `runtime` already says which.
   */
  native_session_id: string | null;
  workspace_id: string | null;
  permission_mode: string;
  /** Chosen at creation; `null` means the runtime's own default. */
  model: string | null;
  /** JSON object of generic model parameters (e.g. `{"reasoningEffort":"high"}`). */
  model_parameters: string | null;
  cwd: string;
  title: string | null;
  /** `task_config` for the per-workspace AI authoring chat; NULL otherwise. */
  purpose: string | null;
  created_at: number;
  last_active_at: number;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  path: string;
  is_default: number;
  enabled: number;
  created_at: number;
  last_used_at: number;
}

export interface PermissionGrantRow {
  session_id: string;
  tool_name: string;
  created_at: number;
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: number;
}

export interface RunRow {
  id: string;
  session_id: string;
  runtime: string;
  model: string | null;
  model_parameters: string | null;
  status: string;
  prompt: string;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  error: string | null;
  command_id: string | null;
  /** Set when the run was started by a scheduled task. */
  task_id: string | null;
  /** `user` | `scheduled` | `run_now`. */
  trigger: string;
  /** Permission mode actually used for this run. */
  permission_mode: string | null;
}

export interface ScheduledTaskRow {
  id: string;
  name: string;
  task_type: string;
  session_mode: string;
  session_id: string | null;
  workspace_id: string;
  runtime: string;
  model: string | null;
  model_parameters: string | null;
  prompt: string | null;
  command: string | null;
  permission_mode: string;
  cron_expr: string;
  timezone: string;
  schedule_preset: string | null;
  next_run_at: number | null;
  last_fire_at: number | null;
  last_run_at: number | null;
  last_status: string;
  last_error: string | null;
  last_run_id: string | null;
  run_count: number;
  enabled: number;
  disabled_reason: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

/** Per-run workspace checkpoint. `status`: complete | unavailable | rolled_back. */
export interface RunCheckpointRow {
  run_id: string;
  repo_root: string;
  pre_ref: string | null;
  post_ref: string | null;
  status: string;
  created_at: number;
}

export interface EventRow {
  id: number;
  run_id: string;
  seq: number;
  type: string;
  payload: string;
  created_at: number;
}

export interface DeployJobRow {
  id: string;
  channel: string;
  target: string;
  status: string;
  unit: string;
  log_path: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  error: string | null;
}

/**
 * SQLite-backed persistence. Uses Node's built-in `node:sqlite`
 * (`DatabaseSync`) so there are zero native build dependencies: `pnpm install`
 * on macOS/Linux needs no node-gyp. All daemon-owned data lives under the
 * configured data dir; the caller passes the resolved file path.
 */
export class Db {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        native_session_id TEXT,
        cwd TEXT NOT NULL,
        title TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        exit_code INTEGER,
        error TEXT,
        command_id TEXT
      );

      CREATE TABLE IF NOT EXISTS run_checkpoints (
        run_id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        pre_ref TEXT,
        post_ref TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events (run_id, seq);

      CREATE TABLE IF NOT EXISTS deploy_jobs (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        unit TEXT NOT NULL,
        log_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        exit_code INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deploy_jobs_created ON deploy_jobs (created_at DESC);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        action TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        is_default INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_dirs (
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, path)
      );

      -- 浏览快捷方式：纯粹是文件 Tab 的书签，**不授予 agent 任何权限**。
      -- 与 workspace_dirs（授权）刻意分开存，避免两者语义混淆。
      CREATE TABLE IF NOT EXISTS workspace_shortcut_dirs (
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, path)
      );

      CREATE TABLE IF NOT EXISTS session_permission_grants (
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, tool_name)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        task_type TEXT NOT NULL,
        session_mode TEXT NOT NULL,
        session_id TEXT,
        workspace_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        model TEXT,
        model_parameters TEXT,
        prompt TEXT,
        command TEXT,
        permission_mode TEXT NOT NULL DEFAULT 'bypass',
        cron_expr TEXT NOT NULL,
        timezone TEXT NOT NULL,
        schedule_preset TEXT,
        next_run_at INTEGER,
        last_fire_at INTEGER,
        last_run_at INTEGER,
        last_status TEXT NOT NULL DEFAULT 'never',
        last_error TEXT,
        last_run_id TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        disabled_reason TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON scheduled_tasks (enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON scheduled_tasks (session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON scheduled_tasks (workspace_id);
    `);
    // Only Claude existed when this column was named for it; Codex stores its
    // thread id in the same slot. Rename before any read so old daemons keep
    // their sessions instead of silently starting fresh ones.
    this.ensureRenamedColumn('sessions', 'claude_session_id', 'native_session_id');
    this.ensureColumn('sessions', 'workspace_id', 'TEXT');
    this.ensureColumn('sessions', 'permission_mode', "TEXT NOT NULL DEFAULT 'ask'");
    this.ensureColumn('sessions', 'model', 'TEXT');
    this.ensureColumn('sessions', 'model_parameters', 'TEXT');
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions (workspace_id, last_active_at DESC);`);
    // A client-supplied command id makes `POST /api/chat` idempotent: a retry
    // (dropped response, flaky link) re-attaches to the run it already started
    // instead of starting a second one. NULL for callers that don't send one.
    this.ensureColumn('runs', 'command_id', 'TEXT');
    this.ensureColumn('sessions', 'kind', "TEXT NOT NULL DEFAULT 'chat'");
    this.ensureColumn('sessions', 'purpose', 'TEXT');
    this.ensureColumn('runs', 'task_id', 'TEXT');
    this.ensureColumn('runs', 'trigger', "TEXT NOT NULL DEFAULT 'user'");
    this.ensureColumn('runs', 'permission_mode', 'TEXT');
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_runs_task ON runs (task_id, started_at DESC);`,
    );
    this.ensureColumn('runs', 'model_parameters', 'TEXT');
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_command ON runs (command_id);`);

    // 一次性清理：早期版本只在「加快捷」时去重，反向（先有书签、后把同一目录授权）
    // 会留下重复行，tab 行上于是出现两个相同目录。`addWorkspaceDir` 现在顺手删书签，
    // 但已经写进去的重复行得在这里抹掉。幂等，之后每次都查不到东西。
    this.db.exec(`
      DELETE FROM workspace_shortcut_dirs
      WHERE EXISTS (
        SELECT 1 FROM workspaces w WHERE w.id = workspace_shortcut_dirs.workspace_id
          AND w.path = workspace_shortcut_dirs.path
      ) OR EXISTS (
        SELECT 1 FROM workspace_dirs d WHERE d.workspace_id = workspace_shortcut_dirs.workspace_id
          AND d.path = workspace_shortcut_dirs.path
      );
    `);
  }

  /** SQLite has no `ADD COLUMN IF NOT EXISTS`; probe PRAGMA before altering. */
  private ensureColumn(table: string, column: string, ddl: string): void {
    if (this.hasColumn(table, column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  /** Rename is a no-op on a fresh database, where the new name already exists. */
  private ensureRenamedColumn(table: string, from: string, to: string): void {
    if (!this.hasColumn(table, from) || this.hasColumn(table, to)) return;
    this.db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  }

  private hasColumn(table: string, column: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    return columns.some((c) => c.name === column);
  }

  close(): void {
    this.db.close();
  }

  // ---- sessions ----

  createSession(input: {
    id: string;
    runtime: string;
    workspaceId: string;
    permissionMode: string;
    cwd: string;
    model?: string | null;
    modelParameters?: Record<string, string> | null;
    native_session_id?: string | null;
    title?: string | null;
    /** Hidden command-task sessions use `command`; visible chat sessions use `chat`. */
    kind?: 'chat' | 'command';
    /** `task_config` marks the reusable AI authoring chat. */
    purpose?: 'task_config' | null;
  }): SessionRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, runtime, native_session_id, workspace_id, permission_mode, model, model_parameters, cwd, title, kind, purpose, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.runtime,
        input.native_session_id ?? null,
        input.workspaceId,
        input.permissionMode,
        input.model ?? null,
        serializeModelParameters(input.modelParameters ?? null),
        input.cwd,
        input.title ?? null,
        input.kind ?? 'chat',
        input.purpose ?? null,
        now,
        now,
      );
    return this.getSession(input.id) as SessionRow;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as unknown as SessionRow | undefined;
  }

  /** Visible sessions for clients. Hidden command-task sessions are excluded. */
  listSessions(workspaceId?: string): SessionRow[] {
    if (workspaceId) {
      return this.db
        .prepare(`SELECT * FROM sessions WHERE workspace_id = ? AND kind = 'chat' ORDER BY last_active_at DESC`)
        .all(workspaceId) as unknown as SessionRow[];
    }
    return this.db
      .prepare(`SELECT * FROM sessions WHERE kind = 'chat' ORDER BY last_active_at DESC`)
      .all() as unknown as SessionRow[];
  }

  /** Internal cleanup view: includes hidden command sessions. */
  listAllSessions(workspaceId?: string): SessionRow[] {
    if (workspaceId) {
      return this.db
        .prepare(`SELECT * FROM sessions WHERE workspace_id = ? ORDER BY last_active_at DESC`)
        .all(workspaceId) as unknown as SessionRow[];
    }
    return this.db
      .prepare(`SELECT * FROM sessions ORDER BY last_active_at DESC`)
      .all() as unknown as SessionRow[];
  }

  touchSession(id: string): void {
    this.db.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  setSessionTitle(id: string, title: string): void {
    this.db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, id);
  }

  setSessionModelSelection(
    id: string,
    model: string | null,
    modelParameters: Record<string, string> | null,
  ): void {
    this.db
      .prepare(`UPDATE sessions SET model = ?, model_parameters = ? WHERE id = ?`)
      .run(model, serializeModelParameters(modelParameters), id);
  }

  setNativeSessionId(id: string, nativeSessionId: string): void {
    this.db.prepare(`UPDATE sessions SET native_session_id = ? WHERE id = ?`).run(nativeSessionId, id);
  }

  setSessionPermissionMode(id: string, mode: string): void {
    this.db.prepare(`UPDATE sessions SET permission_mode = ? WHERE id = ?`).run(mode, id);
  }

  /** Drop one run's persisted events. */
  deleteEventsForRun(runId: string): void {
    this.db.prepare(`DELETE FROM events WHERE run_id = ?`).run(runId);
  }

  /** Delete a session and all its messages, runs, events and permission grants. */
  deleteSession(id: string): void {
    // A task is meaningless without its bound session: delete it together with
    // the session instead of leaving a broken row in the task list.
    this.deleteScheduledTasksForSession(id);
    const runs = this.listRuns(id);
    for (const run of runs) {
      this.deleteEventsForRun(run.id);
    }
    this.db.prepare(`DELETE FROM runs WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM session_permission_grants WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  // ---- workspaces ----

  /**
   * Register the startup Workspace and backfill legacy sessions.
   *
   * An explicit `--workspace` (`source: 'flag'`) is **authoritative**: the dir the
   * user named must be the default workspace, so it is re-asserted on every
   * start — an earlier run (or a hand-started daemon) must never lock the default
   * to wherever it happened to launch from. `env` / `default` (cwd) keep the old
   * one-time-seed semantics: a workspace the user deleted is not resurrected on
   * the next start (nor can a directory that no longer exists make startup throw).
   */
  seedDefaultWorkspace(
    rawPath: string,
    defaultPermissionMode: string,
    source: WorkspaceSource = 'default',
  ): WorkspaceRow | null {
    if (source === 'flag') {
      this.ensureWorkspaceDefault(rawPath);
    } else if (!this.getSetting(SEEDED_WORKSPACE_KEY)) {
      if (this.listWorkspaces().length === 0) {
        const realPath = fs.realpathSync(path.resolve(rawPath));
        this.createWorkspace({
          name: path.basename(realPath) || realPath,
          path: realPath,
          isDefault: true,
        });
      }
      this.setSetting(SEEDED_WORKSPACE_KEY, '1');
    }

    const workspace = this.getDefaultWorkspace() ?? this.listWorkspaces()[0] ?? null;
    if (workspace && !this.getDefaultWorkspace()) {
      this.setDefaultWorkspace(workspace.id);
    }

    if (!this.getSetting('default_permission_mode')) {
      this.setSetting('default_permission_mode', defaultPermissionMode);
    }

    // Current code only ever allowed sessions inside the single startup root.
    // Bind legacy null sessions to whatever workspace exists now.
    if (workspace) {
      this.db.prepare(`UPDATE sessions SET workspace_id = ? WHERE workspace_id IS NULL`).run(workspace.id);
    }
    this.db.prepare(`UPDATE sessions SET permission_mode = ? WHERE permission_mode IS NULL OR permission_mode = ''`).run(defaultPermissionMode);

    return workspace;
  }

  /**
   * Make `rawPath` the default workspace, creating it if absent and re-enabling
   * it if it had been disabled. The directory itself is created by `loadConfig`
   * before this runs, so `realpathSync` sees it.
   */
  private ensureWorkspaceDefault(rawPath: string): void {
    const realPath = fs.realpathSync(path.resolve(rawPath));
    const existing = this.getWorkspaceByPath(realPath);
    if (!existing) {
      this.createWorkspace({ name: path.basename(realPath) || realPath, path: realPath, isDefault: true });
      return;
    }
    if (existing.enabled !== 1) this.updateWorkspace(existing.id, { enabled: true });
    if (existing.is_default !== 1) this.setDefaultWorkspace(existing.id);
  }

  createWorkspace(input: { id?: string; name: string; path: string; isDefault?: boolean }): WorkspaceRow {
    const now = Date.now();
    const id = input.id ?? randomUUID();
    const isDefault = input.isDefault ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, path, is_default, enabled, created_at, last_used_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, input.name, input.path, isDefault, now, now);
    if (isDefault) this.setDefaultWorkspace(id);
    return this.getWorkspace(id) as WorkspaceRow;
  }

  getWorkspace(id: string): WorkspaceRow | undefined {
    return this.db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(id) as unknown as WorkspaceRow | undefined;
  }

  getWorkspaceByPath(realPath: string): WorkspaceRow | undefined {
    return this.db.prepare(`SELECT * FROM workspaces WHERE path = ?`).get(realPath) as unknown as WorkspaceRow | undefined;
  }

  listWorkspaces(): WorkspaceRow[] {
    return this.db
      .prepare(`SELECT * FROM workspaces ORDER BY is_default DESC, last_used_at DESC`)
      .all() as unknown as WorkspaceRow[];
  }

  getDefaultWorkspace(): WorkspaceRow | undefined {
    return this.db
      .prepare(`SELECT * FROM workspaces WHERE is_default = 1 AND enabled = 1 LIMIT 1`)
      .get() as unknown as WorkspaceRow | undefined;
  }

  setDefaultWorkspace(id: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE workspaces SET is_default = 0`).run();
      this.db.prepare(`UPDATE workspaces SET is_default = 1 WHERE id = ?`).run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  updateWorkspace(id: string, update: { name?: string; enabled?: boolean }): void {
    const current = this.getWorkspace(id);
    if (!current) return;
    if (update.name !== undefined) {
      this.db.prepare(`UPDATE workspaces SET name = ? WHERE id = ?`).run(update.name, id);
    }
    if (update.enabled !== undefined) {
      this.db.prepare(`UPDATE workspaces SET enabled = ? WHERE id = ?`).run(update.enabled ? 1 : 0, id);
      if (!update.enabled && current.is_default === 1) {
        const next = this.listWorkspaces().find((w) => w.id !== id && w.enabled === 1);
        if (next) this.setDefaultWorkspace(next.id);
      }
    }
  }

  touchWorkspace(id: string): void {
    this.db.prepare(`UPDATE workspaces SET last_used_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  deleteWorkspace(id: string): void {
    this.disableScheduledTasksForWorkspace(id, 'workspace_deleted');
    this.db.prepare(`DELETE FROM workspace_dirs WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM workspace_shortcut_dirs WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
  }

  // ---- workspace dirs (额外允许 agent 访问的目录, 工作区级) ----

  listWorkspaceDirs(workspaceId: string): string[] {
    const rows = this.db
      .prepare(`SELECT path FROM workspace_dirs WHERE workspace_id = ? ORDER BY created_at ASC, path ASC`)
      .all(workspaceId) as unknown as { path: string }[];
    return rows.map((r) => r.path);
  }

  /** All workspaces' extra dirs in one query, so the list endpoint avoids N+1. */
  listAllWorkspaceDirs(): Map<string, string[]> {
    const rows = this.db
      .prepare(`SELECT workspace_id, path FROM workspace_dirs ORDER BY created_at ASC, path ASC`)
      .all() as unknown as { workspace_id: string; path: string }[];
    const byWorkspace = new Map<string, string[]>();
    for (const row of rows) {
      const list = byWorkspace.get(row.workspace_id);
      if (list) list.push(row.path);
      else byWorkspace.set(row.workspace_id, [row.path]);
    }
    return byWorkspace;
  }

  addWorkspaceDir(workspaceId: string, dir: string): void {
    this.db
      .prepare(
        `INSERT INTO workspace_dirs (workspace_id, path, created_at) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id, path) DO NOTHING`,
      )
      .run(workspaceId, dir, Date.now());
    // 授权之后，指向同一目录的浏览书签就多余了（tab 行上会重复出现两次）。
    // 反向（给已有的授权目录加书签）由路由拒掉；这里管的是「先有书签、后授权」。
    this.db.prepare(`DELETE FROM workspace_shortcut_dirs WHERE workspace_id = ? AND path = ?`).run(workspaceId, dir);
  }

  removeWorkspaceDir(workspaceId: string, dir: string): void {
    this.db.prepare(`DELETE FROM workspace_dirs WHERE workspace_id = ? AND path = ?`).run(workspaceId, dir);
  }

  // ---- workspace shortcut dirs (文件 Tab 的浏览书签, 不授权) ----

  listWorkspaceShortcuts(workspaceId: string): string[] {
    const rows = this.db
      .prepare(`SELECT path FROM workspace_shortcut_dirs WHERE workspace_id = ? ORDER BY created_at ASC, path ASC`)
      .all(workspaceId) as unknown as { path: string }[];
    return rows.map((r) => r.path);
  }

  /** All workspaces' shortcuts in one query, so the list endpoint avoids N+1. */
  listAllWorkspaceShortcuts(): Map<string, string[]> {
    const rows = this.db
      .prepare(`SELECT workspace_id, path FROM workspace_shortcut_dirs ORDER BY created_at ASC, path ASC`)
      .all() as unknown as { workspace_id: string; path: string }[];
    const byWorkspace = new Map<string, string[]>();
    for (const row of rows) {
      const list = byWorkspace.get(row.workspace_id);
      if (list) list.push(row.path);
      else byWorkspace.set(row.workspace_id, [row.path]);
    }
    return byWorkspace;
  }

  addWorkspaceShortcut(workspaceId: string, dir: string): void {
    this.db
      .prepare(
        `INSERT INTO workspace_shortcut_dirs (workspace_id, path, created_at) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id, path) DO NOTHING`,
      )
      .run(workspaceId, dir, Date.now());
  }

  removeWorkspaceShortcut(workspaceId: string, dir: string): void {
    this.db.prepare(`DELETE FROM workspace_shortcut_dirs WHERE workspace_id = ? AND path = ?`).run(workspaceId, dir);
  }

  countSessionsByWorkspace(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT workspace_id, COUNT(*) AS count FROM sessions
         WHERE workspace_id IS NOT NULL AND kind = 'chat' GROUP BY workspace_id`,
      )
      .all() as unknown as { workspace_id: string; count: number }[];
    return new Map(rows.map((r) => [r.workspace_id, Number(r.count)]));
  }

  /** Scheduled-task counts per bound session, for the session list's task group. */
  countScheduledTasksBySession(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT session_id, COUNT(*) AS count FROM scheduled_tasks
         WHERE session_id IS NOT NULL GROUP BY session_id`,
      )
      .all() as unknown as { session_id: string; count: number }[];
    return new Map(rows.map((row) => [row.session_id, Number(row.count)]));
  }

  countScheduledTasksForSession(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM scheduled_tasks WHERE session_id = ?`)
      .get(sessionId) as unknown as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  // ---- session permission grants ----

  listPermissionGrants(sessionId: string): PermissionGrantRow[] {
    return this.db
      .prepare(`SELECT * FROM session_permission_grants WHERE session_id = ? ORDER BY tool_name ASC`)
      .all(sessionId) as unknown as PermissionGrantRow[];
  }

  hasPermissionGrant(sessionId: string, toolName: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM session_permission_grants WHERE session_id = ? AND tool_name = ? LIMIT 1`)
      .get(sessionId, toolName) as unknown as { ok: number } | undefined;
    return row !== undefined;
  }

  addPermissionGrant(sessionId: string, toolName: string): void {
    this.db
      .prepare(
        `INSERT INTO session_permission_grants (session_id, tool_name, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id, tool_name) DO NOTHING`,
      )
      .run(sessionId, toolName, Date.now());
  }

  deletePermissionGrant(sessionId: string, toolName: string): void {
    this.db
      .prepare(`DELETE FROM session_permission_grants WHERE session_id = ? AND tool_name = ?`)
      .run(sessionId, toolName);
  }

  deletePermissionGrants(sessionId: string): void {
    this.db.prepare(`DELETE FROM session_permission_grants WHERE session_id = ?`).run(sessionId);
  }

  // ---- settings ----

  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as unknown as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  listSettings(): SettingRow[] {
    return this.db.prepare(`SELECT * FROM settings ORDER BY key ASC`).all() as unknown as SettingRow[];
  }

  // ---- messages ----

  addMessage(sessionId: string, role: 'user' | 'assistant', content: string): void {
    // Guard against a run that finishes after its session was deleted.
    if (!this.getSession(sessionId)) return;
    this.db
      .prepare(`INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`)
      .run(sessionId, role, content, Date.now());
  }

  listMessages(sessionId: string): MessageRow[] {
    return this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC`)
      .all(sessionId) as unknown as MessageRow[];
  }

  // ---- runs ----

  createRun(input: {
    id: string;
    sessionId: string;
    runtime: string;
    model: string | null;
    modelParameters?: Record<string, string> | null;
    prompt: string;
    status: string;
    commandId?: string | null;
    taskId?: string | null;
    trigger?: 'user' | 'scheduled' | 'run_now';
    permissionMode?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, runtime, model, model_parameters, status, prompt, started_at, ended_at, exit_code, error, command_id, task_id, trigger, permission_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.runtime,
        input.model,
        serializeModelParameters(input.modelParameters ?? null),
        input.status,
        input.prompt,
        Date.now(),
        input.commandId ?? null,
        input.taskId ?? null,
        input.trigger ?? 'user',
        input.permissionMode ?? null,
      );
  }

  updateRun(
    id: string,
    update: { status?: string; endedAt?: number | null; exitCode?: number | null; error?: string | null },
  ): void {
    const current = this.getRun(id);
    if (!current) return;
    this.db
      .prepare(`UPDATE runs SET status = ?, ended_at = ?, exit_code = ?, error = ? WHERE id = ?`)
      .run(
        update.status ?? current.status,
        update.endedAt !== undefined ? update.endedAt : current.ended_at,
        update.exitCode !== undefined ? update.exitCode : current.exit_code,
        update.error !== undefined ? update.error : current.error,
        id,
      );
  }

  getRun(id: string): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as unknown as RunRow | undefined;
  }

  /** The run a client command id already started, if any (see `createRun`). */
  getRunByCommandId(commandId: string): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE command_id = ?`).get(commandId) as unknown as RunRow | undefined;
  }

  /**
   * Mark every run still `running` as `interrupted`, and append a terminal
   * `status` frame to each so its persisted stream stays well-formed for a
   * reconnect. Called once at boot: the in-memory active-run registry starts
   * empty, so a run the DB still calls `running` has no process behind it (the
   * daemon died mid-run) and would otherwise read as "running" forever.
   * Returns how many runs were repaired.
   */
  interruptOrphanedRuns(reason: string): number {
    const rows = this.db
      .prepare(`SELECT id FROM runs WHERE status = 'running'`)
      .all() as unknown as Array<{ id: string }>;
    if (rows.length === 0) return 0;

    const now = Date.now();
    const mark = this.db.prepare(
      `UPDATE runs SET status = 'interrupted', ended_at = ?, error = ? WHERE id = ?`,
    );
    const nextSeq = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE run_id = ?`);
    for (const row of rows) {
      mark.run(now, reason, row.id);
      const seq = (nextSeq.get(row.id) as unknown as { seq: number }).seq;
      this.appendEvent(row.id, seq, 'status', { type: 'status', label: 'interrupted', terminal: true });
    }
    return rows.length;
  }

  /** Includes checkpoint preparation and finalization, not just live processes. */
  listRunningRuns(): RunRow[] {
    return this.db.prepare(`SELECT * FROM runs WHERE status = 'running'`).all() as unknown as RunRow[];
  }

  listRuns(sessionId: string): RunRow[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE session_id = ? ORDER BY started_at ASC`)
      .all(sessionId) as unknown as RunRow[];
  }

  /** Newest first, for a scheduled task's history panel. */
  listRunsByTask(taskId: string, limit = 20): RunRow[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`)
      .all(taskId, limit) as unknown as RunRow[];
  }

  // ---- run checkpoints ----

  upsertRunCheckpoint(input: {
    runId: string;
    repoRoot: string;
    preRef: string | null;
    postRef: string | null;
    status: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO run_checkpoints (run_id, repo_root, pre_ref, post_ref, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           repo_root = excluded.repo_root,
           pre_ref = excluded.pre_ref,
           post_ref = excluded.post_ref,
           status = excluded.status`,
      )
      .run(input.runId, input.repoRoot, input.preRef, input.postRef, input.status, Date.now());
  }

  getRunCheckpoint(runId: string): RunCheckpointRow | undefined {
    return this.db.prepare(`SELECT * FROM run_checkpoints WHERE run_id = ?`).get(runId) as unknown as
      | RunCheckpointRow
      | undefined;
  }

  markRunCheckpointRolledBack(runId: string): void {
    this.db.prepare(`UPDATE run_checkpoints SET status = 'rolled_back' WHERE run_id = ?`).run(runId);
  }

  /**
   * Mark a run and every run that started at or after it as `rolled_back`, for
   * the session that owns them. Runs are ordered by `started_at` (see
   * `listRuns`), so that is the boundary. Returns how many rows changed.
   */
  markRunsRolledBack(sessionId: string, fromStartedAt: number): number {
    const result = this.db
      .prepare(`UPDATE runs SET status = 'rolled_back' WHERE session_id = ? AND started_at >= ?`)
      .run(sessionId, fromStartedAt);
    return Number(result.changes);
  }

  // ---- events ----

  appendEvent(runId: string, seq: number, type: string, payload: unknown): void {
    this.db
      .prepare(`INSERT INTO events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(runId, seq, type, JSON.stringify(payload), Date.now());
  }

  listEvents(runId: string, afterSeq = 0): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC`)
      .all(runId, afterSeq) as unknown as EventRow[];
  }

  /**
   * Events a client should replay: everything except legacy `thinking_delta`
   * rows. The filter must stay in SQL — a long run can hold >100k thinking
   * deltas, and loading them into Node just to discard them is what this exists
   * to avoid.
   */
  listReplayEvents(runId: string, afterSeq = 0): EventRow[] {
    return this.db
      .prepare(
        `SELECT id, run_id, seq, type, payload, created_at FROM events
         WHERE run_id = ? AND seq > ? AND type != 'thinking_delta'
         ORDER BY seq ASC`,
      )
      .all(runId, afterSeq) as unknown as EventRow[];
  }

  /** 把 permission_request 事件的最终审批状态写回 payload，供重连回放判定是否还 pending。 */
  updateEventPermissionStatus(permissionId: string, status: string): void {
    this.db
      .prepare(
        `UPDATE events SET payload = json_set(payload, '$.status', ?)
         WHERE type = 'permission_request' AND json_extract(payload, '$.permissionId') = ?`,
      )
      .run(status, permissionId);
  }

  // ---- deploy jobs ----

  createDeployJob(input: {
    id: string;
    channel: string;
    target: string;
    unit: string;
    logPath: string;
  }): DeployJobRow {
    this.db
      .prepare(
        `INSERT INTO deploy_jobs (id, channel, target, status, unit, log_path, created_at, started_at, finished_at, exit_code, error)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .run(input.id, input.channel, input.target, input.unit, input.logPath, Date.now());
    return this.getDeployJob(input.id) as DeployJobRow;
  }

  getDeployJob(id: string): DeployJobRow | undefined {
    return this.db.prepare(`SELECT * FROM deploy_jobs WHERE id = ?`).get(id) as unknown as DeployJobRow | undefined;
  }

  getActiveDeployJob(): DeployJobRow | undefined {
    return this.db
      .prepare(`SELECT * FROM deploy_jobs WHERE status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`)
      .get() as unknown as DeployJobRow | undefined;
  }

  listDeployJobs(limit = 20): DeployJobRow[] {
    return this.db
      .prepare(`SELECT * FROM deploy_jobs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as unknown as DeployJobRow[];
  }

  updateDeployJob(
    id: string,
    update: {
      status?: string;
      startedAt?: number | null;
      finishedAt?: number | null;
      exitCode?: number | null;
      error?: string | null;
    },
  ): void {
    const current = this.getDeployJob(id);
    if (!current) return;
    this.db
      .prepare(
        `UPDATE deploy_jobs
         SET status = ?, started_at = ?, finished_at = ?, exit_code = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        update.status ?? current.status,
        update.startedAt !== undefined ? update.startedAt : current.started_at,
        update.finishedAt !== undefined ? update.finishedAt : current.finished_at,
        update.exitCode !== undefined ? update.exitCode : current.exit_code,
        update.error !== undefined ? update.error : current.error,
        id,
      );
  }

  // ---- scheduled tasks ----

  createScheduledTask(input: {
    id: string;
    name: string;
    taskType: string;
    sessionMode: string;
    sessionId?: string | null;
    workspaceId: string;
    runtime: string;
    model?: string | null;
    modelParameters?: Record<string, string> | null;
    prompt?: string | null;
    command?: string | null;
    permissionMode?: string;
    cronExpr: string;
    timezone: string;
    schedulePreset?: string | null;
    nextRunAt?: number | null;
    enabled?: boolean;
    createdBy: string;
  }): ScheduledTaskRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO scheduled_tasks
           (id, name, task_type, session_mode, session_id, workspace_id, runtime, model, model_parameters,
            prompt, command, permission_mode, cron_expr, timezone, schedule_preset, next_run_at, enabled,
            created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.taskType,
        input.sessionMode,
        input.sessionId ?? null,
        input.workspaceId,
        input.runtime,
        input.model ?? null,
        serializeModelParameters(input.modelParameters ?? null),
        input.prompt ?? null,
        input.command ?? null,
        input.permissionMode ?? 'bypass',
        input.cronExpr,
        input.timezone,
        input.schedulePreset ?? null,
        input.nextRunAt ?? null,
        input.enabled === false ? 0 : 1,
        input.createdBy,
        now,
        now,
      );
    return this.getScheduledTask(input.id) as ScheduledTaskRow;
  }

  getScheduledTask(id: string): ScheduledTaskRow | undefined {
    return this.db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as unknown as
      | ScheduledTaskRow
      | undefined;
  }

  listScheduledTasks(filter: { workspaceId?: string; sessionId?: string; enabledOnly?: boolean } = {}): ScheduledTaskRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.workspaceId) {
      where.push('workspace_id = ?');
      args.push(filter.workspaceId);
    }
    if (filter.sessionId) {
      where.push('session_id = ?');
      args.push(filter.sessionId);
    }
    if (filter.enabledOnly) where.push('enabled = 1');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM scheduled_tasks ${clause} ORDER BY created_at DESC`)
      .all(...args) as unknown as ScheduledTaskRow[];
  }

  listDueScheduledTasks(now: number): ScheduledTaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM scheduled_tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(now) as unknown as ScheduledTaskRow[];
  }

  updateScheduledTask(
    id: string,
    update: {
      name?: string;
      prompt?: string | null;
      command?: string | null;
      cronExpr?: string;
      timezone?: string;
      schedulePreset?: string | null;
      nextRunAt?: number | null;
      enabled?: boolean;
      disabledReason?: string | null;
      lastStatus?: string;
      lastError?: string | null;
      lastFireAt?: number | null;
      lastRunAt?: number | null;
      lastRunId?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (update.name !== undefined) set('name', update.name);
    if (update.prompt !== undefined) set('prompt', update.prompt);
    if (update.command !== undefined) set('command', update.command);
    if (update.cronExpr !== undefined) set('cron_expr', update.cronExpr);
    if (update.timezone !== undefined) set('timezone', update.timezone);
    if (update.schedulePreset !== undefined) set('schedule_preset', update.schedulePreset);
    if (update.nextRunAt !== undefined) set('next_run_at', update.nextRunAt);
    if (update.enabled !== undefined) {
      set('enabled', update.enabled ? 1 : 0);
      if (!update.enabled) set('next_run_at', null);
      else set('disabled_reason', null);
    }
    if (update.disabledReason !== undefined) set('disabled_reason', update.disabledReason);
    if (update.lastStatus !== undefined) set('last_status', update.lastStatus);
    if (update.lastError !== undefined) set('last_error', update.lastError);
    if (update.lastFireAt !== undefined) set('last_fire_at', update.lastFireAt);
    if (update.lastRunAt !== undefined) set('last_run_at', update.lastRunAt);
    if (update.lastRunId !== undefined) set('last_run_id', update.lastRunId);
    if (sets.length === 0) return;
    set('updated_at', Date.now());
    values.push(id);
    this.db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * Compare-and-swap the scheduled slot. Returns false when another tick (or a
   * manual edit) already advanced it, which keeps a fire at-most-once.
   */
  advanceScheduledTask(
    id: string,
    expectedNextRunAt: number | null,
    input: { nextRunAt: number; lastFireAt?: number | null; lastStatus?: string; lastError?: string | null },
  ): boolean {
    const now = Date.now();
    const result =
      expectedNextRunAt === null
        ? this.db
            .prepare(
              `UPDATE scheduled_tasks
               SET next_run_at = ?, last_fire_at = ?, last_status = ?, last_error = ?, updated_at = ?
               WHERE id = ? AND next_run_at IS NULL AND enabled = 1`,
            )
            .run(input.nextRunAt, input.lastFireAt ?? now, input.lastStatus ?? 'running', input.lastError ?? null, now, id)
        : this.db
            .prepare(
              `UPDATE scheduled_tasks
               SET next_run_at = ?, last_fire_at = ?, last_status = ?, last_error = ?, updated_at = ?
               WHERE id = ? AND next_run_at = ? AND enabled = 1`,
            )
            .run(
              input.nextRunAt,
              input.lastFireAt ?? now,
              input.lastStatus ?? 'running',
              input.lastError ?? null,
              now,
              id,
              expectedNextRunAt,
            );
    return Number(result.changes) > 0;
  }

  /** Bind a lazily-created session; only the first writer wins. */
  setScheduledTaskSession(id: string, sessionId: string): boolean {
    const result = this.db
      .prepare(`UPDATE scheduled_tasks SET session_id = ?, updated_at = ? WHERE id = ? AND session_id IS NULL`)
      .run(sessionId, Date.now(), id);
    return Number(result.changes) > 0;
  }

  markScheduledTaskRunning(id: string, runId: string): void {
    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET last_run_id = ?, last_status = 'running', run_count = run_count + 1,
             last_fire_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(runId, Date.now(), Date.now(), id);
  }

  recordScheduledTaskResult(id: string, status: string, error: string | null, at = Date.now()): void {
    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET last_status = ?, last_error = ?, last_run_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, error, at, Date.now(), id);
  }

  disableScheduledTask(id: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET enabled = 0, disabled_reason = ?, next_run_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(reason, Date.now(), id);
  }

  deleteScheduledTasksForSession(sessionId: string): void {
    this.db.prepare(`DELETE FROM scheduled_tasks WHERE session_id = ?`).run(sessionId);
  }

  /**
   * Remove tasks whose bound session no longer exists. Covers rows left behind
   * by older daemons (which disabled instead of deleting) and any manual DB
   * edits. Tasks with no session yet (first fire pending) are kept.
   */
  deleteOrphanedScheduledTasks(): number {
    const result = this.db
      .prepare(
        `DELETE FROM scheduled_tasks
         WHERE session_id IS NOT NULL
           AND session_id NOT IN (SELECT id FROM sessions)`,
      )
      .run();
    return Number(result.changes);
  }

  disableScheduledTasksForWorkspace(workspaceId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET enabled = 0, disabled_reason = ?, next_run_at = NULL, updated_at = ?
         WHERE workspace_id = ?`,
      )
      .run(reason, Date.now(), workspaceId);
  }

  deleteScheduledTask(id: string): void {
    this.db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id);
  }

  // ---- audit ----

  audit(action: string, detail?: string): void {
    this.db
      .prepare(`INSERT INTO audit_log (user_id, action, detail, created_at) VALUES (?, ?, ?, ?)`)
      .run(null, action, detail ?? null, Date.now());
  }
}
