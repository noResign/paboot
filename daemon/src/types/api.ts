/**
 * Transport-level contract types. These are the shapes that leave the daemon
 * over HTTP/SSE (and, later, to the Android/iOS client). They intentionally
 * mirror the "contracts" layer of the reference project so a future client
 * package can import them without pulling in Node/Express types.
 *
 * `NormalizedEvent` is the canonical runtime event stream: every runtime
 * adapter (Claude Code today, others later) is translated into this union by
 * its stream parser, so the transport never needs to know runtime-specific
 * wire formats.
 *
 * Stream invariant: every `tool_use` is followed by a matching `tool_result`
 * before the run's terminal `status`. A run can end while a tool is still in
 * flight (cancel, crash, idle timeout), in which case the engine synthesizes
 * the missing result with `interrupted: true` — clients can therefore treat a
 * `tool_use` without a result as "still running" and nothing else.
 */
/**
 * `GET /api/health` — the unauthenticated readiness/discovery signal, and the
 * only place a client can learn `serverId`.
 */
export interface HealthDto {
  ok: boolean;
  service: string;
  version: string;
  workspace: string | null;
  /**
   * This daemon's stable identity (minted once, kept in its DB). It is what lets
   * a client tell that two addresses — `127.0.0.1:4780` and a LAN IP, a tunnel
   * later — are the *same* daemon rather than two hosts.
   *
   * Optional on purpose: an older daemon does not send it, and clients must read
   * "absent" as *unknown*, never as "a different daemon".
   */
  serverId?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionDto {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

export type NormalizedEvent =
  | {
      type: 'status';
      label: string;
      model?: string | null;
      sessionId?: string | null;
      runtime?: string;
      ttftMs?: number;
      terminal?: boolean;
    }
  | { type: 'text_delta'; delta: string }
  /**
   * Legacy: parsers still emit it, but the run service drops it before
   * persistence/broadcast. Kept in the union so old events and older clients
   * stay decodable; clients drive the "thinking" indicator from
   * `thinking_start` instead of rendering this content.
   */
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  /**
   * `interrupted` marks a result the daemon synthesized because the run ended
   * with the tool still in flight; the runtime never reported one.
   */
  | { type: 'tool_result'; toolUseId?: string; content: string; isError?: boolean; interrupted?: boolean }
  | {
      type: 'usage';
      usage: unknown;
      costUsd?: number | null;
      durationMs?: number | null;
      stopReason?: string | null;
      isError?: boolean;
      /**
       * How full the context window is right now: the input side of this
       * session's most recent model request, i.e. the number that decides
       * whether the next call triggers compaction.
       *
       * Distinct from `usage` (a monotonically growing per-run total) because
       * this is instantaneous state that can go *down* after a compaction, so
       * it rides alongside the blob rather than inside it. Absent = this frame
       * carries no such information (clients keep the last known value).
       */
      contextTokens?: number | null;
      /**
       * The model's context window capacity, for the denominator. `null` means
       * "occupied is known, capacity is not" — Claude Code never reports it, and
       * guessing a window would show a wrong percentage.
       */
      contextWindow?: number | null;
    }
  | { type: 'turn_end'; stopReason: string }
  | { type: 'error'; code?: string; message: string; terminal?: boolean }
  | {
      type: 'permission_request';
      permissionId: string;
      toolName: string;
      toolInput: unknown;
      status: PermissionStatus;
    }
  | { type: 'question'; toolUseId: string; questions: QuestionDto[] };

export interface ApiError {
  error: string;
  code?: string;
  message?: string;
}

export type ProductPermissionMode = 'ask' | 'acceptEdits' | 'bypass';

export interface SessionDto {
  id: string;
  runtime: string;
  workspaceId: string | null;
  permissionMode: ProductPermissionMode;
  /** Explicit model chosen at creation; `null` means the runtime default. */
  model: string | null;
  /** Generic per-model knobs (e.g. `{reasoningEffort: "high"}`); `null` = defaults. */
  modelParameters: Record<string, string> | null;
  cwd: string;
  title: string | null;
  createdAt: number;
  lastActiveAt: number;
  /** Whether this session has a run in flight right now. */
  running: boolean;
  /** The id of the in-flight run, when `running` is true. */
  runningRunId: string | null;
  /** Scheduled tasks bound to this session (0 for older daemons). */
  scheduledTaskCount?: number;
  /** `task_config` for the reusable AI authoring chat; null otherwise. */
  purpose?: string | null;
}

export interface WorkspaceDto {
  id: string;
  name: string;
  /** Primary dir; also the spawn cwd of a new session. */
  path: string;
  /**
   * Extra dirs granted to this workspace (agent may read/write there, and every
   * session in the workspace inherits them). Grown by Read/Grep approvals or
   * edited from the workspace management page.
   */
  dirs: string[];
  /**
   * Browse-only bookmarks for the file tab. Unlike `dirs` these grant the agent
   * nothing — they only add a switchable tab, and are stored separately so the
   * two can never be confused.
   */
  shortcutDirs: string[];
  isDefault: boolean;
  /** The built-in fallback root. It is visible only while it is the only workspace. */
  isBuiltin: boolean;
  enabled: boolean;
  sessionCount: number;
  createdAt: number;
  lastUsedAt: number;
}

export interface PermissionGrantDto {
  toolName: string;
  createdAt: number;
}

/** Per-run workspace checkpoint. `status`: complete | unavailable | rolled_back. */
export interface RunCheckpointDto {
  status: string;
  repoRoot: string;
  preRef: string | null;
  postRef: string | null;
}

export interface RunDto {
  id: string;
  sessionId: string;
  workspaceId: string | null;
  runtime: string;
  model: string | null;
  modelParameters: Record<string, string> | null;
  status: string;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  error: string | null;
  /** Set when the run was triggered by a scheduled task. */
  taskId?: string | null;
  /** How the run was started; older daemons omit it. */
  trigger?: 'user' | 'scheduled' | 'run_now';
  /** Permission mode actually used for this run (bypass for scheduled runs). */
  permissionMode?: string | null;
  /** Command tasks: aggregated stdout/stderr (tail-capped) for the detail view. */
  output?: string | null;
  /** Present when the run's repo could be snapshotted; lets clients diff/roll back. */
  checkpoint?: RunCheckpointDto | null;
}

/** `POST /api/runs/:id/rollback` response. */
export interface RunRollbackResponse {
  ok: boolean;
  rolledBackRuns: number;
  /** The file tree rewound; the agent's conversation did not. */
  conversationRewound: false;
}

/** ---- deploy ---- */

export type DeployChannel = 'alpha' | 'prod';

export type DeployTarget = 'auto' | 'daemon' | 'android' | 'desktop' | 'all';

export type DeployJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface DeployJobDto {
  id: string;
  channel: DeployChannel;
  target: DeployTarget;
  status: DeployJobStatus;
  /** systemd transient unit name, e.g. paboot-deploy-... */
  unit: string;
  /** server-side log file path */
  logPath: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  error: string | null;
}

export interface DeployRequest {
  channel: DeployChannel | 'test';
  target?: DeployTarget;
}

/** One SSE frame: `{ runId, seq, event }`. `seq` is the resume cursor. */
export interface SseFrame {
  runId: string;
  seq: number;
  event: NormalizedEvent;
}

export type PermissionDecision = 'allow' | 'deny';

/** UserInput uses the permission queue for pending/resolved lifecycle only.
 * Its toolInput has kind: questions|form|url|unsupported and provider fields.
 * Answers are returned directly to the provider; never persisted in SSE/history. */
export interface PermissionDecisionRequest {
  decision: PermissionDecision | 'allow_all';
  reason?: string;
  response?: unknown;
}

export type PermissionStatus = 'pending' | 'allowed' | 'denied' | 'timed_out';

export interface PermissionDto {
  id: string;
  runId: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  status: PermissionStatus;
  decisionReason: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface ChangedFileDto {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  staged: boolean;
  binary: boolean;
  isDirectory: boolean;
  additions: number | null;
  deletions: number | null;
}

export interface ChangesResponse {
  workspaceId: string;
  /** The workspace's primary dir, for display. */
  workspacePath: string;
  /** Directory tree actually inspected; equals `workspacePath` unless `root` was passed. */
  root: string;
  /** Every root of this workspace (primary first, then extra dirs); see `FilesResponse.roots`. */
  roots: string[];
  /** Browse-only bookmarks; not roots, grant nothing. See `WorkspaceDto.shortcutDirs`. */
  shortcutDirs: string[];
  /** Set when the request was scoped to a run's `pre..post` checkpoint diff. */
  runId?: string;
  isGitRepo: boolean;
  gitRoot: string | null;
  /** Git repos among `dir`'s direct children; only filled when `isGitRepo` is false. */
  repos: string[];
  files: ChangedFileDto[];
}

export interface DiffResponse {
  /** Directory tree the paths are relative to. */
  root: string;
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  binary: boolean;
  truncated: boolean;
  patch: string;
}

export type FileEntryType = 'file' | 'directory';

export interface FileEntryDto {
  name: string;
  path: string;
  type: FileEntryType;
  size: number | null;
  modifiedAt: number | null;
}

export interface FilesResponse {
  workspaceId: string;
  /** The workspace's primary dir, for display. */
  workspacePath: string;
  /** Directory tree actually listed; equals `workspacePath` unless `root` was passed. */
  root: string;
  /**
   * Every root of this workspace (primary first, then extra dirs). Echoed so a
   * client that renders a root switcher can refresh it alongside the listing it
   * already fetched, instead of polling workspace state on its own schedule.
   */
  roots: string[];
  /** Browse-only bookmarks; not roots, grant nothing. See `WorkspaceDto.shortcutDirs`. */
  shortcutDirs: string[];
  path: string;
  /**
   * Parent directory relative to `root`. `null` only when `path` is the root
   * itself; an empty string means the parent is the root (a top-level directory).
   */
  parent: string | null;
  entries: FileEntryDto[];
  nextCursor: string | null;
}

export interface FileContentDto {
  /** Directory tree this path is relative to. */
  root: string;
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string;
}

/** ---- scheduled tasks ---- */

export type ScheduledTaskType = 'ai' | 'command';

export type ScheduledTaskSessionMode = 'existing' | 'new' | 'internal';

export type ScheduledTaskLastStatus =
  | 'never'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'skipped_busy'
  | 'skipped_missed';

export type SchedulePresetKind = 'daily' | 'weekdays' | 'weekly' | 'every_minutes' | 'every_hours';

/**
 * A structured preset as entered in a client. The daemon converts it to a cron
 * expression; clients never have to build cron strings themselves.
 */
export interface SchedulePresetInput {
  preset: SchedulePresetKind;
  /** `HH:MM` for daily/weekdays/weekly. */
  time?: string;
  /** Weekdays 0–6 (Sunday = 0) for weekly. */
  days?: number[];
  /** N for every_minutes / every_hours. */
  every?: number;
  /** IANA zone; defaults to the daemon's local zone. */
  timezone?: string;
}

/** Advanced callers (API/MCP) may provide a 5-field cron expression directly. */
export interface ScheduleCronInput {
  cron: string;
  timezone?: string;
}

export type ScheduleInput = SchedulePresetInput | ScheduleCronInput;

export interface ScheduleDto {
  cron: string;
  timezone: string;
  /** Present when the task was created from a structured preset. */
  preset: SchedulePresetInput | null;
  /** Human-readable summary generated by the daemon. */
  label: string;
}

export interface ScheduledTaskDto {
  id: string;
  name: string;
  type: ScheduledTaskType;
  sessionMode: ScheduledTaskSessionMode;
  sessionId: string | null;
  sessionTitle: string | null;
  workspaceId: string;
  runtime: string;
  prompt: string | null;
  command: string | null;
  permissionMode: string;
  schedule: ScheduleDto;
  nextRunAt: number | null;
  lastFireAt: number | null;
  lastRunAt: number | null;
  lastStatus: ScheduledTaskLastStatus;
  lastError: string | null;
  lastRunId: string | null;
  runCount: number;
  enabled: boolean;
  disabledReason: string | null;
  createdBy: 'user' | 'mcp';
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledTasksResponse {
  tasks: ScheduledTaskDto[];
}

export interface ScheduledTaskDetailResponse {
  task: ScheduledTaskDto;
  runs: RunDto[];
}

export type ScheduledTaskTargetInput =
  | { mode: 'existing'; sessionId: string }
  | { mode: 'new'; workspaceId: string; runtime?: string; model?: string | null }
  | { mode: 'workspace'; workspaceId: string };

export interface CreateScheduledTaskRequest {
  name: string;
  type: ScheduledTaskType;
  prompt?: string;
  command?: string;
  target: ScheduledTaskTargetInput;
  schedule: ScheduleInput;
}

export interface UpdateScheduledTaskRequest {
  name?: string;
  prompt?: string;
  command?: string;
  schedule?: ScheduleInput;
  enabled?: boolean;
  target?: { mode: 'existing'; sessionId: string } | { mode: 'new' };
}

export interface RunNowResponse {
  ok: boolean;
  runId: string;
  sessionId: string;
}

/** `POST /api/scheduled-tasks/config-session` — the reusable AI authoring chat. */
export interface TaskConfigSessionResponse {
  ok: boolean;
  sessionId: string;
  /** The run that just started; absent when the session already had one. */
  runId: string | null;
  /** True when an existing run was already active, so no new prompt was sent. */
  busy: boolean;
}
