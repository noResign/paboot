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

/** Setting key: the multi-agent shadow backfill has completed for this database. */
export const MULTI_AGENT_BACKFILL_KEY = 'multi_agent_backfill_v1';

/**
 * Implicit agents are keyed by (workspace, runtime) and given a deterministic
 * id so re-running the backfill is a no-op and P1 can address them without a
 * name lookup. They are the "there was only ever one agent" stand-in that P0
 * hangs existing sessions off.
 */
export function implicitAgentId(workspaceId: string, runtime: string): string {
  return `implicit:${workspaceId}:${runtime}`;
}

/** Minimal shape of an `agents` row. P1 grows the domain model on top of it. */
export interface AgentRow {
  id: string;
  workspace_id: string;
  name: string;
  summary: string;
  avatar: string | null;
  kind: 'builtin' | 'runtime' | 'peer';
  runtime: string | null;
  peer_id: string | null;
  remote_agent_id: string | null;
  model: string | null;
  model_parameters: string | null;
  instructions: string;
  cwd: string | null;
  extra_dirs: string | null;
  read_only: number;
  permission_ceiling: string;
  skills: string | null;
  budget_json: string | null;
  heavy: number;
  is_implicit: number;
  enabled: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface SessionAgentRow {
  session_id: string;
  agent_id: string;
  role: 'leader' | 'member';
  added_by: string | null;
  joined_at: number;
}

/** Where a task came from. `relay`/`summon` arrive with the room features. */
export type AgentTaskSource = 'mention' | 'leader_default' | 'summon' | 'reply' | 'steering' | 'summarize';

export interface TurnRow {
  id: string;
  session_id: string;
  prompt: string;
  /** running | done | failed */
  status: string;
  input_tokens: number;
  token_limit: number;
  created_at: number;
  ended_at: number | null;
  /** Client-supplied idempotency key; a retry with the same key reuses the turn. */
  command_id?: string | null;
  /** JSON array of image attachment ids shared by every task in this turn. */
  attachment_ids: string;
}

export interface AgentTaskRow {
  id: string;
  session_id: string;
  turn_id: string;
  agent_id: string;
  source: string;
  parent_task_id: string | null;
  prompt: string;
  /** queued | running | done | failed | cancelled */
  status: string;
  needs_write: number;
  blocked_kind: string | null;
  blocked_value: string | null;
  message_id: number | null;
  run_id: string | null;
  snapshot_seq: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  error: string | null;
}

export interface AgentThreadRow {
  id: string;
  session_id: string;
  agent_id: string;
  backend: string;
  native_session_id: string | null;
  native_thread_id: string | null;
  remote_thread_key: string | null;
  cwd: string;
  model_snapshot: string | null;
  agent_version: number;
  status: string;
  last_seen_seq: number;
  created_at: number;
  last_used_at: number;
}

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
  /** Built-in workspace row. Only the single `family=life` workspace uses this. */
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
  /** Who said it; NULL for the user, legacy rows, and single-agent daemons. */
  agent_id?: string | null;
  turn_id?: string | null;
  task_id?: string | null;
  /** Timeline position; NULL until the message is final. */
  committed_seq?: number | null;
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
  /** The agent that owned this run; NULL for legacy/scheduled runs. */
  agent_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
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
  /** Room-stream coordinates; NULL for frames that never reached a room. */
  session_id?: string | null;
  room_seq?: number | null;
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

      -- ───────────────────────────────────────────────────────────────
      -- Multi-agent shadow tables (P0).
      --
      -- These are "shadow" in the DB-migration sense: they are populated
      -- (seeded + backfilled + dual-written) but nothing in the request path
      -- reads them yet, so a bug here can never break a user. They exist to
      -- settle the shape before P1 starts reading from them.
      --
      -- Shape notes live next to the code that fills them: see src/agents/.
      -- ───────────────────────────────────────────────────────────────

