import type { ContextUsage } from '../../../../shared/format';
import type { PermissionStatus, QuestionDto, RunDto } from '../../../../shared/contract';

/** One ordered piece of an assistant turn, in the order the runtime produced it. */
export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
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
  | { kind: 'question'; toolUseId: string; questions: QuestionDto[]; answered: boolean };

export interface UsageInfo {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export type ChatMessage =
  | { kind: 'user'; id: string; text: string; runId?: string }
  | {
      kind: 'assistant';
      id: string;
      blocks: ContentBlock[];
      usage: UsageInfo | null;
      error: string | null;
      done: boolean;
    };

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
  title: string | null;
  cwd: string | null;
  runtime: string | null;
  permissionMode: string | null;
  messages: ChatMessage[];
  /** The session's runs, newest last — each carries its checkpoint (or null). */
  runs: RunDto[];
  runId: string | null;
  streamId: string | null;
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
    claudeSessionId?: string | null;
    title?: string | null;
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
    title: null,
    cwd: null,
    runtime: null,
    permissionMode: null,
    messages: [],
    runs: [],
    runId: null,
    streamId: null,
    phase: 'idle',
    error: null,
    historyLoading: false,
    contextUsage: null,
    todos: [],
    permissions: emptyPermissions(),
    pendingNew: null,
  };
}
