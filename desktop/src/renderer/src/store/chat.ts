import { create } from 'zustand';
import { api, connectionApi } from '../ipc/client';
import { apiErrorOf, friendlyMessage } from '../../../shared/errors';
import { applyFrame, buildAssistantFromEvents, finalizeLast, newAssistant } from './chat/applyEvent';
import { dismissPermission, enqueuePermission, setInputError, setSubmitting } from './chat/permissions';
import { emptyChat, emptyPermissions } from './chat/types';
import type { PendingPermission } from './chat/types';
import type { ChatMessage, ChatSessionState, TodoItem } from './chat/types';
import type { ContextUsage } from '../../../shared/format';
import type { RunDto, SseFrame } from '../../../shared/contract';
import type { AttachStreamSpec, ChatStreamSpec, StreamEvent, StreamSpec } from '../../../shared/ipc';
import { useSessions } from './sessions';
import { closePermissionNotification, notifyPermission, notifyRunFinished } from '../notify/notifier';

/**
 * Chat state, keyed by `connectionId::sessionId`. M1 shows one conversation at
 * a time, but the key already carries the connection because retrofitting
 * "two machines on screen" later would otherwise be a rewrite.
 */
export function chatKey(connectionId: string, sessionId: string | null): string {
  return `${connectionId}::${sessionId ?? 'new'}`;
}

let idCounter = 0;
const nextId = (prefix: string): string => `${prefix}${++idCounter}`;

/**
 * Which "what is on screen" request is the current one.
 *
 * Opening a session is async and the rail stays clickable the whole time, so a
 * superseded call has to be stopped before it finishes: it would stamp its
 * (older) history over the newer attempt when both target the same key, and —
 * worse — attach a live stream for a session nobody is looking at. `detach`
 * only ever cancels the *current* chat's stream, so that orphan would run until
 * its run ended by itself.
 *
 * Opening takes a number; every path that changes what is on screen bumps it,
 * which is how "you are stale now" is said.
 */
let openSeq = 0;

/** `Omit` over a union collapses its discriminant, so distribute it by hand. */
type WithoutStreamId<T> = T extends unknown ? Omit<T, 'streamId'> : never;
type StreamRequest = WithoutStreamId<StreamSpec>;

function newStreamId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export interface NewSessionOptions {
  runtime: string | null;
  workspaceId: string | null;
  permissionMode: string;
  /** Resume a Claude Code session that already exists on the daemon's machine. */
  claudeSessionId?: string | null;
  /** Shown until the daemon reports the real title. */
  title?: string | null;
}

interface ChatStore {
  byKey: Record<string, ChatSessionState>;
  /** streamId → chat key, so pushed events can find their conversation. */
  streamKeys: Record<string, string>;
  /** Session ids whose latest run this client watched fail. */
  failedIds: string[];
  activeKey: string | null;

  openSession(connectionId: string, sessionId: string): Promise<void>;
  startNew(connectionId: string, options: NewSessionOptions): void;
  send(text: string): Promise<void>;
  /** Send a picked answer for an `AskUserQuestion` card as a continuation turn. */
  answerQuestion(toolUseId: string, answerText: string): void;
  stop(): void;
  detach(): void;
  leave(): void;
  /** Drop every chat, not just the open one — see the implementation's note. */
  reset(): void;
  decide(decision: 'allow' | 'deny' | 'allow_all', reason?: string, response?: unknown): Promise<void>;
  applyStreamEvent(event: StreamEvent): void;
  setPermissionMode(mode: string): void;
  /** Session id of the chat currently on screen (M1 shows exactly one). */
  activeSessionId(): string | null;
}