      -- Agent definitions are workspace-scoped and stateless: the same agent
      -- can sit in many rooms, each with its own agent_threads row.
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        avatar TEXT,
        kind TEXT NOT NULL,
        runtime TEXT,
        peer_id TEXT,
        remote_agent_id TEXT,
        model TEXT,
        model_parameters TEXT,
        instructions TEXT NOT NULL DEFAULT '',
        cwd TEXT,
        extra_dirs TEXT,
        read_only INTEGER NOT NULL DEFAULT 0,
        permission_ceiling TEXT NOT NULL DEFAULT 'ask',
        skills TEXT,
        budget_json TEXT,
        heavy INTEGER NOT NULL DEFAULT 0,
        is_implicit INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (workspace_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents (workspace_id, enabled);

      -- Room membership plus the leader flag. Exactly one leader per room.
      CREATE TABLE IF NOT EXISTS session_agents (
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        added_by TEXT,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_agents_agent ON session_agents (agent_id);

      -- Per (session, agent) context handle: the runtime's native session id or
      -- thread id, plus the snapshot point this thread was built from.
      CREATE TABLE IF NOT EXISTS agent_threads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        backend TEXT NOT NULL,
        native_session_id TEXT,
        native_thread_id TEXT,
        remote_thread_key TEXT,
        cwd TEXT NOT NULL,
        model_snapshot TEXT,
        agent_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle',
        last_seen_seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        UNIQUE (session_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_threads_agent ON agent_threads (agent_id);

      -- One user input = one batch. Tasks run concurrently inside it; the batch
      -- itself is not a barrier (03-room.md 4.2).
      CREATE TABLE IF NOT EXISTS session_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        token_limit INTEGER NOT NULL,
        attachment_ids TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_session_turns_session
        ON session_turns (session_id, created_at DESC);

      -- One agent's unit of work. committed_seq ordering lives on messages,
      -- not here: a task is visible only once its message is committed.
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source TEXT NOT NULL,
        parent_task_id TEXT,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        needs_write INTEGER NOT NULL DEFAULT 0,
        blocked_kind TEXT,
        blocked_value TEXT,
        message_id INTEGER,
        run_id TEXT,
        snapshot_seq INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_session
        ON agent_tasks (session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks (session_id, status);
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent ON agent_tasks (agent_id, status);
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_run ON agent_tasks (run_id);
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

    // ── Multi-agent shadow columns (P0) ───────────────────────────────
    // Same contract as the shadow tables above: written, never read by the
    // request path yet. `session_id`/`runtime` stay the source of truth until
    // P1 flips the read path over.
    this.ensureColumn('workspaces', 'default_agent_id', 'TEXT');
    this.ensureColumn('runs', 'agent_id', 'TEXT');
    this.ensureColumn('runs', 'thread_id', 'TEXT');
    this.ensureColumn('runs', 'turn_id', 'TEXT');
    this.ensureColumn('runs', 'parent_run_id', 'TEXT');
    // NULL = authored by the user; set once a message is attributed to an agent.
    this.ensureColumn('messages', 'agent_id', 'TEXT');
    this.ensureColumn('messages', 'turn_id', 'TEXT');
    this.ensureColumn('messages', 'task_id', 'TEXT');
    // Timeline position. NULL while streaming; assigned once at commit time so
    // the order users see can never be reshuffled by a late-finishing task.
    this.ensureColumn('messages', 'committed_seq', 'INTEGER');
    // Room-level multiplexed SSE: room_seq orders frames within one session.
    this.ensureColumn('events', 'session_id', 'TEXT');
    this.ensureColumn('events', 'room_seq', 'INTEGER');
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_events_room ON events (session_id, room_seq);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs (agent_id, started_at DESC);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_committed ON messages (session_id, committed_seq);`,
    );
    // A turn retry (dropped response, double Enter, flaky link) must not become
    // a second question. NULL is allowed for turns sent by older clients.
    this.ensureColumn('session_turns', 'command_id', 'TEXT');
    // Room turns share one attachment list across every task/run they start.
    this.ensureColumn('session_turns', 'attachment_ids', "TEXT NOT NULL DEFAULT '[]'");
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_turns_command ON session_turns (command_id);`,
    );

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
    // Shadow rows (P0): give a brand-new session its leader and thread right
    // away, so the shadow tables stay complete without waiting for a backfill
    // run. Nothing reads them yet.
    this.ensureShadowSessionRows(input.id);
    return this.getSession(input.id) as SessionRow;
  }

  /**
   * Create the (leader, thread) pair for a session if it is missing.
   *
   * Idempotent and failure-tolerant: P0's shadow tables must never fail a user
   * request, so anything unexpected here is swallowed.
   */
  private ensureShadowSessionRows(sessionId: string): void {
    try {
      const session = this.getSession(sessionId);
      if (!session) return;
      if (session.kind !== 'chat' && session.kind !== 'command') return;
      const workspaceId = session.workspace_id;
      if (!workspaceId || !this.getWorkspace(workspaceId)) return;
      const agent = this.ensureImplicitAgent(workspaceId, session.runtime);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO session_agents (session_id, agent_id, role, added_by, joined_at)
           VALUES (?, ?, 'leader', NULL, ?)`,
        )
        .run(sessionId, agent.id, session.created_at);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO agent_threads
             (id, session_id, agent_id, backend, native_session_id, cwd,
              agent_version, status, last_seen_seq, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 'idle', 0, ?, ?)`,
        )
        .run(
          `th_${sessionId}`,
          sessionId,
          agent.id,
          session.runtime,
          session.native_session_id,
          session.cwd,
          session.created_at,
          session.last_active_at,
        );
    } catch {
      // Shadow-only: never block or fail session creation.
    }
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

  /**
   * Mirror the leader's backend onto the session row.
   *
   * `sessions.runtime` predates agents and is still what older clients read and
   * what the scheduler looks up. Keeping it equal to the leader's backend means
   * that old read path stays correct without changing those callers.
   */
  setSessionRuntime(id: string, runtime: string): void {
    this.db.prepare(`UPDATE sessions SET runtime = ? WHERE id = ?`).run(runtime, id);
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
    // Legacy mirror: keep the session's own column in step for readers that
    // have not moved to threads yet. The authoritative per-agent write is
    // `setAgentThreadNativeId` — this one must not touch other agents' threads.
    this.db
      .prepare(
        `UPDATE agent_threads SET native_session_id = ?, last_used_at = ?
         WHERE session_id = ? AND agent_id = (
           SELECT agent_id FROM session_agents WHERE session_id = ? AND role = 'leader'
         )`,
      )
      .run(nativeSessionId, Date.now(), id, id);
  }

  /**
   * Record the provider's handle on one specific thread.
   *
   * `sessions.native_session_id` mirrors the leader's conversation for readers
   * that predate agents (and for the scheduler, which looks the session up by
   * runtime), so it is kept in step whenever the leader's thread is written.
   * Other agents' threads never touch it — that is what stops one agent's
   * conversation from being handed to its room-mates.
   */
  setAgentThreadNativeId(threadId: string, nativeSessionId: string): void {
    const row = this.db
      .prepare(`SELECT session_id AS sessionId, agent_id AS agentId FROM agent_threads WHERE id = ?`)
      .get(threadId) as unknown as { sessionId: string; agentId: string } | undefined;
    this.db
      .prepare(`UPDATE agent_threads SET native_session_id = ?, status = 'idle', last_used_at = ? WHERE id = ?`)
      .run(nativeSessionId, Date.now(), threadId);
    if (!row) return;
    const leader = this.getSessionLeader(row.sessionId);
    if (leader?.agent_id === row.agentId) {
      this.db
        .prepare(`UPDATE sessions SET native_session_id = ? WHERE id = ?`)
        .run(nativeSessionId, row.sessionId);
    }
  }

  /** Forget a native id the runtime no longer recognizes; the next run starts fresh. */
  clearNativeSessionId(id: string): void {
    this.db.prepare(`UPDATE sessions SET native_session_id = NULL WHERE id = ?`).run(id);
    this.db
      .prepare(
        `UPDATE agent_threads SET native_session_id = NULL
         WHERE session_id = ? AND agent_id = (
           SELECT agent_id FROM session_agents WHERE session_id = ? AND role = 'leader'
         )`,
      )
      .run(id, id);
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
    // Room-only events use a synthetic run id (session notices), so clearing by
    // event owner is not enough. session_id is the actual lifetime boundary.
    this.db.prepare(`DELETE FROM events WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM runs WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM session_permission_grants WHERE session_id = ?`).run(id);
    // Multi-agent rows have no foreign keys. A deleted session must not leave
    // turns/tasks/memberships/threads behind for roster and reconcile queries.
    this.db.prepare(`DELETE FROM agent_tasks WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM session_turns WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM session_agents WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM agent_threads WHERE session_id = ?`).run(id);
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
   * Register an explicit startup Workspace and backfill legacy sessions.
   *
   * An explicit `--workspace` (`source: 'flag'`) is **authoritative**: the dir
   * the user named must be the default workspace, so it is re-asserted on every
   * start. `env` keeps the one-time-seed semantics: a workspace the user deleted
   * is not resurrected on the next start. The daemon's no-path startup uses
   * {@link finalizeWorkspaceDefaults} directly after ensuring the life
   * workspace; direct callers may still use `default` to seed a dev row.
   */
  seedDefaultWorkspace(
    rawPath: string,
    defaultPermissionMode: string,
    source: WorkspaceSource = 'default',
  ): WorkspaceRow | null {
    if (source === 'flag') {
      this.ensureWorkspaceDefault(rawPath);
    } else if (!this.getSetting(SEEDED_WORKSPACE_KEY)) {
      // The built-in life workspace may already exist on a fresh install; it
      // must not stop an explicit env path from being seeded once.
      const hasDevWorkspace = this.listWorkspaces().some(
        (w) => w.family === 'dev' && w.is_builtin !== 1,
      );
      if (!hasDevWorkspace) {
        const realPath = fs.realpathSync(path.resolve(rawPath));
        this.createWorkspace({
          name: path.basename(realPath) || realPath,
          path: realPath,
          isDefault: true,
        });
      }
      this.setSetting(SEEDED_WORKSPACE_KEY, '1');
    }

    return this.finalizeWorkspaceDefaults(defaultPermissionMode);
  }

  /**
   * Pick a default workspace if none is set and apply startup defaults to
   * legacy rows. The life workspace is a valid default now that it is the only
   * built-in workspace: it is the first-run landing surface and the fallback
   * after the last dev workspace is deleted.
   */
  finalizeWorkspaceDefaults(defaultPermissionMode: string): WorkspaceRow | null {
    const currentDefault = this.getDefaultWorkspace();
    const workspace =
      currentDefault ??
      this.listWorkspaces().find((w) => w.family === 'dev' && w.enabled === 1) ??
      this.listWorkspaces().find((w) => w.enabled === 1) ??
      null;
    if (workspace && !currentDefault) {
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
    this.db
      .prepare(`UPDATE sessions SET permission_mode = ? WHERE permission_mode IS NULL OR permission_mode = ''`)
      .run(defaultPermissionMode);

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
      this.createWorkspace({
        name: path.basename(realPath) || realPath,
        path: realPath,
        isDefault: true,
      });
      return;
    }
    if (existing.family === 'life') {
      if (existing.enabled !== 1) this.updateWorkspace(existing.id, { enabled: true });
      if (existing.is_default !== 1) this.setDefaultWorkspace(existing.id);
      return;
    }
    if (existing.enabled !== 1) this.updateWorkspace(existing.id, { enabled: true });
    if (existing.is_default !== 1) this.setDefaultWorkspace(existing.id);
  }

  /**
   * Delete the old `~/.paboot/defaultworkspace` rows introduced before the life
   * workspace became the fallback. Empty fallback rows are safe to drop. A row
   * that still owns sessions is preserved as a normal dev workspace instead of
   * silently deleting user-visible history; it simply stops being "the
   * built-in workspace".
   */
  migrateLegacyBuiltinFallback(): void {
    const legacy = this.listWorkspaces().filter((w) => w.family === 'dev' && w.is_builtin === 1);
    for (const workspace of legacy) {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS count FROM sessions WHERE workspace_id = ?`)
        .get(workspace.id) as { count: number };
      if (Number(row.count) === 0) {
        this.deleteWorkspace(workspace.id);
      } else {
        this.db
          .prepare(`UPDATE workspaces SET is_builtin = 0, name = ? WHERE id = ?`)
          .run(workspace.name || '旧内置工作区', workspace.id);
      }
    }
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

  /** Every workspace is user-visible now; the life workspace is no longer hidden. */
  listVisibleWorkspaces(): WorkspaceRow[] {
    return this.listWorkspaces();
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
    // Workspace deletion is a full cascade. Routes normally delete sessions
    // first, but callers such as migrations/tests may not; make the DB method
    // safe on its own instead of relying on every call site remembering the
    // multi-agent tables.
    for (const session of this.listAllSessions(id)) this.deleteSession(session.id);
    this.db.prepare(`DELETE FROM agents WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM workspace_dirs WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM workspace_shortcut_dirs WHERE workspace_id = ?`).run(id);
    // Ends are workspace-owned rows (no FK); clean them up with the workspace.
    this.db
      .prepare(
        `DELETE FROM session_ends
         WHERE end_id IN (SELECT id FROM ends WHERE workspace_id = ?)
            OR session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)`,
      )
      .run(id, id);
    this.db
      .prepare(`DELETE FROM end_roots WHERE end_id IN (SELECT id FROM ends WHERE workspace_id = ?)`)
      .run(id);
    this.db.prepare(`DELETE FROM ends WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM memory_settings WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
  }

  // ---- agents (P0: shadow tables; nothing reads them in the request path) ----

  /**
   * Create the implicit "default" agent for a (workspace, runtime) pair, or
   * return the existing one.
   *
   * The id is deterministic so re-running is a no-op and P1 can look a pair up
   * without a name index. One implicit agent per runtime rather than one per
   * workspace: a workspace can hold sessions of several runtimes, and invariant
   * I3 wants `sessions.runtime === leader.runtime`.
   */
  ensureImplicitAgent(workspaceId: string, runtime: string): AgentRow {
    const id = implicitAgentId(workspaceId, runtime);
    const existing = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as unknown as AgentRow | undefined;
    if (existing) return existing;

    const now = Date.now();
    const hasImplicit = this.db
      .prepare(`SELECT 1 FROM agents WHERE workspace_id = ? AND is_implicit = 1 LIMIT 1`)
      .get(workspaceId);
    // First implicit agent in a workspace takes the plain name; the rest carry
    // their runtime so `@默认` is never ambiguous.
    let name = hasImplicit ? `默认 (${runtime})` : '默认';
    for (let suffix = 2; this.agentNameTaken(workspaceId, name); suffix += 1) {
      name = `默认 (${runtime} ${suffix})`;
    }
    this.db
      .prepare(
        `INSERT INTO agents
           (id, workspace_id, name, summary, kind, runtime, instructions, is_implicit,
            enabled, version, created_at, updated_at)
         VALUES (?, ?, ?, '', 'runtime', ?, '', 1, 1, 1, ?, ?)`,
      )
      .run(id, workspaceId, name, runtime, now, now);
    return this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as unknown as AgentRow;
  }

  getAgent(id: string): AgentRow | undefined {
    return this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as unknown as AgentRow | undefined;
  }

  listAgents(workspaceId: string): AgentRow[] {
    return this.db
      .prepare(`SELECT * FROM agents WHERE workspace_id = ? ORDER BY is_implicit ASC, created_at ASC`)
      .all(workspaceId) as unknown as AgentRow[];
  }

  /** Insert a fully-formed agent row. Callers validate; this only writes. */
  insertAgent(row: AgentRow): void {
    this.db
      .prepare(
        `INSERT INTO agents
           (id, workspace_id, name, summary, avatar, kind, runtime, peer_id, remote_agent_id,
            model, model_parameters, instructions, cwd, extra_dirs, read_only,
            permission_ceiling, skills, budget_json, heavy,
            is_implicit, enabled, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.workspace_id,
        row.name,
        row.summary,
        row.avatar,
        row.kind,
        row.runtime,
        row.peer_id,
        row.remote_agent_id,
        row.model,
        row.model_parameters,
        row.instructions,
        row.cwd,
        row.extra_dirs,
        row.read_only,
        row.permission_ceiling,
        row.skills,
        row.budget_json,
        row.heavy,
        row.is_implicit,
        row.enabled,
        row.version,
        row.created_at,
        row.updated_at,
      );
  }

  /**
   * Overwrite the editable columns of an agent. `version` and `updated_at` are
   * supplied by the service so the increment stays in one place.
   */
  updateAgentRow(
    id: string,
    row: Pick<
      AgentRow,
      | 'name'
      | 'summary'
      | 'avatar'
      | 'runtime'
      | 'model'
      | 'model_parameters'
      | 'instructions'
      | 'cwd'
      | 'extra_dirs'
      | 'read_only'
      | 'permission_ceiling'
      | 'skills'
      | 'budget_json'
      | 'heavy'
      | 'enabled'
      | 'version'
      | 'updated_at'
    >,
  ): void {
    this.db
      .prepare(
        `UPDATE agents SET
           name = ?, summary = ?, avatar = ?, runtime = ?, model = ?, model_parameters = ?,
           instructions = ?, cwd = ?, extra_dirs = ?, read_only = ?, permission_ceiling = ?,
           skills = ?, budget_json = ?, heavy = ?,
           enabled = ?, version = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        row.name,
        row.summary,
        row.avatar,
        row.runtime,
        row.model,
        row.model_parameters,
        row.instructions,
        row.cwd,
        row.extra_dirs,
        row.read_only,
        row.permission_ceiling,
        row.skills,
        row.budget_json,
        row.heavy,
        row.enabled,
        row.version,
        row.updated_at,
        id,
      );
  }

  deleteAgentRow(id: string): void {
    this.db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  }

  /** Another agent in the workspace already holds this name (case-insensitive). */
  agentNameConflict(workspaceId: string, name: string, exceptId: string | null): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM agents WHERE workspace_id = ? AND lower(name) = lower(?) AND id <> ? LIMIT 1`,
      )
      .get(workspaceId, name, exceptId ?? '') as unknown as { id: string } | undefined;
    return row !== undefined;
  }

  // ---- session agents (membership) ----

  listSessionAgents(sessionId: string): SessionAgentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM session_agents WHERE session_id = ?
         ORDER BY CASE role WHEN 'leader' THEN 0 ELSE 1 END, joined_at ASC`,
      )
      .all(sessionId) as unknown as SessionAgentRow[];
  }

  upsertSessionAgent(row: SessionAgentRow): void {
    this.db
      .prepare(
        `INSERT INTO session_agents (session_id, agent_id, role, added_by, joined_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id, agent_id) DO UPDATE SET role = excluded.role`,
      )
      .run(row.session_id, row.agent_id, row.role, row.added_by, row.joined_at);
  }

  deleteSessionAgent(sessionId: string, agentId: string): void {
    this.db
      .prepare(`DELETE FROM session_agents WHERE session_id = ? AND agent_id = ?`)
      .run(sessionId, agentId);
  }

  listSessionsForAgent(agentId: string): string[] {
    return (
      this.db
        .prepare(`SELECT session_id AS id FROM session_agents WHERE agent_id = ?`)
        .all(agentId) as unknown as { id: string }[]
    ).map((row) => row.id);
  }

  /**
   * Next room-wide frame position for this session.
   *
   * One counter per session over every agent's frames. A single number is what
   * lets a reconnecting client say "I have seen up to N" instead of tracking a
   * cursor per run, which is the whole point of multiplexing the room stream.
   */
  nextRoomSeq(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(room_seq) AS seq FROM events WHERE session_id = ?`)
      .get(sessionId) as unknown as { seq: number | null } | undefined;
    return (row?.seq ?? 0) + 1;
  }

  /** Replay a room's frames after a cursor, oldest first. */
  listRoomEvents(
    sessionId: string,
    afterRoomSeq = 0,
    limit = 500,
  ): {
    room_seq: number;
    run_id: string;
    seq: number;
    type: string;
    payload: string;
    created_at: number;
    task_id: string | null;
    agent_id: string | null;
  }[] {
    // Attribution is joined back from the run (and its task, when it has one):
    // a replayed frame must carry the same speaker a live one did, otherwise a
    // reconnecting client loses who said what for everything it missed. A
    // `/api/chat` run has no task row, so fall back to `runs.agent_id`.
    return this.db
      .prepare(
        `SELECT e.room_seq, e.run_id, e.seq, e.type, e.payload, e.created_at,
                t.id AS task_id, COALESCE(t.agent_id, r.agent_id) AS agent_id
         FROM events e
         LEFT JOIN agent_tasks t ON t.run_id = e.run_id
         LEFT JOIN runs r ON r.id = e.run_id
         WHERE e.session_id = ? AND e.room_seq > ? AND e.room_seq IS NOT NULL
         ORDER BY e.room_seq ASC LIMIT ?`,
      )
      .all(sessionId, afterRoomSeq, limit) as unknown as {
      room_seq: number;
      run_id: string;
      seq: number;
      type: string;
      payload: string;
      created_at: number;
      task_id: string | null;
      agent_id: string | null;
    }[];
  }

  // ---- timeline (committed_seq) ----
  //
  // `messages.id` is insertion order; `committed_seq` is the order users see.
  // They differ because a long run may start early and finish late: ordering by
  // `id` would leave its card stranded far above the conversation, so a card
  // takes its place on the timeline only when it commits.

  /** Highest timeline position in this session, or 0 when nothing is committed. */
  maxCommittedSeq(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(committed_seq) AS seq FROM messages WHERE session_id = ?`)
      .get(sessionId) as unknown as { seq: number | null } | undefined;
    return row?.seq ?? 0;
  }

