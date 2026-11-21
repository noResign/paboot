import type { ContextUsage } from '../../../../shared/format';
import type { PermissionStatus, QuestionDto, RunDto } from '../../../../shared/contract';

/** One ordered piece of an assistant turn, in the order the runtime produced it. */
export type ContentBlock =
  | { kind: 'text'; text: string }
  /** Thinking card: content is never sent, so it only carries its live state. */
  | { kind: 'thinking'; active: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      result: string | null;
      isError: boolean;
      /** The run ended with the tool in flight — distinct from "failed". */
      interrupted: boolean;
      running: boolean;
    }
  | {
      kind: 'question';
      toolUseId: string;
      questions: QuestionDto[];
      answered: boolean;
      /** Builtin blocking question: answer through the permission endpoint. */
      permissionId?: string | null;
    }
  /** System notice (auto-compaction); not model output. */
  | { kind: 'notice'; text: string };

export interface UsageInfo {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export type ChatMessage =
  /** `at` is the send time (epoch ms); absent on pre-timestamp histories. */
  | {
      kind: 'user';
      id: string;
      text: string;
      runId?: string;
      at?: number;
      attachmentIds?: string[];
    }
  | {
      kind: 'assistant';
      id: string;
      blocks: ContentBlock[];
      usage: UsageInfo | null;
      error: string | null;
      done: boolean;
      /** Which run produced this answer; room frames route by it. */
      runId?: string | null;
      /**
       * 谁说的。null / undefined = 未知（老 daemon 历史，或单聊里唯一的那个）。
       *
       * 群聊里靠它区分发言人 —— 一条时间线，不分栏也不分标签页：切开会打断
       * 「A 说完 B 接话」的因果。
       */
      agentId?: string | null;
      /** 显示名；由成员名册解析，避免每条消息各带一份。 */
      agentName?: string | null;
    };

/** A room answer that has not committed yet — shown above the composer. */
export interface PendingAnswer {
  runId: string;
  agentId: string | null;
  message: Extract<ChatMessage, { kind: 'assistant' }>;
}

export interface TodoItem {
  content: string;
  status: string;
}

/**
 * A pending approval, as it arrives in the run's frame stream. Deliberately not
 * `PermissionDto`: the frame carries only these fields, and `runId` is the one
 * the client needs to answer on.
 */
export interface PendingPermission {
  permissionId: string;
  runId: string;
  toolName: string;
  toolInput: unknown;
  status: PermissionStatus;
}

export interface PermissionState {
  active: PendingPermission | null;
  queue: PendingPermission[];
  /** Ids ever seen for this stream — how we dedupe replays after a reconnect. */
  seenIds: string[];
  submitting: boolean;
  /** `bad_response` belongs to the current popup and must not follow the next. */
  inputError: string | null;
}

export type ChatPhase = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'settled' | 'gaveup';

export interface ChatSessionState {
  key: string;
  /** Which daemon this chat belongs to — half of the state key. */
  connectionId: string;
  sessionId: string | null;
  /** The workspace the session belongs to; `@` candidates come from here. */
  workspaceId: string | null;
  title: string | null;
  /** Server-side recency, used to notice runs finished while disconnected. */
  lastActiveAt: number | null;
  cwd: string | null;
  runtime: string | null;
  permissionMode: string | null;
  /** Memory capture/injection mode; null = older daemon / unknown. */
  memoryMode?: 'normal' | 'no_injection' | 'off' | null;
  /** Explicit model for subsequent runs; null = the machine's CLI default. */
  model: string | null;
  /** Generic model knobs (e.g. reasoningEffort); empty = defaults. */
  modelParameters: Record<string, string>;
  messages: ChatMessage[];
  /**
   * Answers still being produced by a room run.
   *
   * They are deliberately **not** in `messages`: the timeline is commit-order
   * only. A card moves in when its run reaches a terminal state, so it can
   * never be reshuffled by a slower sibling. Key = run id.
   */
  pendingAnswers: PendingAnswer[];
  /** The session's runs, newest last — each carries its checkpoint (or null). */
  runs: RunDto[];
  runId: string | null;
  /** The open run stream, if this chat is attached to one. */
  streamId: string | null;
  /** The session watch (`/api/sessions/:id/events`), independent of any run. */
  sessionStreamId: string | null;
  /** The room stream (`/api/sessions/:id/stream`) for a multi-agent session. */
  roomStreamId: string | null;
  /** Last room position applied; a re-opened room resumes after it. */
  roomCursor: number | null;
  phase: ChatPhase;
  error: string | null;
  historyLoading: boolean;
  /** Session-level occupancy; reset on session switch, never on reconnect. */
  contextUsage: ContextUsage | null;
  todos: TodoItem[];
  permissions: PermissionState;
  /** Non-null while this is a new session that `POST /api/chat` has yet to create. */
  pendingNew: {
    runtime: string | null;
    workspaceId: string | null;
    permissionMode: string;
  } | null;
}

export function emptyPermissions(): PermissionState {
  return { active: null, queue: [], seenIds: [], submitting: false, inputError: null };
}

export function emptyChat(key: string, connectionId: string): ChatSessionState {
  return {
    key,
    connectionId,
    sessionId: null,
    workspaceId: null,
    title: null,
    lastActiveAt: null,
    cwd: null,
    runtime: null,
    permissionMode: null,
    model: null,
    modelParameters: {},
    messages: [],
    pendingAnswers: [],
    runs: [],
    runId: null,
    streamId: null,
    sessionStreamId: null,
    roomStreamId: null,
    roomCursor: null,
    phase: 'idle',
    error: null,
    historyLoading: false,
    contextUsage: null,
    todos: [],
    permissions: emptyPermissions(),
    pendingNew: null,
  };
}