export const useChat = create<ChatStore>((set, get) => ({
  byKey: {},
  streamKeys: {},
  failedIds: [],
  activeKey: null,

  async openSession(connectionId, sessionId) {
    // Drop the previous chat's stream first, so its frames cannot land in the
    // conversation we are about to open.
    get().detach();
    const seq = ++openSeq;
    const key = chatKey(connectionId, sessionId);
    set((state) => ({
      activeKey: key,
      byKey: {
        ...state.byKey,
        // `contextUsage` is session-scoped, so opening a session starts it empty
        // and history replay refills it.
        [key]: { ...emptyChat(key, connectionId), sessionId, historyLoading: true },
      },
    }));

    const detail = await api.session(sessionId);
    // A click during that round trip made this call stale: bail before it can
    // write anything, and — the part that actually leaks — before it attaches a
    // stream for a session that is no longer open.
    if (seq !== openSeq) return;
    if (!detail.ok) {
      set((state) => ({
        byKey: patch(state, key, (chat) => ({
          ...chat,
          historyLoading: false,
          error: `加载会话失败（HTTP ${detail.status}）`,
        })),
      }));
      return;
    }

    const { session, runs, messages } = detail.data;
    const rebuilt = await rebuildHistory(runs, session.runningRunId, messages);
    // Rebuilding a long transcript is slow enough to be clicked through too.
    if (seq !== openSeq) return;
    set((state) => ({
      byKey: patch(state, key, (chat) => ({
        ...chat,
        title: session.title,
        cwd: session.cwd,
        runtime: session.runtime,
        permissionMode: session.permissionMode,
        messages: rebuilt.messages,
        runs,
        todos: rebuilt.todos,
        contextUsage: rebuilt.contextUsage,
        historyLoading: false,
      })),
    }));

    if (session.running && session.runningRunId) {
      await attachRun(set, key, connectionId, session.runningRunId);
    }
  },

  startNew(connectionId, options) {
    get().detach();
    // A session opened a moment ago may still be in flight; it must not attach
    // its stream behind this blank one.
    openSeq++;
    const key = chatKey(connectionId, null);
    set((state) => ({
      activeKey: key,
      byKey: {
        ...state.byKey,
        [key]: {
          ...emptyChat(key, connectionId),
          title: options.title ?? null,
          runtime: options.runtime,
          permissionMode: options.permissionMode,
          pendingNew: options,
        },
      },
    }));
  },

  async send(text) {
    const key = get().activeKey;
    if (!key) return;
    const chat = get().byKey[key];
    const prompt = text.trim();
    if (!chat || !prompt || isBusy(chat.phase)) return;

    set((state) => ({
      // A fresh attempt clears the previous failure badge for this session.
      failedIds: chat.sessionId ? state.failedIds.filter((id) => id !== chat.sessionId) : state.failedIds,
      byKey: patch(state, key, (current) => ({
        ...current,
        error: null,
        messages: [
          ...current.messages,
          { kind: 'user', id: nextId('u'), text: prompt },
          newAssistant(nextId('a')),
        ],
      })),
    }));

    // A new session's first prompt is what creates the session server-side.
    const spec: Omit<ChatStreamSpec, 'streamId'> = {
      kind: 'chat',
      connectionId: chat.connectionId,
      sessionId: chat.sessionId,
      prompt,
      runtime: chat.pendingNew?.runtime ?? chat.runtime ?? undefined,
      workspaceId: chat.pendingNew?.workspaceId ?? undefined,
      permissionMode: chat.pendingNew?.permissionMode,
      claudeSessionId: chat.pendingNew?.claudeSessionId ?? undefined,
      // One send = one run. A stable id lets a resend re-attach instead of
      // starting a second run if the response was lost.
      commandId: crypto.randomUUID(),
    };
    await startStream(set, key, spec);
  },

  answerQuestion(toolUseId, answerText) {
    const key = get().activeKey;
    const chat = key ? get().byKey[key] : undefined;
    const text = answerText.trim();
    // The same gate as `send`, checked *before* marking the card answered: if the
    // run were still busy, `send` would drop the text and the card would read
    // "已发送答案" with nothing sent.
    if (!key || !chat || !text || isBusy(chat.phase)) return;

    set((state) => ({
      byKey: patch(state, key, (current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.kind === 'assistant'
            ? {
                ...message,
                blocks: message.blocks.map((block) =>
                  block.kind === 'question' && block.toolUseId === toolUseId
                    ? { ...block, answered: true }
                    : block,
                ),
              }
            : message,
        ),
      })),
    }));
    void get().send(text);
  },

  stop() {
    const key = get().activeKey;
    const chat = key ? get().byKey[key] : undefined;
    if (!key || !chat?.streamId) return;
    const streamId = chat.streamId;
    // `abortRun: true` is the stop button; merely navigating away uses detach().
    void connectionApi.streamCancel({ streamId, abortRun: true });
    set((state) => ({
      byKey: patch(state, key, (current) => ({
        ...current,
        streamId: null,
        runId: null,
        phase: 'idle',
        messages: finalizeLast(current.messages),
        permissions: emptyPermissions(),
      })),
      streamKeys: withoutKey(state.streamKeys, streamId),
    }));
  },

  detach() {
    const key = get().activeKey;
    const chat = key ? get().byKey[key] : undefined;
    if (!key || !chat?.streamId) return;
    const streamId = chat.streamId;
    // Detaching must not kill the run: the daemon keeps it, and re-entering the
    // session re-attaches with `?after=`.
    void connectionApi.streamCancel({ streamId, abortRun: false });
    set((state) => ({
      byKey: patch(state, key, (current) => ({
        ...current,
        streamId: null,
        runId: null,
        phase: 'idle',
        messages: finalizeLast(current.messages),
      })),
      streamKeys: withoutKey(state.streamKeys, streamId),
    }));
  },

  leave() {
    get().detach();
    // Nothing is on screen now, so an in-flight open must not put anything back.
    openSeq++;
    set({ activeKey: null });
  },

  /**
   * Drop every cached chat, not just the open one.
   *
   * Chat keys embed the connection id, so once the target is gone the whole
   * map describes a daemon we can no longer reach. Clearing only `activeKey`
   * is not enough: the shell syncs its rail selection *from* the open chat, so
   * a stale entry would drag the previous host's session back on screen.
   */
  reset() {
    get().detach();
    // The target is gone, so any open still in flight is describing a daemon we
    // have already dropped — it must not attach a stream to it.
    openSeq++;
    set({ byKey: {}, streamKeys: {}, failedIds: [], activeKey: null });
  },

  async decide(decision, reason, response) {
    const key = get().activeKey;
    const chat = key ? get().byKey[key] : undefined;
    const pending = chat?.permissions.active;
    if (!key || !pending) return;

    set((state) => ({
      byKey: patch(state, key, (current) => ({
        ...current,
        permissions: setSubmitting(current.permissions, true),
      })),
    }));

    const res = await api.decidePermission(pending.permissionId, decision, reason, response);
    const { apiCode, message } = apiErrorOf(res.data);

    set((state) => ({
      byKey: patch(state, key, (current) => {
        // A 404/409 means the request is already over (someone else answered, or
        // it timed out) — treat it as resolved rather than showing an error.
        if (res.ok || res.status === 404 || res.status === 409) {
          return {
            ...current,
            permissions: setSubmitting(dismissPermission(current.permissions, pending.permissionId), false),
          };
        }
        if (apiCode === 'bad_response') {
          // Validation failures belong in the dialog, next to the input: a toast
          // would be hidden behind the modal's own scrim.
          return {
            ...current,
            permissions: setSubmitting(
              setInputError(current.permissions, friendlyMessage(apiCode, res.status, message)),
              false,
            ),
          };
        }
        return {
          ...current,
          permissions: setSubmitting(current.permissions, false),
          error: friendlyMessage(apiCode, res.status, message),
        };
      }),
    }));
  },

  setPermissionMode(mode) {
    const key = get().activeKey;
    if (!key) return;
    set((state) => ({ byKey: patch(state, key, (chat) => ({ ...chat, permissionMode: mode })) }));
  },

  applyStreamEvent(event) {
    const key = get().streamKeys[event.streamId];
    if (!key) return;

    if (event.kind === 'phase') {
      set((state) => ({
        byKey: patch(state, key, (chat) => ({ ...chat, phase: phaseOf(event.phase), error: null })),
      }));
      return;
    }

    if (event.kind === 'frames') {
      const before = get().byKey[key]?.permissions.seenIds.length ?? 0;
      set((state) => ({
        byKey: patch(state, key, (chat) => reduceFrames(chat, event.frames)),
      }));

      // `seenIds` only grows for genuinely new *pending* requests, so the tail
      // of it is exactly "what newly needs a human".
      const updated = get().byKey[key];
      if (updated) {
        const session = { id: updated.sessionId, title: updated.title };
        for (const permissionId of updated.permissions.seenIds.slice(before)) {
          const pending = findPending(updated, permissionId);
          if (pending) notifyPermission(pending, session);
        }
        for (const frame of event.frames) {
          const e = frame.event;
          // A decided / timed-out / fanned-out request retracts its notice.
          if (e.type === 'permission_request' && e.status !== 'pending') {
            closePermissionNotification(e.permissionId);
          }
        }
      }
      return;
    }

    const runIdBeforeClose = get().byKey[key]?.runId ?? null;
    set((state) => ({
      byKey: patch(state, key, (current) => {
        const closed = { ...current, streamId: null, runId: null };
        const settled = { ...closed, messages: finalizeLast(current.messages), permissions: emptyPermissions() };
        switch (event.outcome) {
          case 'finished':
            return { ...settled, phase: 'idle' };
          case 'settled':
            // The run left the daemon; its tail was backfilled by the streamer.
            return { ...settled, phase: 'settled' };
          case 'cancelled':
            return { ...settled, phase: 'idle' };
          case 'giveup':
            return {
              ...settled,
              phase: 'gaveup',
              error: friendlyMessage(event.apiCode, event.httpCode, event.message ?? '连接已断开'),
            };
        }
      }),
      streamKeys: withoutKey(state.streamKeys, event.streamId),
    }));

    // The rail carries `running` and the title, both of which just changed.
    const chat = get().byKey[key];
    if (chat) {
      const failed = event.outcome === 'giveup' || chat.error !== null;
      if (chat.sessionId) {
        const id = chat.sessionId;
        set((state) => ({
          failedIds: failed
            ? state.failedIds.includes(id) ? state.failedIds : [...state.failedIds, id]
            : state.failedIds.filter((value) => value !== id),
        }));
      }
      if (event.outcome !== 'cancelled') {
        notifyRunFinished(event.outcome, runIdBeforeClose, { id: chat.sessionId, title: chat.title }, chat.error);
      }
      // Refresh the batch the rail is showing (running/title just changed).
      // `refreshCurrent` re-reads the workspace it is displaying — asking with no
      // workspace would pull *every* workspace's sessions into the rail.
      void useSessions.getState().refreshCurrent(chat.connectionId);
    }
  },

  activeSessionId() {
    const key = get().activeKey;
    return key ? (get().byKey[key]?.sessionId ?? null) : null;
  },
}));

