import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorkspaceSource } from '../app/config.js';
import type { AttachmentRow, CreateAttachmentInput } from '../types/attachments.js';
import type {
  AppendNativeCompactionInput,
  AppendNativeMessageInput,
  CreateNativeThreadInput,
  NativeCompaction,
  NativeMessage,
  NativeThread,
  NativeMessageSource,
  TranscriptContentBlock,
} from '../types/transcript.js';
import { serializeModelParameters } from './model-selection.js';

/** Setting key: the `env` / `cwd` startup workspace has already been seeded once. */
const SEEDED_WORKSPACE_KEY = 'workspace_seeded';

const NATIVE_MESSAGE_COLUMNS = `
  id, thread_id AS threadId, seq, role, blocks, source, source_kind AS sourceKind,
  source_key AS sourceKey, run_id AS runId, step, provider, model, usage,
  format_version AS formatVersion, created_at AS createdAt`;

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
  /** Primary end; P0 only adds the column, so it stays NULL until S1/S2. */
  end_id: string | null;
  /** `normal` | `no_injection` | `off`; capture/injection policy. */
  memory_mode: string;
  /**
   * Messages at or below this id are before the current capture window. Set
   * when a session transitions out of `off`, so disabled-period messages are
   * never retroactively captured.
   */
  memory_capture_after_message_id: number;
  created_at: number;
  last_active_at: number;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  path: string;
  is_default: number;
  /**
   * The built-in fallback (`<dataDir>/defaultworkspace`), not a user choice.
   * It is shown only while it is the only enabled workspace; once a real one
   * exists it is hidden and must not hold the default flag.
   */
  is_builtin: number;
  enabled: number;
  /** `dev` | `life`; ends must match it (DB trigger in `ends`). */
  family: string;
  /** `off` | `portable` | `full`; only meaningful for life, ignored for dev. */
  profile_mode: string;
  /** dev only: whether life may read this workspace (default off). */
  life_readable: number;
  /** New-session defaults; `null` inherits the global default. */
  default_runtime: string | null;
  default_permission_mode: string | null;
  created_at: number;
  last_used_at: number;
}

/** 工作区里的端；P0 只落表与约束，端 CRUD 留到 S2/S3。 */
export interface EndRow {
  id: string;
  workspace_id: string;
  family: string;
  kind: string;
  name: string;
  /** draft | active | archived | deleted; the life end is always active. */
  status: string;
  created_at: number;
  archived_at: number | null;
  /** One-line description shown in the end index. */
  summary: string;
  /** Longer user notes; injected verbatim for the primary end. */
  notes: string;
}

export interface EndRootRow {
  end_id: string;
  path: string;
}

export interface CapabilityBindingRow {
  scope_type: 'workspace' | 'end' | 'session';
  scope_id: string;
  provider_id: string;
  enabled: number;
  config_json: string;
  updated_at: number;
}

export interface PermissionGrantRow {
  session_id: string;
  tool_name: string;
  created_at: number;
}