  /**
   * Append a message that is already final and give it a timeline position.
   *
   * Used for completed agent turns. Streaming content never lands here: it lives
   * in the task/run until it is committed, which is what keeps the timeline from
   * reshuffling under the user.
   */
  addCommittedMessage(input: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    agentId: string | null;
    turnId: string | null;
    taskId: string | null;
  }): number {
    const seq = this.maxCommittedSeq(input.sessionId) + 1;
    const info = this.db
      .prepare(
        `INSERT INTO messages (session_id, role, content, agent_id, turn_id, task_id, committed_seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.role,
        input.content,
        input.agentId,
        input.turnId,
        input.taskId,
        seq,
        Date.now(),
      );
    return Number(info.lastInsertRowid);
  }

  /**
   * Committed messages a room projection may show one agent.
   *
   * Ordered by timeline position, bounded by the task's snapshot, and without
   * the agent's own messages (its own history lives in its provider thread).
   */
  messagesForProjection(
    sessionId: string,
    afterSeq: number,
    snapshotSeq: number,
    excludeAgentId: string,
  ): {
    id: number;
    role: string;
    content: string;
    agent_id: string | null;
    committed_seq: number;
  }[] {
    return this.db
      .prepare(
        `SELECT id, role, content, agent_id, committed_seq FROM messages
         WHERE session_id = ? AND committed_seq IS NOT NULL
           AND committed_seq > ? AND committed_seq <= ?
           AND (agent_id IS NULL OR agent_id <> ?)
         ORDER BY committed_seq ASC`,
      )
      .all(sessionId, afterSeq, snapshotSeq, excludeAgentId) as unknown as {
      id: number;
      role: string;
      content: string;
      agent_id: string | null;
      committed_seq: number;
    }[];
  }

  /** Messages in timeline order; `afterSeq` resumes a client that reconnected. */
  listCommittedMessages(
    sessionId: string,
    afterSeq = 0,
    limit = 200,
  ): { id: number; role: string; content: string; agent_id: string | null; committed_seq: number; created_at: number }[] {
    return this.db
      .prepare(
        `SELECT id, role, content, agent_id, committed_seq, created_at FROM messages
         WHERE session_id = ? AND committed_seq IS NOT NULL AND committed_seq > ?
         ORDER BY committed_seq ASC LIMIT ?`,
      )
      .all(sessionId, afterSeq, limit) as unknown as {
      id: number;
      role: string;
      content: string;
      agent_id: string | null;
      committed_seq: number;
      created_at: number;
    }[];
  }

  // ---- turns & tasks ----
  //
  // A turn is one user input; the tasks under it are the agents it started.
  // The turn is NOT a barrier (03-room.md 4.2): it exists to group tasks for
  // budget accounting and the batch-epilogue, not to serialize them.

  createTurn(input: {
    id: string;
    sessionId: string;
    prompt: string;
    tokenLimit: number;
    now: number;
    commandId?: string | null;
    attachmentIds?: string[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO session_turns
           (id, session_id, prompt, status, input_tokens, token_limit, attachment_ids, created_at, command_id)
         VALUES (?, ?, ?, 'running', 0, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.prompt,
        input.tokenLimit,
        JSON.stringify(input.attachmentIds ?? []),
        input.now,
        input.commandId ?? null,
      );
  }

  /** Image ids attached to one turn (empty for text-only or malformed legacy rows). */
  getTurnAttachmentIds(id: string): string[] {
    const turn = this.getTurn(id);
    if (!turn?.attachment_ids) return [];
    try {
      const parsed = JSON.parse(turn.attachment_ids) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  getTurn(id: string): TurnRow | undefined {
    return this.db.prepare(`SELECT * FROM session_turns WHERE id = ?`).get(id) as unknown as
      | TurnRow
      | undefined;
  }

  /**
   * A retry of the same send: the turn it already created, if any.
   *
   * Global, not per session: `command_id` has one unique index, so a lookup
   * scoped to the session would let another session's key reach INSERT and
   * fail the constraint after the user message was already written.
   */
  getTurnByCommandId(commandId: string): TurnRow | undefined {
    return this.db
      .prepare(`SELECT * FROM session_turns WHERE command_id = ? LIMIT 1`)
      .get(commandId) as unknown as TurnRow | undefined;
  }

  listTurns(sessionId: string, before: string | null, limit: number): TurnRow[] {
    if (before) {
      const anchor = this.getTurn(before);
      if (!anchor) return [];
      return this.db
        .prepare(
          `SELECT * FROM session_turns WHERE session_id = ? AND created_at < ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(sessionId, anchor.created_at, limit) as unknown as TurnRow[];
    }
    return this.db
      .prepare(`SELECT * FROM session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(sessionId, limit) as unknown as TurnRow[];
  }

  /** Close a turn once every task under it has reached a terminal state. */
  finishTurnIfSettled(id: string, now: number): boolean {
    const open = this.db
      .prepare(
        `SELECT 1 FROM agent_tasks WHERE turn_id = ? AND status IN ('queued','running') LIMIT 1`,
      )
      .get(id);
    if (open) return false;
    const failed = this.db
      .prepare(`SELECT 1 FROM agent_tasks WHERE turn_id = ? AND status = 'failed' LIMIT 1`)
      .get(id);
    this.db
      .prepare(`UPDATE session_turns SET status = ?, ended_at = ? WHERE id = ? AND status = 'running'`)
      .run(failed ? 'failed' : 'done', now, id);
    return true;
  }

  createTask(input: {
    id: string;
    sessionId: string;
    turnId: string;
    agentId: string;
    source: AgentTaskSource;
    /** Leader task that summoned this supplement; null for user-addressed work. */
    parentTaskId?: string | null;
    prompt: string;
    needsWrite: boolean;
    snapshotSeq: number;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_tasks
           (id, session_id, turn_id, agent_id, source, parent_task_id, prompt, status, needs_write,
            snapshot_seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.turnId,
        input.agentId,
        input.source,
        input.parentTaskId ?? null,
        input.prompt,
        input.needsWrite ? 1 : 0,
        input.snapshotSeq,
        input.now,
      );
  }

  getTask(id: string): AgentTaskRow | undefined {
    return this.db.prepare(`SELECT * FROM agent_tasks WHERE id = ?`).get(id) as unknown as
      | AgentTaskRow
      | undefined;
  }

  listTasksByTurn(turnId: string): AgentTaskRow[] {
    return this.db
      .prepare(`SELECT * FROM agent_tasks WHERE turn_id = ? ORDER BY created_at ASC`)
      .all(turnId) as unknown as AgentTaskRow[];
  }

  /** Tasks that are queued or running for a session, oldest first. */
  listOpenTasks(sessionId: string): AgentTaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_tasks WHERE session_id = ? AND status IN ('queued','running')
         ORDER BY created_at ASC`,
      )
      .all(sessionId) as unknown as AgentTaskRow[];
  }

  updateTask(
    id: string,
    patch: {
      status?: string;
      runId?: string | null;
      startedAt?: number | null;
      endedAt?: number | null;
      error?: string | null;
      messageId?: number | null;
    },
  ): void {
    const current = this.getTask(id);
    if (!current) return;
    this.db
      .prepare(
        `UPDATE agent_tasks SET status = ?, run_id = ?, started_at = ?, ended_at = ?,
           error = ?, message_id = ? WHERE id = ?`,
      )
      .run(
        patch.status ?? current.status,
        patch.runId !== undefined ? patch.runId : current.run_id,
        patch.startedAt !== undefined ? patch.startedAt : current.started_at,
        patch.endedAt !== undefined ? patch.endedAt : current.ended_at,
        patch.error !== undefined ? patch.error : current.error,
        patch.messageId !== undefined ? patch.messageId : current.message_id,
        id,
      );
  }

  /** Every task still marked running — used to reconcile after a restart. */
  listRunningTasks(): AgentTaskRow[] {
    return this.db
      .prepare(`SELECT * FROM agent_tasks WHERE status = 'running'`)
      .all() as unknown as AgentTaskRow[];
  }

  /** Whether this session already has a member that may write to the workspace. */
  sessionHasWritableAgent(sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM session_agents sa
           JOIN agents a ON a.id = sa.agent_id
           WHERE sa.session_id = ? AND a.read_only = 0 AND a.enabled = 1 LIMIT 1`,
        )
        .get(sessionId),
    );
  }

  // ---- agent threads ----

  listAgentThreads(sessionId: string): AgentThreadRow[] {
    return this.db
      .prepare(`SELECT * FROM agent_threads WHERE session_id = ?`)
      .all(sessionId) as unknown as AgentThreadRow[];
  }

  /**
   * Open (or reuse) the context handle for one agent in one session.
   *
   * A thread snapshots the agent's version at open time: if the agent is later
   * edited, the snapshot is what tells us the conversation was built under a
   * different persona, which is otherwise invisible drift.
   */
  ensureAgentThread(input: {
    id: string;
    sessionId: string;
    agentId: string;
    backend: string;
    cwd: string;
    modelSnapshot: string | null;
    agentVersion: number;
    now: number;
  }): AgentThreadRow {
    const existing = this.getAgentThread(input.sessionId, input.agentId);
    if (existing) return existing;
    this.db
      .prepare(
        `INSERT INTO agent_threads
           (id, session_id, agent_id, backend, native_session_id, cwd, model_snapshot,
            agent_version, status, last_seen_seq, created_at, last_used_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'idle', 0, ?, ?)
         ON CONFLICT (session_id, agent_id) DO NOTHING`,
      )
      .run(
        input.id,
        input.sessionId,
        input.agentId,
        input.backend,
        input.cwd,
        input.modelSnapshot,
        input.agentVersion,
        input.now,
        input.now,
      );
    return this.getAgentThread(input.sessionId, input.agentId) as AgentThreadRow;
  }

  /** Advance a thread's room cursor to a timeline position it has been given. */
  setAgentThreadSeenSeq(id: string, seq: number): void {
    this.db
      .prepare(
        `UPDATE agent_threads SET last_seen_seq = MAX(last_seen_seq, ?), last_used_at = ? WHERE id = ?`,
      )
      .run(seq, Date.now(), id);
  }

  updateAgentThread(
    id: string,
    patch: { cwd?: string; status?: string; modelSnapshot?: string | null },
  ): void {
    const current = this.db.prepare(`SELECT * FROM agent_threads WHERE id = ?`).get(id) as unknown as
      | AgentThreadRow
      | undefined;
    if (!current) return;
    this.db
      .prepare(
        `UPDATE agent_threads SET cwd = ?, status = ?, model_snapshot = ?, last_used_at = ? WHERE id = ?`,
      )
      .run(
        patch.cwd ?? current.cwd,
        patch.status ?? current.status,
        patch.modelSnapshot !== undefined ? patch.modelSnapshot : current.model_snapshot,
        Date.now(),
        id,
      );
  }

  deleteAgentThreads(sessionId: string, agentId: string): void {
    this.db
      .prepare(`DELETE FROM agent_threads WHERE session_id = ? AND agent_id = ?`)
      .run(sessionId, agentId);
  }

  /**
   * Drop one thread's provider handle; its history rows stay.
   *
   * `sessions.native_session_id` mirrors the leader's thread for readers that
   * predate agents, so it is cleared too when the reset hits the leader. Leaving
   * it behind would make the legacy column claim a conversation that no longer
   * exists — the next run would resume it and fail all over again.
   */
  clearAgentThreadNativeId(threadId: string): void {
    const row = this.db
      .prepare(`SELECT session_id AS sessionId, agent_id AS agentId FROM agent_threads WHERE id = ?`)
      .get(threadId) as unknown as { sessionId: string; agentId: string } | undefined;
    this.db
      .prepare(`UPDATE agent_threads SET native_session_id = NULL, status = 'broken', last_used_at = ? WHERE id = ?`)
      .run(Date.now(), threadId);
    if (!row) return;
    const leader = this.getSessionLeader(row.sessionId);
    if (leader?.agent_id === row.agentId) {
      this.db.prepare(`UPDATE sessions SET native_session_id = NULL WHERE id = ?`).run(row.sessionId);
    }
  }

  /**
   * Whether the builtin runtime has a transcript for this agent in the session.
   *
   * Builtin conversations live in the native transcript tables, not behind a
   * provider session id, so `agent_threads.native_session_id` is always null
   * for them. This is the signal `hasContext` needs instead.
   */
  hasNativeTranscript(sessionId: string, agentId: string): boolean {
    const thread = this.getNativeThreadForSession(sessionId, agentId);
    if (!thread) return false;
    const row = this.db
      .prepare(`SELECT 1 AS present FROM native_messages WHERE thread_id = ? LIMIT 1`)
      .get(thread.id);
    return row !== undefined;
  }

  /** Drop the builtin transcript for one agent; the next run starts fresh. */
  clearNativeTranscriptByOwner(sessionId: string, agentId: string): void {
    const thread = this.getNativeThreadForSession(sessionId, agentId);
    if (thread) this.deleteNativeThread(thread.id);
  }

  /** Reset one agent's conversation in one session, keeping its history rows. */
  clearAgentThreadByOwner(sessionId: string, agentId: string): void {
    this.db
      .prepare(
        `UPDATE agent_threads SET native_session_id = NULL, status = 'broken', last_used_at = ?
         WHERE session_id = ? AND agent_id = ?`,
      )
      .run(Date.now(), sessionId, agentId);
    // `sessions.native_session_id` mirrors the leader's thread for readers that
    // predate agents — notably the scheduler, whose runs carry no thread. If
    // the leader is reset, leaving the mirror behind would resume the very
    // conversation the user just discarded.
    const leader = this.getSessionLeader(sessionId);
    if (leader?.agent_id === agentId) {
      this.db.prepare(`UPDATE sessions SET native_session_id = NULL WHERE id = ?`).run(sessionId);
    }
  }

  /**
   * Distinct (workspace, runtime) pairs that live sessions actually use.
   * Sessions pointing at a workspace that no longer exists are excluded: they
   * cannot be attributed, and seeding an agent for a dangling workspace id
   * would only create junk rows.
   */
  listSessionRuntimePairs(): { workspace_id: string; runtime: string }[] {
    return this.db
      .prepare(
        `SELECT DISTINCT s.workspace_id, s.runtime FROM sessions s
         JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.kind IN ('chat', 'command') AND s.workspace_id IS NOT NULL`,
      )
      .all() as unknown as { workspace_id: string; runtime: string }[];
  }

  /** Workspaces that have a configured default runtime but no sessions to infer from. */
  listWorkspaceDefaultRuntimes(): { id: string; default_runtime: string | null }[] {
    return this.db
      .prepare(`SELECT id, default_runtime FROM workspaces`)
      .all() as unknown as { id: string; default_runtime: string | null }[];
  }

  private agentNameTaken(workspaceId: string, name: string): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM agents WHERE workspace_id = ? AND name = ? LIMIT 1`)
        .get(workspaceId, name),
    );
  }

  setWorkspaceDefaultAgent(workspaceId: string, agentId: string): void {
    this.db
      .prepare(`UPDATE workspaces SET default_agent_id = ? WHERE id = ? AND default_agent_id IS NULL`)
      .run(agentId, workspaceId);
  }

  getWorkspaceDefaultAgentId(workspaceId: string): string | null {
    const row = this.db
      .prepare(`SELECT default_agent_id AS id FROM workspaces WHERE id = ?`)
      .get(workspaceId) as unknown as { id: string | null } | undefined;
    return row?.id ?? null;
  }

  /** Backfill step: give every live session a leader row. Set-based, idempotent. */
  backfillSessionLeaders(): number {
    return Number(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO session_agents (session_id, agent_id, role, added_by, joined_at)
           SELECT s.id, a.id, 'leader', NULL, s.created_at
           FROM sessions s
           JOIN workspaces w ON w.id = s.workspace_id
           JOIN agents a ON a.workspace_id = s.workspace_id
                        AND a.is_implicit = 1 AND a.runtime = s.runtime
           WHERE s.kind IN ('chat', 'command') AND s.workspace_id IS NOT NULL`,
        )
        .run().changes,
    );
  }

  /** Backfill step: give every live session one thread per its leader. Idempotent. */
  backfillAgentThreads(): number {
    return Number(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO agent_threads
             (id, session_id, agent_id, backend, native_session_id, cwd,
              agent_version, status, last_seen_seq, created_at, last_used_at)
           SELECT 'th_' || s.id, s.id, sa.agent_id, s.runtime, s.native_session_id, s.cwd,
                  1, 'idle', 0, s.created_at, s.last_active_at
           FROM sessions s
           JOIN workspaces w ON w.id = s.workspace_id
           JOIN session_agents sa ON sa.session_id = s.id AND sa.role = 'leader'
           WHERE s.kind IN ('chat', 'command')`,
        )
        .run().changes,
    );
  }

  /**
   * Backfill step: give room runs the turn they already executed for.
   *
   * `agent_tasks` has known the pairing since turns were introduced; only the
   * run row was missing it. Without this, a client cannot tell that two runs
   * were answers to one question, and redraws the question per run.
   */
  backfillRunTurnIds(): number {
    return Number(
      this.db
        .prepare(
          `UPDATE runs SET turn_id = (
             SELECT t.turn_id FROM agent_tasks t WHERE t.run_id = runs.id LIMIT 1
           )
           WHERE turn_id IS NULL
             AND EXISTS (SELECT 1 FROM agent_tasks t WHERE t.run_id = runs.id)`,
        )
        .run().changes,
    );
  }

  /** Backfill step: attribute runs created before agents to their session leader. */
  backfillRunAttribution(): number {
    return Number(
      this.db
        .prepare(
          `UPDATE runs SET
             agent_id = (
               SELECT sa.agent_id FROM session_agents sa
               WHERE sa.session_id = runs.session_id AND sa.role = 'leader'
             ),
             thread_id = (
               SELECT t.id FROM agent_threads t
               JOIN session_agents sa ON sa.session_id = t.session_id AND sa.agent_id = t.agent_id
               WHERE t.session_id = runs.session_id AND sa.role = 'leader'
               LIMIT 1
             )
           WHERE agent_id IS NULL
             AND session_id IN (SELECT session_id FROM session_agents WHERE role = 'leader')`,
        )
        .run().changes,
    );
  }

  /**
   * Point builtin transcripts at the agent that owns the session.
   *
   * Before agents, every builtin transcript was keyed `agent_id = 'builtin'`.
   * Once the driver passes the real agent id, those rows would no longer be
   * found and every existing conversation would appear to have been forgotten.
   * This rewrites them in place, one session at a time.
   *
   * Only the leader is remapped: a single-agent session is the only shape that
   * existed before, so there is exactly one thread per session to move.
   */
  backfillNativeThreadAgents(): number {
    return Number(
      this.db
        .prepare(
          `UPDATE native_threads
           SET agent_id = (
             SELECT sa.agent_id FROM session_agents sa
             WHERE sa.session_id = native_threads.session_id AND sa.role = 'leader'
           )
           WHERE agent_id = 'builtin'
             AND EXISTS (
               SELECT 1 FROM session_agents sa
               WHERE sa.session_id = native_threads.session_id AND sa.role = 'leader'
             )`,
        )
        .run().changes,
    );
  }

  getSessionLeader(sessionId: string): SessionAgentRow | undefined {
    return this.db
      .prepare(`SELECT * FROM session_agents WHERE session_id = ? AND role = 'leader'`)
      .get(sessionId) as unknown as SessionAgentRow | undefined;
  }

  getAgentThread(sessionId: string, agentId: string): AgentThreadRow | undefined {
    return this.db
      .prepare(`SELECT * FROM agent_threads WHERE session_id = ? AND agent_id = ?`)
      .get(sessionId, agentId) as unknown as AgentThreadRow | undefined;
  }

  /** Reconciliation helpers for `scripts/verify-shadow-tables.ts` (read-only). */

  /**
   * (workspace, runtime) pairs carrying more than one implicit agent. The
   * deterministic-id seeding should make this impossible, so a hit means the
   * seeding path was bypassed or the schema drifted.
   */
  listDuplicateImplicitAgents(): { workspace_id: string; runtime: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT workspace_id, runtime, COUNT(*) AS count FROM agents
         WHERE is_implicit = 1 AND runtime IS NOT NULL
         GROUP BY workspace_id, runtime HAVING COUNT(*) > 1`,
      )
      .all() as unknown as { workspace_id: string; runtime: string; count: number }[];
  }

  /** Implicit agents whose workspace no longer exists. */
  listDanglingImplicitAgents(): string[] {
    return (
      this.db
        .prepare(
          `SELECT a.id AS id FROM agents a
           WHERE a.is_implicit = 1
             AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = a.workspace_id)`,
        )
        .all() as unknown as { id: string }[]
    ).map((row) => row.id);
  }

  /** Shadow-table health counters used by `scripts/verify-shadow-tables.ts`. */  shadowTableCounts(): {
    liveSessions: number;
    withLeader: number;
    withThread: number;
    threads: number;
    orphanThreads: number;
    dualWriteMismatch: number;
  } {
    const count = (sql: string): number =>
      Number((this.db.prepare(sql).get() as unknown as { n: number }).n);
    return {
      liveSessions: count(`SELECT COUNT(*) AS n FROM sessions WHERE kind IN ('chat','command')`),
      withLeader: count(
        `SELECT COUNT(*) AS n FROM sessions s
         WHERE s.kind IN ('chat','command')
           AND EXISTS (SELECT 1 FROM session_agents sa
                       WHERE sa.session_id = s.id AND sa.role = 'leader')`,
      ),
      withThread: count(
        `SELECT COUNT(*) AS n FROM sessions s
         WHERE s.kind IN ('chat','command')
           AND EXISTS (SELECT 1 FROM agent_threads t WHERE t.session_id = s.id)`,
      ),
      threads: count(`SELECT COUNT(*) AS n FROM agent_threads`),
      orphanThreads: count(
        `SELECT COUNT(*) AS n FROM agent_threads t
         WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = t.session_id)`,
      ),
      // Only compares rows where both sides carry a value: NULL on either side
      // means "not known yet", not a mismatch.
      dualWriteMismatch: count(
        `SELECT COUNT(*) AS n FROM sessions s
         JOIN agent_threads t ON t.session_id = s.id
         WHERE s.native_session_id IS NOT NULL AND t.native_session_id IS NOT NULL
           AND s.native_session_id <> t.native_session_id`,
      ),
    };
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

  /**
   * Register the built-in life workspace and its single `life` end.
   *
   * Called once at daemon start. It only creates what is missing, so old
   * databases need no migration and a second boot is a no-op. `is_builtin=1`
   * marks the one built-in workspace; unlike the retired dev fallback it is
   * always visible and can be the default.
   */
  ensureLifeWorkspace(lifePath: string): { workspace: WorkspaceRow; end: EndRow } {
    fs.mkdirSync(lifePath, { recursive: true });
    const realPath = fs.realpathSync(path.resolve(lifePath));
    let workspace = this.db
      .prepare(`SELECT * FROM workspaces WHERE family = 'life' ORDER BY created_at ASC LIMIT 1`)
      .get() as unknown as WorkspaceRow | undefined;

    if (!workspace) {
      workspace = this.createWorkspace({
        name: '个人空间',
        path: realPath,
        isBuiltin: true,
        family: 'life',
        profileMode: 'portable',
      });
    } else {
      // Migrate the old default display name, but never overwrite a name the
      // user chose themselves.
      const oldDefaultName = workspace.name === '' || workspace.name === '生活';
      if (workspace.is_builtin !== 1 || workspace.path !== realPath || oldDefaultName) {
        this.db
          .prepare(`UPDATE workspaces SET is_builtin = 1, path = ?, name = ? WHERE id = ?`)
          .run(realPath, oldDefaultName ? '个人空间' : workspace.name, workspace.id);
        workspace = this.getWorkspace(workspace.id) as WorkspaceRow;
      }
    }

    let end = this.db
      .prepare(`SELECT * FROM ends WHERE workspace_id = ? AND family = 'life' LIMIT 1`)
      .get(workspace.id) as unknown as EndRow | undefined;
    if (!end) {
      end = this.createEnd({
        workspaceId: workspace.id,
        family: 'life',
        kind: 'life',
        name: '个人空间',
        status: 'active',
      });
    } else {
      if (end.status !== 'active' || end.name === '' || end.name === '生活') {
        this.db
          .prepare(`UPDATE ends SET status = 'active', archived_at = NULL, name = ? WHERE id = ?`)
          .run(end.name === '' || end.name === '生活' ? '个人空间' : end.name, end.id);
        end = this.getEnd(end.id) as EndRow;
      }
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

  /**
   * Append one final message to a session.
   *
   * `attribution` is what makes the room's timeline legible: who said it, which
   * turn/task it answers, and — with `commit` — where it sits on the timeline.
   * Without an attribution (scheduled runs, legacy callers) the row is exactly
   * what it always was.
   */
  addMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    attribution?: {
      agentId?: string | null;
      turnId?: string | null;
      taskId?: string | null;
      /** Assign the next timeline position (a task answer is final on arrival). */
      commit?: boolean;
    },
  ): number | null {
    // Guard against a run that finishes after its session was deleted.
    if (!this.getSession(sessionId)) return null;
    const committedSeq = attribution?.commit ? this.maxCommittedSeq(sessionId) + 1 : null;
    const info = this.db
      .prepare(
        `INSERT INTO messages
           (session_id, role, content, agent_id, turn_id, task_id, committed_seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        role,
        content,
        attribution?.agentId ?? null,
        attribution?.turnId ?? null,
        attribution?.taskId ?? null,
        committedSeq,
        Date.now(),
      );
    return Number(info.lastInsertRowid);
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
    /** The agent that owns this run; defaults to the session leader. */
    agentId?: string | null;
    threadId?: string | null;
    turnId?: string | null;
  }): void {
    const shadow = this.shadowRunAttribution(input.sessionId);
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, runtime, model, model_parameters, status, prompt, attachment_ids, started_at, ended_at, exit_code, error, command_id, task_id, trigger, permission_mode, turn_id, agent_id, thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.turnId ?? null,
        input.agentId ?? shadow.agentId,
        input.threadId ?? shadow.threadId,
      );
  }

  /** Shadow-note the agent/thread a run belongs to. Never throws. */
  private shadowRunAttribution(sessionId: string): { agentId: string | null; threadId: string | null } {
    try {
      const session = this.getSession(sessionId);
      if (!session) return { agentId: null, threadId: null };
      const leader = this.getSessionLeader(sessionId);
      if (!leader) return { agentId: null, threadId: null };
      const thread = this.getAgentThread(sessionId, leader.agent_id);
      return { agentId: leader.agent_id, threadId: thread?.id ?? null };
    } catch {
      // Shadow data must never break run creation.
      return { agentId: null, threadId: null };
    }
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

    const now = Date.now();
    // The process is gone, so every queued/running task is orphaned too. This
    // must run even when no run row survived (a task can die before its driver
    // starts and therefore has no run yet), otherwise roster `taskStatus` and
    // session turns stay busy forever.
    const openTasks = this.db
      .prepare(`SELECT id FROM agent_tasks WHERE status IN ('queued','running')`)
      .all() as unknown as Array<{ id: string }>;
    if (openTasks.length > 0) {
      const failTask = this.db.prepare(
        `UPDATE agent_tasks SET status = 'failed', ended_at = ?, error = ? WHERE id = ?`,
      );
      for (const task of openTasks) failTask.run(now, reason, task.id);
    }
    this.db
      .prepare(`UPDATE session_turns SET status = 'failed', ended_at = ? WHERE status = 'running'`)
      .run(now);

    if (rows.length === 0) return 0;
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

  /** Running runs for one agent in one session (the reset-context busy check). */
  listRunningRunsForAgent(sessionId: string, agentId: string): RunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM runs
         WHERE session_id = ? AND agent_id = ? AND status = 'running'`,
      )
      .all(sessionId, agentId) as unknown as RunRow[];
  }

  listRuns(sessionId: string): RunRow[] {
    return this.db
      // `rowid` breaks the tie between a turn's runs: they are created in the
      // same millisecond, and clients draw the question on the first one.
      .prepare(`SELECT * FROM runs WHERE session_id = ? ORDER BY started_at ASC, rowid ASC`)
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

  /**
   * Append one frame to a run's event log.
   *
   * `sessionId`/`roomSeq` are the room-multiplexed coordinates: one cursor per
   * session over every agent's frames, so a client that reconnects can resume
   * with a single number instead of tracking N run cursors (07-client §1).
   */
  appendEvent(
    runId: string,
    seq: number,
    type: string,
    payload: unknown,
    room?: { sessionId: string; roomSeq: number },
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (run_id, seq, type, payload, session_id, room_seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        seq,
        type,
        JSON.stringify(payload),
        room?.sessionId ?? null,
        room?.roomSeq ?? null,
        Date.now(),
      );
  }

  /**
   * Tag an already-persisted run frame with its room coordinates.
   *
   * `startSessionRun` writes every frame for the per-run replay; the room stream
   * is the same event, so it must *move* that row into the room rather than
   * insert a second copy — otherwise every frame is stored twice and a run
   * replay doubles. Frames with no existing row (session-level notices) are
   * inserted so replay still sees them.
   */
  appendRoomEvent(
    runId: string,
    seq: number,
    type: string,
    payload: unknown,
    sessionId: string,
    roomSeq: number,
  ): void {
    const updated = this.db
      .prepare(`UPDATE events SET session_id = ?, room_seq = ? WHERE run_id = ? AND seq = ?`)
      .run(sessionId, roomSeq, runId, seq);
    if (Number(updated.changes) > 0) return;
    this.appendEvent(runId, seq, type, payload, { sessionId, roomSeq });
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
        `SELECT id, run_id, seq, type, payload, created_at, session_id, room_seq FROM events
         WHERE run_id = ? AND seq > ? AND type != 'thinking_delta'
         ORDER BY seq ASC`,
      )
      .all(runId, afterSeq) as unknown as EventRow[];
  }

  /**
   * Persist a permission's final state on the events that announced it.
   *
   * Replay uses these rows to decide what still needs a human: a
   * `permission_request` keeps its `status`, and a `question` (which never
   * announces a permission_request) gets `answerStatus`, so re-opening a
   * session does not ask a question that is already settled. The update is
   * scoped by run id: `events` is the largest table, and this runs on the
   * blocking approval path.
   */
  updateEventPermissionStatus(runId: string, permissionId: string, status: string): void {
    this.db
      .prepare(
        `UPDATE events SET payload = json_set(payload, '$.status', ?)
         WHERE run_id = ? AND type = 'permission_request'
           AND json_extract(payload, '$.permissionId') = ?`,
      )
      .run(status, runId, permissionId);
    this.db
      .prepare(
        `UPDATE events SET payload = json_set(payload, '$.answerStatus', ?)
         WHERE run_id = ? AND type = 'question'
           AND json_extract(payload, '$.permissionId') = ?`,
      )
      .run(status, runId, permissionId);
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