function findPending(chat: ChatSessionState, permissionId: string): PendingPermission | null {
  if (chat.permissions.active?.permissionId === permissionId) return chat.permissions.active;
  return chat.permissions.queue.find((item) => item.permissionId === permissionId) ?? null;
}

function phaseOf(phase: string): ChatPhaseValue {
  return phase === 'live' ? 'live' : phase === 'reconnecting' ? 'reconnecting' : 'connecting';
}
type ChatPhaseValue = ChatSessionState['phase'];

async function attachRun(set: SetState, key: string, connectionId: string, runId: string): Promise<void> {
  set((state) => ({
    byKey: patch(state, key, (chat) => {
      const last = chat.messages[chat.messages.length - 1];
      if (last?.kind === 'assistant' && !last.done) return chat;
      return { ...chat, messages: [...chat.messages, newAssistant(nextId('a'))] };
    }),
  }));
  const attach: Omit<AttachStreamSpec, 'streamId'> = { kind: 'attach', connectionId, runId, after: null };
  await startStream(set, key, attach);
}

/**
 * Open a stream and route its events to `key`.
 *
 * The id is minted here and registered **before** the request goes out. Main
 * starts pushing events as soon as the stream is open, and a short run can be
 * over before this call returns — registering afterwards silently dropped the
 * whole run (a one-word reply showed up as an empty message).
 */