/** Per-workspace memory switches. Missing row = product defaults (life on, dev off). */
export interface MemorySettingsRow {
  workspace_id: string;
  enabled: number;
  injection_enabled: number;
  provider_override: string | null;
  updated_at: number;
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
  /** JSON array of AttachmentDto ids admitted with this run. */
  attachment_ids: string;
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

interface NativeMessageDbRow {
  id: number;
  threadId: string;
  seq: number;
  role: string;
  blocks: string;
  source: string;
  sourceKind: string;
  sourceKey: string | null;
  runId: string | null;
  step: number | null;
  provider: string | null;
  model: string | null;
  usage: string | null;
  formatVersion: number;
  createdAt: number;
}

function parseNativeMessageRow(row: NativeMessageDbRow): NativeMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as NativeMessage['role'],
    blocks: JSON.parse(row.blocks) as TranscriptContentBlock[],
    source: JSON.parse(row.source) as NativeMessageSource,
    runId: row.runId,
    step: row.step,
    provider: row.provider,
    model: row.model,
    usage: row.usage === null ? null : (JSON.parse(row.usage) as unknown),
    formatVersion: row.formatVersion,
    createdAt: row.createdAt,
  };
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
        attachment_ids TEXT NOT NULL DEFAULT '[]',
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
        is_builtin INTEGER NOT NULL DEFAULT 0,
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

      -- 端：family 必须与所属工作区一致；life 工作区只有一个 life 端。
      -- P0 先把约束落下，端 CRUD 与上下文注入在 S2/S3。
      CREATE TABLE IF NOT EXISTS ends (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        family TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL,
        archived_at INTEGER,
        UNIQUE (workspace_id, name)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_ends_one_life ON ends(workspace_id) WHERE family = 'life';
      CREATE TRIGGER IF NOT EXISTS ends_family_guard_ins
      BEFORE INSERT ON ends
      WHEN NEW.family IS NOT (SELECT family FROM workspaces WHERE id = NEW.workspace_id)
      BEGIN SELECT RAISE(ABORT, 'end family mismatch'); END;
      CREATE TRIGGER IF NOT EXISTS ends_family_guard_upd
      BEFORE UPDATE OF family, workspace_id ON ends
      WHEN NEW.family IS NOT (SELECT family FROM workspaces WHERE id = NEW.workspace_id)
      BEGIN SELECT RAISE(ABORT, 'end family mismatch'); END;

      CREATE TABLE IF NOT EXISTS end_roots (
        end_id TEXT NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (end_id, path)
      );

      -- 会话的端作用域；没有行 = 使用工作区全部 active 端。
      CREATE TABLE IF NOT EXISTS session_ends (
        session_id TEXT NOT NULL,
        end_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'active' CHECK (role IN ('active', 'reference')),
        added_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, end_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_ends_end ON session_ends(end_id);

      -- 记忆开关按 workspace 一行；端没有独立开关（end 只是标签）。
      CREATE TABLE IF NOT EXISTS memory_settings (
        workspace_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        injection_enabled INTEGER NOT NULL DEFAULT 1,
        provider_override TEXT,
        updated_at INTEGER NOT NULL
      );

      -- 能力绑定：provider 在 workspace / end / session 上的启用与配置；
      -- 解析时最近作用域优先（session > end > workspace）。
      CREATE TABLE IF NOT EXISTS capability_bindings (
        scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace', 'end', 'session')),
        scope_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_type, scope_id, provider_id)
      );
      CREATE INDEX IF NOT EXISTS idx_capability_bindings_scope
        ON capability_bindings(scope_type, scope_id);

      -- 提醒 / 删除 outbox（M1/M3 使用；P0 只建表，主库仍是唯一通知链路）。
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        end_id TEXT,
        loop_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        due_at INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        dedup_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        acked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
        ON notification_outbox (status, due_at);
      CREATE TABLE IF NOT EXISTS deletion_outbox (
        workspace_id TEXT PRIMARY KEY,
        requested_at INTEGER NOT NULL,
        acked_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS session_permission_grants (
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, tool_name)
      );

      -- Builtin runtime transcript. One thread per agent run lineage; P3 uses
      -- one fixed builtin thread per session, while group chat/subagents can add
      -- sibling or child threads without changing this schema.
      CREATE TABLE IF NOT EXISTS native_threads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        parent_thread_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_native_threads_session
        ON native_threads (session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_native_threads_parent
        ON native_threads (parent_thread_id);

      CREATE TABLE IF NOT EXISTS native_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        blocks TEXT NOT NULL,
        source TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_key TEXT,
        run_id TEXT,
        step INTEGER,
        provider TEXT,
        model TEXT,
        usage TEXT,
        format_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        UNIQUE (thread_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_native_messages_thread_seq
        ON native_messages (thread_id, seq);
      CREATE INDEX IF NOT EXISTS idx_native_messages_context
        ON native_messages (thread_id, source_kind, seq DESC);

      CREATE TABLE IF NOT EXISTS native_compactions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        prev_id TEXT,
        summary TEXT NOT NULL,
        through_seq INTEGER NOT NULL,
        tokens_before INTEGER,
        tokens_after INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (thread_id, through_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_native_compactions_thread
        ON native_compactions (thread_id, through_seq DESC);

      -- Immutable image bytes live under <dataDir>/attachments; SQLite stores
      -- metadata and ownership refs only. session_id/run_id stay nullable until
      -- the first chat message binds the attachment.
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        session_id TEXT,
        workspace_id TEXT,
        run_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_session
        ON attachments (session_id, created_at);

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
    this.ensureColumn('runs', 'attachment_ids', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('workspaces', 'is_builtin', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('workspaces', 'family', "TEXT NOT NULL DEFAULT 'dev'");
    this.ensureColumn('workspaces', 'profile_mode', "TEXT NOT NULL DEFAULT 'portable'");
    this.ensureColumn('workspaces', 'life_readable', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('workspaces', 'default_runtime', 'TEXT');
    this.ensureColumn('workspaces', 'default_permission_mode', 'TEXT');
    this.ensureColumn('sessions', 'end_id', 'TEXT');
    this.ensureColumn('ends', 'summary', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('ends', 'notes', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('sessions', 'memory_mode', "TEXT NOT NULL DEFAULT 'normal'");
    this.ensureColumn('sessions', 'memory_capture_after_message_id', 'INTEGER NOT NULL DEFAULT 0');
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

  /** `normal` | `no_injection` | `off`; the capture pipeline reads this. */
  setSessionMemoryMode(id: string, mode: 'normal' | 'no_injection' | 'off'): void {
    this.db.prepare(`UPDATE sessions SET memory_mode = ? WHERE id = ?`).run(mode, id);
  }

  /** Highest message id currently stored for a session (0 when empty). */
  maxMessageId(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE session_id = ?`)
      .get(sessionId) as { id: number } | undefined;
    return Number(row?.id ?? 0);
  }

  /** Exclude messages at/below this id from automatic memory capture. */
  setSessionMemoryCaptureAfterMessageId(id: string, messageId: number): void {
    this.db
      .prepare(`UPDATE sessions SET memory_capture_after_message_id = ? WHERE id = ?`)
      .run(Math.max(0, Math.trunc(messageId)), id);
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

  /** Forget a native id the runtime no longer recognizes; the next run starts fresh. */
  clearNativeSessionId(id: string): void {
    this.db.prepare(`UPDATE sessions SET native_session_id = NULL WHERE id = ?`).run(id);
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
    this.db
      .prepare(`DELETE FROM capability_bindings WHERE scope_type = 'session' AND scope_id = ?`)
      .run(id);
    this.db
      .prepare(
        `DELETE FROM native_compactions WHERE thread_id IN
           (SELECT id FROM native_threads WHERE session_id = ?)`,
      )
      .run(id);
    this.db
      .prepare(
        `DELETE FROM native_messages WHERE thread_id IN
           (SELECT id FROM native_threads WHERE session_id = ?)`,
      )
      .run(id);
    this.db.prepare(`DELETE FROM native_threads WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM session_ends WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  // ---- attachments ----

  createAttachment(input: CreateAttachmentInput): AttachmentRow {
    this.db
      .prepare(
        `INSERT INTO attachments
           (id, media_type, bytes, width, height, sha256, storage_path,
            session_id, workspace_id, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.mediaType,
        input.bytes,
        input.width,
        input.height,
        input.sha256,
        input.storagePath,
        input.sessionId ?? null,
        input.workspaceId ?? null,
        input.runId ?? null,
        Date.now(),
      );
    return this.getAttachment(input.id) as AttachmentRow;
  }

  getAttachment(id: string): AttachmentRow | undefined {
    return this.db
      .prepare(
        `SELECT id, media_type AS mediaType, bytes, width, height, sha256,
                storage_path AS storagePath, session_id AS sessionId,
                workspace_id AS workspaceId, run_id AS runId, created_at AS createdAt
         FROM attachments WHERE id = ?`,
      )
      .get(id) as unknown as AttachmentRow | undefined;
  }

  bindAttachment(id: string, input: {
    sessionId?: string | null;
    workspaceId?: string | null;
    runId?: string | null;
  }): AttachmentRow | undefined {
    const current = this.getAttachment(id);
    if (!current) return undefined;
    this.db
      .prepare(
        `UPDATE attachments SET session_id = ?, workspace_id = ?, run_id = ?
         WHERE id = ?`,
      )
      .run(
        input.sessionId !== undefined ? input.sessionId : current.sessionId,
        input.workspaceId !== undefined ? input.workspaceId : current.workspaceId,
        input.runId !== undefined ? input.runId : current.runId,
        id,
      );
    return this.getAttachment(id);
  }

  deleteAttachment(id: string): void {
    this.db.prepare(`DELETE FROM attachments WHERE id = ?`).run(id);
  }

  listAttachmentsForSession(sessionId: string): AttachmentRow[] {
    return this.db
      .prepare(
        `SELECT id, media_type AS mediaType, bytes, width, height, sha256,
                storage_path AS storagePath, session_id AS sessionId,
                workspace_id AS workspaceId, run_id AS runId, created_at AS createdAt
         FROM attachments WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(sessionId) as unknown as AttachmentRow[];
  }

  listAttachmentsForWorkspace(workspaceId: string): AttachmentRow[] {
    return this.db
      .prepare(
        `SELECT id, media_type AS mediaType, bytes, width, height, sha256,
                storage_path AS storagePath, session_id AS sessionId,
                workspace_id AS workspaceId, run_id AS runId, created_at AS createdAt
         FROM attachments WHERE workspace_id = ? ORDER BY created_at ASC`,
      )
      .all(workspaceId) as unknown as AttachmentRow[];
  }

  // ---- builtin transcript ----

  createNativeThread(input: CreateNativeThreadInput): NativeThread {
    const id = input.id ?? randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO native_threads (id, session_id, agent_id, parent_thread_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.sessionId, input.agentId, input.parentThreadId ?? null, createdAt);
    return this.getNativeThread(id) as NativeThread;
  }

  getNativeThread(id: string): NativeThread | undefined {
    return this.db
      .prepare(
        `SELECT id, session_id AS sessionId, agent_id AS agentId,
                parent_thread_id AS parentThreadId, created_at AS createdAt
         FROM native_threads WHERE id = ?`,
      )
      .get(id) as unknown as NativeThread | undefined;
  }

  getNativeThreadForSession(sessionId: string, agentId = 'builtin'): NativeThread | undefined {
    return this.db
      .prepare(
        `SELECT id, session_id AS sessionId, agent_id AS agentId,
                parent_thread_id AS parentThreadId, created_at AS createdAt
         FROM native_threads WHERE session_id = ? AND agent_id = ?
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(sessionId, agentId) as unknown as NativeThread | undefined;
  }

  listNativeThreads(sessionId: string): NativeThread[] {
    return this.db
      .prepare(
        `SELECT id, session_id AS sessionId, agent_id AS agentId,
                parent_thread_id AS parentThreadId, created_at AS createdAt
         FROM native_threads WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(sessionId) as unknown as NativeThread[];
  }

  deleteNativeThread(threadId: string): void {
    this.db.prepare(`DELETE FROM native_compactions WHERE thread_id = ?`).run(threadId);
    this.db.prepare(`DELETE FROM native_messages WHERE thread_id = ?`).run(threadId);
    this.db.prepare(`DELETE FROM native_threads WHERE id = ?`).run(threadId);
  }

  appendNativeMessage(input: AppendNativeMessageInput): NativeMessage {
    if (!this.getNativeThread(input.threadId)) {
      throw new Error(`native thread not found: ${input.threadId}`);
    }
    const sourceJson = JSON.stringify(input.source);
    const sourceKind = input.source.kind;
    const sourceKey = input.source.kind === 'runtime-context' ? input.source.sourceKey : null;
    const usageJson = input.usage === undefined ? null : JSON.stringify(input.usage);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const seq = (
        this.db
          .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM native_messages WHERE thread_id = ?`)
          .get(input.threadId) as unknown as { seq: number }
      ).seq;
      this.db
        .prepare(
          `INSERT INTO native_messages
             (thread_id, seq, role, blocks, source, source_kind, source_key, run_id, step,
              provider, model, usage, format_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.threadId,
          seq,
          input.role,
          JSON.stringify(input.blocks),
          sourceJson,
          sourceKind,
          sourceKey,
          input.runId ?? null,
          input.step ?? null,
          input.provider ?? null,
          input.model ?? null,
          usageJson,
          input.formatVersion ?? 1,
          Date.now(),
        );
      this.db.exec('COMMIT');
      return this.getNativeMessage(input.threadId, seq) as NativeMessage;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listNativeMessages(threadId: string, afterSeq = 0): NativeMessage[] {
    const rows = this.db
      .prepare(
        `SELECT ${NATIVE_MESSAGE_COLUMNS} FROM native_messages
         WHERE thread_id = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(threadId, afterSeq) as unknown as NativeMessageDbRow[];
    return rows.map(parseNativeMessageRow);
  }

  latestNativeContextMessage(threadId: string): NativeMessage | null {
    const row = this.db
      .prepare(
        `SELECT ${NATIVE_MESSAGE_COLUMNS} FROM native_messages
         WHERE thread_id = ? AND source_kind = 'runtime-context'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(threadId) as unknown as NativeMessageDbRow | undefined;
    return row ? parseNativeMessageRow(row) : null;
  }

  appendNativeCompaction(input: AppendNativeCompactionInput): NativeCompaction {
    if (!this.getNativeThread(input.threadId)) {
      throw new Error(`native thread not found: ${input.threadId}`);
    }
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO native_compactions
           (id, thread_id, prev_id, summary, through_seq, tokens_before, tokens_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        input.prevId ?? null,
        input.summary,
        input.throughSeq,
        input.tokensBefore ?? null,
        input.tokensAfter ?? null,
        Date.now(),
      );
    return this.getNativeCompaction(id) as NativeCompaction;
  }

  listNativeCompactions(threadId: string): NativeCompaction[] {
    return this.db
      .prepare(
        `SELECT id, thread_id AS threadId, prev_id AS prevId, summary,
                through_seq AS throughSeq, tokens_before AS tokensBefore,
                tokens_after AS tokensAfter, created_at AS createdAt
         FROM native_compactions WHERE thread_id = ? ORDER BY through_seq ASC`,
      )
      .all(threadId) as unknown as NativeCompaction[];
  }

  private getNativeMessage(threadId: string, seq: number): NativeMessage | undefined {
    const row = this.db
      .prepare(
        `SELECT ${NATIVE_MESSAGE_COLUMNS} FROM native_messages
         WHERE thread_id = ? AND seq = ?`,
      )
      .get(threadId, seq) as unknown as NativeMessageDbRow | undefined;
    return row ? parseNativeMessageRow(row) : undefined;
  }

  private getNativeCompaction(id: string): NativeCompaction | undefined {
    return this.db
      .prepare(
        `SELECT id, thread_id AS threadId, prev_id AS prevId, summary,
                through_seq AS throughSeq, tokens_before AS tokensBefore,
                tokens_after AS tokensAfter, created_at AS createdAt
         FROM native_compactions WHERE id = ?`,
      )
      .get(id) as unknown as NativeCompaction | undefined;
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
   *
   * `builtinPath` marks the fallback root the desktop offers a first-time user.
   * It never takes the default flag away from a real workspace, and it is hidden
   * from clients once one exists (see {@link listVisibleWorkspaces}).
   */
  seedDefaultWorkspace(
    rawPath: string,
    defaultPermissionMode: string,
    source: WorkspaceSource = 'default',
    builtinPath?: string,
  ): WorkspaceRow | null {
    if (source === 'flag') {
      this.ensureWorkspaceDefault(rawPath, builtinPath);
    } else if (!this.getSetting(SEEDED_WORKSPACE_KEY)) {
      if (this.listWorkspaces().length === 0) {
        const realPath = fs.realpathSync(path.resolve(rawPath));
        this.createWorkspace({
          name: path.basename(realPath) || realPath,
          path: realPath,
          isDefault: true,
          isBuiltin: this.isBuiltinPath(realPath, builtinPath),
        });
      }
      this.setSetting(SEEDED_WORKSPACE_KEY, '1');
    }

    // Never make the builtin life workspace the dev default.
    const workspace =
      this.getDefaultWorkspace() ?? this.listWorkspaces().find((w) => w.family === 'dev') ?? null;
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
  private ensureWorkspaceDefault(rawPath: string, builtinPath?: string): void {
    const realPath = fs.realpathSync(path.resolve(rawPath));
    const isBuiltin = this.isBuiltinPath(realPath, builtinPath);
    const existing = this.getWorkspaceByPath(realPath);
    if (!existing) {
      this.createWorkspace({
        name: path.basename(realPath) || realPath,
        path: realPath,
        isDefault: isBuiltin ? !this.hasUserWorkspaces() : true,
        isBuiltin,
      });
      return;
    }
    if (existing.enabled !== 1) this.updateWorkspace(existing.id, { enabled: true });
    if (isBuiltin && existing.is_builtin !== 1) {
      this.db.prepare(`UPDATE workspaces SET is_builtin = 1 WHERE id = ?`).run(existing.id);
      existing.is_builtin = 1;
    }

    if (isBuiltin) {
      // The fallback may hold the default only while nothing real exists; if a
      // real workspace does, the desktop restarting with the fallback path must
      // not yank the default back to it.
      if (this.hasUserWorkspaces()) {
        if (existing.is_default === 1) {
          const user = this.listWorkspaces().find((w) => w.is_builtin !== 1 && w.enabled === 1);
          if (user) this.setDefaultWorkspace(user.id);
        }
      } else if (existing.is_default !== 1) {
        this.setDefaultWorkspace(existing.id);
      }
    } else if (existing.is_default !== 1) {
      this.setDefaultWorkspace(existing.id);
    }
  }

  /** Whether `realPath` is the fallback root for this data dir. */
  private isBuiltinPath(realPath: string, builtinPath?: string): boolean {
    if (!builtinPath) return false;
    const abs = path.resolve(builtinPath);
    let canonical = abs;
    try {
      canonical = fs.realpathSync(abs);
    } catch {
      // The fallback dir need not exist yet; compare what we were given.
    }
    return realPath === canonical;
  }

  /** A real (non-built-in) workspace the user can actually work in. */
  private hasUserWorkspaces(): boolean {
    return this.listWorkspaces().some((w) => w.family === 'dev' && w.is_builtin !== 1 && w.enabled === 1);
  }

  createWorkspace(input: {
    id?: string;
    name: string;
    path: string;
    isDefault?: boolean;
    isBuiltin?: boolean;
    family?: 'dev' | 'life';
    profileMode?: 'off' | 'portable' | 'full';
    lifeReadable?: boolean;
    defaultRuntime?: string | null;
    defaultPermissionMode?: string | null;
  }): WorkspaceRow {
    const now = Date.now();
    const id = input.id ?? randomUUID();
    const isDefault = input.isDefault ? 1 : 0;
    const isBuiltin = input.isBuiltin ? 1 : 0;
    const family = input.family ?? 'dev';
    if (family === 'life' && isDefault === 1) throw new Error('life workspace cannot be default');
    // D35: profile_mode defaults to portable and life writes it explicitly; dev ignores it.
    const profileMode = input.profileMode ?? 'portable';
    const lifeReadable = input.lifeReadable ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO workspaces
           (id, name, path, is_default, is_builtin, enabled, family, profile_mode, life_readable,
            default_runtime, default_permission_mode, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.path,
        isDefault,
        isBuiltin,
        family,
        profileMode,
        lifeReadable,
        input.defaultRuntime ?? null,
        input.defaultPermissionMode ?? null,
        now,
        now,
      );
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

  /**
   * What clients may see. The built-in fallback is a first-run scratch root,
   * not a workspace the user manages: once a real one is enabled it disappears
   * from the list (its sessions stay in the DB). While it is the only enabled
   * workspace it *is* the list — clients need an id to scope sessions and the
   * file browser.
   */
  listVisibleWorkspaces(): WorkspaceRow[] {
    const all = this.listWorkspaces();
    // family=life is a builtin the client must still render (as「生活」); only the
    // dev fallback disappears once a real dev workspace exists.
    const devUsers = all.filter((w) => w.family === 'dev' && w.is_builtin !== 1);
    if (!devUsers.some((w) => w.enabled === 1)) return all;
    return all.filter((w) => !(w.family === 'dev' && w.is_builtin === 1));
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

  updateWorkspace(
    id: string,
    update: {
      name?: string;
      enabled?: boolean;
      defaultRuntime?: string | null;
      defaultPermissionMode?: string | null;
    },
  ): void {
    const current = this.getWorkspace(id);
    if (!current) return;
    if (update.name !== undefined) {
      this.db.prepare(`UPDATE workspaces SET name = ? WHERE id = ?`).run(update.name, id);
    }
    if (update.defaultRuntime !== undefined) {
      this.db.prepare(`UPDATE workspaces SET default_runtime = ? WHERE id = ?`).run(update.defaultRuntime, id);
    }
    if (update.defaultPermissionMode !== undefined) {
      this.db
        .prepare(`UPDATE workspaces SET default_permission_mode = ? WHERE id = ?`)
        .run(update.defaultPermissionMode, id);
    }
    if (update.enabled !== undefined) {
      this.db.prepare(`UPDATE workspaces SET enabled = ? WHERE id = ?`).run(update.enabled ? 1 : 0, id);
      if (!update.enabled && current.is_default === 1) {
        const enabled = this.listWorkspaces().filter((w) => w.id !== id && w.enabled === 1);
        const next =
          enabled.find((w) => w.family === 'dev' && w.is_builtin !== 1) ??
          enabled.find((w) => w.family === 'dev') ??
          enabled[0];
        if (next) this.setDefaultWorkspace(next.id);
      }
    }
  }

  updateWorkspaceMemory(
    id: string,
    update: { profileMode?: 'off' | 'portable' | 'full'; lifeReadable?: boolean },
  ): void {
    if (!this.getWorkspace(id)) return;
    if (update.profileMode !== undefined) {
      this.db.prepare(`UPDATE workspaces SET profile_mode = ? WHERE id = ?`).run(update.profileMode, id);
    }
    if (update.lifeReadable !== undefined) {
      this.db
        .prepare(`UPDATE workspaces SET life_readable = ? WHERE id = ?`)
        .run(update.lifeReadable ? 1 : 0, id);
    }
  }

  getMemorySettings(workspaceId: string): MemorySettingsRow | undefined {
    return this.db
      .prepare(`SELECT * FROM memory_settings WHERE workspace_id = ?`)
      .get(workspaceId) as unknown as MemorySettingsRow | undefined;
  }

  /**
   * Persist the row with fully-resolved effective values. Callers must merge
   * product defaults first (life on, dev off) so writing only
   * `injection_enabled` cannot silently disable a life workspace.
   */
  putMemorySettings(
    workspaceId: string,
    input: { enabled: boolean; injectionEnabled: boolean; providerOverride: string | null },
  ): MemorySettingsRow {
    this.db
      .prepare(
        `INSERT INTO memory_settings (workspace_id, enabled, injection_enabled, provider_override, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           enabled = excluded.enabled,
           injection_enabled = excluded.injection_enabled,
           provider_override = excluded.provider_override,
           updated_at = excluded.updated_at`,
      )
      .run(
        workspaceId,
        input.enabled ? 1 : 0,
        input.injectionEnabled ? 1 : 0,
        input.providerOverride,
        Date.now(),
      );
    return this.getMemorySettings(workspaceId)!;
  }

  touchWorkspace(id: string): void {
    this.db.prepare(`UPDATE workspaces SET last_used_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  deleteWorkspace(id: string): void {
    this.disableScheduledTasksForWorkspace(id, 'workspace_deleted');
    this.db.prepare(`DELETE FROM workspace_dirs WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM workspace_shortcut_dirs WHERE workspace_id = ?`).run(id);
    // Ends are workspace-owned rows (no FK); clean them up with the workspace.
    this.db
      .prepare(
        `DELETE FROM capability_bindings
         WHERE scope_type = 'end' AND scope_id IN (SELECT id FROM ends WHERE workspace_id = ?)`,
      )
      .run(id);
    this.db
      .prepare(
        `DELETE FROM session_ends
         WHERE end_id IN (SELECT id FROM ends WHERE workspace_id = ?)
            OR session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)`,
      )
      .run(id, id);
    this.db
      .prepare(`DELETE FROM capability_bindings WHERE scope_type = 'workspace' AND scope_id = ?`)
      .run(id);
    this.db
      .prepare(`DELETE FROM end_roots WHERE end_id IN (SELECT id FROM ends WHERE workspace_id = ?)`)
      .run(id);
    this.db.prepare(`DELETE FROM ends WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM memory_settings WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
  }

  // ---- ends (P0: table + constraints; CRUD UI comes with S2/S3) ----

  createEnd(input: {
    id?: string;
    workspaceId: string;
    family: 'dev' | 'life';
    kind: string;
    name: string;
    status?: string;
  }): EndRow {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    // The family guard trigger raises on a mismatch, so a dev workspace cannot
    // hold a life end (and vice versa) even from a raw DB write.
    this.db
      .prepare(
        `INSERT INTO ends (id, workspace_id, family, kind, name, status, created_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, input.workspaceId, input.family, input.kind, input.name, input.status ?? 'draft', now);
    return this.getEnd(id) as EndRow;
  }

  getEnd(id: string): EndRow | undefined {
    return this.db.prepare(`SELECT * FROM ends WHERE id = ?`).get(id) as unknown as EndRow | undefined;
  }

  listEnds(workspaceId: string): EndRow[] {
    return this.db
      .prepare(`SELECT * FROM ends WHERE workspace_id = ? ORDER BY created_at ASC`)
      .all(workspaceId) as unknown as EndRow[];
  }

  /** Sessions belong to the workspace, not the end: deleting an end only clears
   * their main-end hint. Memory rows keep the historical end id as a label. */
  deleteEnd(id: string): boolean {
    this.db.prepare(`UPDATE sessions SET end_id = NULL WHERE end_id = ?`).run(id);
    this.db.prepare(`DELETE FROM session_ends WHERE end_id = ?`).run(id);
    this.db
      .prepare(`DELETE FROM capability_bindings WHERE scope_type = 'end' AND scope_id = ?`)
      .run(id);
    this.db.prepare(`DELETE FROM end_roots WHERE end_id = ?`).run(id);
    const result = this.db.prepare(`DELETE FROM ends WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  removeEndRoot(endId: string, path: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM end_roots WHERE end_id = ? AND path = ?`)
      .run(endId, path);
    return result.changes > 0;
  }

  updateEnd(
    id: string,
    input: { name?: string; summary?: string; notes?: string },
  ): EndRow | undefined {
    const current = this.getEnd(id);
    if (!current) return undefined;
    this.db
      .prepare(`UPDATE ends SET name = ?, summary = ?, notes = ? WHERE id = ?`)
      .run(
        input.name ?? current.name,
        input.summary ?? current.summary,
        input.notes ?? current.notes,
        id,
      );
    return this.getEnd(id);
  }

  // ---- session ends (multi-end sessions) ----

  listSessionEnds(sessionId: string): Array<{ end_id: string; role: string; added_at: number }> {
    return this.db
      .prepare(
        `SELECT end_id, role, added_at FROM session_ends WHERE session_id = ? ORDER BY added_at ASC`,
      )
      .all(sessionId) as unknown as Array<{ end_id: string; role: string; added_at: number }>;
  }

  /** Replace the session's narrowing list; empty = default (all workspace ends). */
  replaceSessionEnds(sessionId: string, endIds: readonly string[]): void {
    this.db.prepare(`DELETE FROM session_ends WHERE session_id = ?`).run(sessionId);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO session_ends (session_id, end_id, role, added_at) VALUES (?, ?, 'active', ?)`,
    );
    const now = Date.now();
    for (const endId of endIds) insert.run(sessionId, endId, now);
  }

  clearSessionEnds(sessionId: string): void {
    this.db.prepare(`DELETE FROM session_ends WHERE session_id = ?`).run(sessionId);
  }

  setEndStatus(id: string, status: string): EndRow | undefined {
    this.db
      .prepare(`UPDATE ends SET status = ?, archived_at = ? WHERE id = ?`)
      .run(status, status === 'archived' || status === 'deleted' ? Date.now() : null, id);
    return this.getEnd(id);
  }

  listEndRoots(endId: string): string[] {
    const rows = this.db
      .prepare(`SELECT path FROM end_roots WHERE end_id = ? ORDER BY path ASC`)
      .all(endId) as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  addEndRoot(endId: string, path: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO end_roots (end_id, path) VALUES (?, ?)`)
      .run(endId, path);
  }

  // ---- capability bindings (nearest scope wins) ----

  listCapabilityBindings(
    scopeType: CapabilityBindingRow['scope_type'],
    scopeId: string,
  ): CapabilityBindingRow[] {
    return this.db
      .prepare(
        `SELECT * FROM capability_bindings
         WHERE scope_type = ? AND scope_id = ? ORDER BY provider_id ASC`,
      )
      .all(scopeType, scopeId) as unknown as CapabilityBindingRow[];
  }

  upsertCapabilityBinding(input: {
    scopeType: CapabilityBindingRow['scope_type'];
    scopeId: string;
    providerId: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  }): CapabilityBindingRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO capability_bindings
           (scope_type, scope_id, provider_id, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_type, scope_id, provider_id)
         DO UPDATE SET enabled = excluded.enabled,
                       config_json = excluded.config_json,
                       updated_at = excluded.updated_at`,
      )
      .run(
        input.scopeType,
        input.scopeId,
        input.providerId,
        input.enabled === false ? 0 : 1,
        JSON.stringify(input.config ?? {}),
        now,
      );
    return this.db
      .prepare(
        `SELECT * FROM capability_bindings
         WHERE scope_type = ? AND scope_id = ? AND provider_id = ?`,
      )
      .get(input.scopeType, input.scopeId, input.providerId) as unknown as CapabilityBindingRow;
  }

  deleteCapabilityBinding(
    scopeType: CapabilityBindingRow['scope_type'],
    scopeId: string,
    providerId: string,
  ): void {
    this.db
      .prepare(
        `DELETE FROM capability_bindings
         WHERE scope_type = ? AND scope_id = ? AND provider_id = ?`,
      )
      .run(scopeType, scopeId, providerId);
  }

  /**
   * Register the built-in life workspace and its single `life` end.
   *
   * Called once at daemon start. It only creates what is missing, so old
   * databases need no migration and a second boot is a no-op. `is_builtin=1`
   * keeps it under the fallback rules, with the client-side exception that
   * family=life must be rendered as「生活」rather than hidden.
   */
  ensureLifeWorkspace(lifePath: string): { workspace: WorkspaceRow; end: EndRow } {
    fs.mkdirSync(lifePath, { recursive: true });
    const realPath = fs.realpathSync(path.resolve(lifePath));
    let workspace = this.db
      .prepare(`SELECT * FROM workspaces WHERE family = 'life' ORDER BY created_at ASC LIMIT 1`)
      .get() as unknown as WorkspaceRow | undefined;

    if (!workspace) {
      workspace = this.createWorkspace({
        name: '生活',
        path: realPath,
        isBuiltin: true,
        family: 'life',
        profileMode: 'portable',
      });
    } else if (workspace.is_builtin !== 1 || workspace.path !== realPath) {
      this.db
        .prepare(`UPDATE workspaces SET is_builtin = 1, path = ? WHERE id = ?`)
        .run(realPath, workspace.id);
      workspace = this.getWorkspace(workspace.id) as WorkspaceRow;
    }

    let end = this.db
      .prepare(`SELECT * FROM ends WHERE workspace_id = ? AND family = 'life' LIMIT 1`)
      .get(workspace.id) as unknown as EndRow | undefined;
    if (!end) {
      end = this.createEnd({
        workspaceId: workspace.id,
        family: 'life',
        kind: 'life',
        name: '生活',
        status: 'active',
      });
    } else if (end.status !== 'active') {
      this.db.prepare(`UPDATE ends SET status = 'active', archived_at = NULL WHERE id = ?`).run(end.id);
      end = this.getEnd(end.id) as EndRow;
    }
    return { workspace, end };
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

  countSessionsByEnd(endId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM sessions WHERE end_id = ?`)
      .get(endId) as unknown as { count: number } | undefined;
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

  deleteSetting(key: string): void {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
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
    attachmentIds?: string[];
    status: string;
    commandId?: string | null;
    taskId?: string | null;
    trigger?: 'user' | 'scheduled' | 'run_now';
    permissionMode?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, runtime, model, model_parameters, status, prompt, attachment_ids, started_at, ended_at, exit_code, error, command_id, task_id, trigger, permission_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.runtime,
        input.model,
        serializeModelParameters(input.modelParameters ?? null),
        input.status,
        input.prompt,
        JSON.stringify(input.attachmentIds ?? []),
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

  /** Tool events only (text deltas dominate long runs and are irrelevant here). */
  listToolEvents(runId: string): EventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM events WHERE run_id = ? AND type IN ('tool_use', 'tool_result')
         ORDER BY seq ASC`,
      )
      .all(runId) as unknown as EventRow[];
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
      sessionId?: string | null;
      sessionMode?: string;
      runtime?: string;
      model?: string | null;
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
    if (update.sessionId !== undefined) set('session_id', update.sessionId);
    if (update.sessionMode !== undefined) set('session_mode', update.sessionMode);
    if (update.runtime !== undefined) set('runtime', update.runtime);
    if (update.model !== undefined) set('model', update.model);
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