async function startStream(set: SetState, key: string, spec: StreamRequest): Promise<void> {
  const streamId = newStreamId();
  set((state) => ({
    streamKeys: { ...state.streamKeys, [streamId]: key },
    byKey: patch(state, key, (chat) => ({ ...chat, streamId, phase: 'connecting', error: null })),
  }));

  const request: StreamSpec =
    spec.kind === 'chat' ? { ...spec, streamId } : { ...spec, streamId };

  const result = await connectionApi.streamStart(request);
  if (!result.ok) {
    const message = friendlyMessage(result.apiCode, result.httpCode, result.message);
    set((state) => ({
      streamKeys: withoutKey(state.streamKeys, streamId),
      byKey: patch(state, key, (chat) => ({
        ...chat,
        streamId: null,
        phase: 'gaveup',
        messages: finalizeLast(chat.messages),
        error: message,
      })),
    }));
  }
}

/** Fold a batch of frames into one chat. */
function reduceFrames(chat: ChatSessionState, frames: SseFrame[]): ChatSessionState {
  let messages = chat.messages;
  let todos = chat.todos;
  let contextUsage = chat.contextUsage;
  let permissions = chat.permissions;
  let runId = chat.runId;
  let sessionId = chat.sessionId;
  let runtime = chat.runtime;
  let pendingNew = chat.pendingNew;
  let title = chat.title;

  for (const frame of frames) {
    if (frame.runId) runId = frame.runId;
    const event = frame.event;

    if (event.type === 'permission_request') {
      // Approvals are state, not transcript.
      permissions = enqueuePermission(permissions, {
        permissionId: event.permissionId,
        runId: frame.runId,
        toolName: event.toolName,
        toolInput: event.toolInput,
        status: event.status,
      });
      continue;
    }

    if (event.type === 'status') {
      if (event.runtime) runtime = event.runtime;
      if (event.sessionId && !sessionId) {
        sessionId = event.sessionId;
        // The session now exists server-side; stop sending creation params.
        pendingNew = null;
        if (!title) title = null;
      }
    }

    const next = applyFrame(
      { messages, todos, contextUsage, terminal: false, terminalSucceeded: false },
      frame,
      () => nextId('a'),
    );
    messages = next.messages;
    todos = next.todos;
    contextUsage = next.contextUsage;
  }

  // A fresh send's user message has no run id until the stream tells us; stamp
  // it so its per-message rollback action appears while the run is live.
  if (runId) {
    let lastUser = -1;
    for (let i = 0; i < messages.length; i += 1) {
      if (messages[i]?.kind === 'user') lastUser = i;
    }
    const message = lastUser >= 0 ? messages[lastUser] : undefined;
    if (message?.kind === 'user' && !message.runId) {
      messages = messages.map((entry, i) => (i === lastUser ? { ...entry, runId } : entry));
    }
  }

  return { ...chat, messages, todos, contextUsage, permissions, runId, sessionId, runtime, pendingNew, title };
}

interface RebuiltHistory {
  messages: ChatMessage[];
  todos: TodoItem[];
  contextUsage: ContextUsage | null;
}

/**
 * Rebuild a transcript from runs and their per-run event replays, rather than
 * from the aggregated `messages` (which has no tool cards, thinking or usage).
 * Replays are independent, so they are fetched with a small concurrency limit
 * and assembled in run order.
 */
async function rebuildHistory(
  runs: RunDto[],
  runningRunId: string | null,
  rawMessages: unknown[],
): Promise<RebuiltHistory> {
  const fetched = await mapLimit(runs, 4, async (run) =>
    run.id === runningRunId ? null : await api.runEvents(run.id),
  );

  const messages: ChatMessage[] = [];
  let contextUsage: ContextUsage | null = null;
  let todos: TodoItem[] = [];

  runs.forEach((run, index) => {
    messages.push({ kind: 'user', id: nextId('u'), text: run.prompt, runId: run.id });
    const response = fetched[index];
    if (!response) {
      // Still running: attach() will fill and continue this one.
      messages.push(newAssistant(nextId('a')));
      return;
    }
    const events = response.ok ? response.data.events : [];
    const rebuilt = buildAssistantFromEvents(events, () => nextId('a'));
    messages.push(rebuilt.assistant);
    if (rebuilt.contextUsage) contextUsage = rebuilt.contextUsage;
    if (rebuilt.todos.length) todos = rebuilt.todos;
  });

  // Legacy sessions predate per-run events; fall back to the aggregated rows.
  // These are raw snake_case DB rows — the one place the contract lies.
  if (messages.length === 0) {
    for (const raw of rawMessages) {
      const row = raw as { role?: unknown; content?: unknown };
      if (typeof row?.content !== 'string') continue;
      if (row.role === 'user') {
        messages.push({ kind: 'user', id: nextId('u'), text: row.content });
      } else {
        messages.push({
          kind: 'assistant',
          id: nextId('a'),
          blocks: [{ kind: 'text', text: row.content }],
          usage: null,
          error: null,
          done: true,
        });
      }
    }
  }

  return { messages, todos, contextUsage };
}

type SetState = (updater: (state: ChatStore) => Partial<ChatStore>) => void;

function patch(
  state: ChatStore,
  key: string,
  fn: (chat: ChatSessionState) => ChatSessionState,
): Record<string, ChatSessionState> {
  const chat = state.byKey[key];
  if (!chat) return state.byKey;
  return { ...state.byKey, [key]: fn(chat) };
}

function withoutKey(map: Record<string, string>, key: string): Record<string, string> {
  const next = { ...map };
  delete next[key];
  return next;
}

export function isBusy(phase: ChatSessionState['phase']): boolean {
  return phase === 'connecting' || phase === 'live' || phase === 'reconnecting';
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}
