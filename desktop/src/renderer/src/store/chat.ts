import { create } from 'zustand';
import { api, connectionApi } from '../ipc/client';
import { apiErrorOf, friendlyMessage } from '../../../shared/errors';
import { applyFrame, buildAssistantFromEvents, finalizeLast, newAssistant } from './chat/applyEvent';
import { dismissPermission, enqueuePermission, setInputError, setSubmitting } from './chat/permissions';
import { emptyChat, emptyPermissions } from './chat/types';
import type { PendingPermission } from './chat/types';
import type { ChatMessage, ChatSessionState, TodoItem } from './chat/types';
import type { ContextUsage } from '../../../shared/format';
import type { RunDto, SessionEvent, SessionRunBrief, SseFrame } from '../../../shared/contract';
import type {
  AttachStreamSpec,
  ChatStreamSpec,
  RoomStreamSpec,
  SessionStreamSpec,
  StreamEvent,
  StreamSpec,
} from '../../../shared/ipc';
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
}

interface ChatStore {
  byKey: Record<string, ChatSessionState>;
  /** streamId → chat key, so pushed events can find their conversation. */
  streamKeys: Record<string, string>;
  /** Session ids whose latest run this client watched fail. */
  failedIds: string[];
  activeKey: string | null;

  openSession(connectionId: string, sessionId: string): Promise<void>;
  /** Rename in place: the rail and the open header read different stores. */
  patchTitle(connectionId: string, sessionId: string, title: string): void;
  startNew(connectionId: string, options: NewSessionOptions): void;
  send(text: string, attachmentIds?: string[]): Promise<void>;
  /**
   * One input addressed to several agents (`POST /turns`). The answers arrive
   * on the room stream, not on this promise.
   */
  sendTurn(text: string, mentionIds: string[]): Promise<void>;
  /** Open the room stream for the current multi-agent session (idempotent). */
  ensureRoomStream(): Promise<void>;
  /** Close it when the session drops back to a single assistant. */
  closeRoomStream(): void;
  /**
   * Answer an `AskUserQuestion` card. Blocking questions (builtin / Codex) send
   * the structured `answers` through the permission endpoint; the Claude path
   * sends the composed text as a continuation turn.
   */
  answerQuestion(
    toolUseId: string,
    answerText: string,
    answers?: Record<string, string[]>,
  ): void;
  stop(): void;
  detach(): void;
  leave(): void;
  /** Drop every chat, not just the open one — see the implementation's note. */
  reset(): void;
  decide(decision: 'allow' | 'deny' | 'allow_all', reason?: string, response?: unknown): Promise<void>;
  applyStreamEvent(event: StreamEvent): void;
  setPermissionMode(mode: string): void;
  /** Dismiss the current chat's transient error banner. */
  clearError(): void;
  /**
   * Re-read the session from the daemon.
   *
   * Used after a change that the session row reflects (e.g. handing the room to
   * another agent changes `runtime`): the transcript is untouched, only the
   * header fields move.
   */
  syncSession(): void;
  /** Persist the session memory mode (`normal` | `no_injection` | `off`). */
  setMemoryMode(mode: 'normal' | 'no_injection' | 'off'): Promise<void>;
  /** Persist a model/parameter switch on the daemon; it applies from the next run. */
  setSessionSelection(model: string | null, modelParameters: Record<string, string>): Promise<void>;
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
        workspaceId: session.workspaceId ?? null,
        lastActiveAt: session.lastActiveAt,
        cwd: session.cwd,
        runtime: session.runtime,
        permissionMode: session.permissionMode,
        memoryMode: session.memoryMode ?? 'normal',
        model: session.model,
        modelParameters: session.modelParameters ?? {},
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
    // Watch the session for work started elsewhere; it outlives individual runs.
    if (seq === openSeq) {
      await startSessionWatch(set, key, connectionId, sessionId);
    }
  },

  patchTitle(connectionId, sessionId, title) {
    const key = chatKey(connectionId, sessionId);
    set((state) => ({ byKey: patch(state, key, (chat) => ({ ...chat, title })) }));
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
          runtime: options.runtime,
          permissionMode: options.permissionMode,
          workspaceId: options.workspaceId,
          pendingNew: options,
        },
      },
    }));
  },

  async send(text, attachmentIds = []) {
    const key = get().activeKey;
    if (!key) return;
    const chat = get().byKey[key];
    const prompt = text.trim() || (attachmentIds.length > 0 ? '请查看这些图片。' : '');
    if (!chat || !prompt || isBusy(chat.phase)) return;

    set((state) => ({
      // A fresh attempt clears the previous failure badge for this session.
      failedIds: chat.sessionId ? state.failedIds.filter((id) => id !== chat.sessionId) : state.failedIds,
      byKey: patch(state, key, (current) => ({
        ...current,
        error: null,
        messages: [
          ...current.messages,
          {
            kind: 'user',
            id: nextId('u'),
            text: prompt,
            at: Date.now(),
            ...(attachmentIds.length ? { attachmentIds } : {}),
          },
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
      ...(attachmentIds.length ? { attachmentIds } : {}),
      runtime: chat.pendingNew?.runtime ?? chat.runtime ?? undefined,
      workspaceId: chat.pendingNew?.workspaceId ?? undefined,
      permissionMode: chat.pendingNew?.permissionMode,
      // The chat page exposes the model picker before the session exists; the
      // choice only has somewhere to live once the daemon creates it.
      ...(chat.pendingNew
        ? {
            model: chat.model,
            modelParameters: Object.keys(chat.modelParameters).length ? chat.modelParameters : null,
          }
        : {}),
      // One send = one run. A stable id lets a resend re-attach instead of
      // starting a second run if the response was lost.
      commandId: crypto.randomUUID(),
    };
    await startStream(set, key, spec);
  },

  async sendTurn(text, mentionIds) {
    const key = get().activeKey;
    const chat = key ? get().byKey[key] : undefined;
    const prompt = text.trim();
    if (!key || !chat?.sessionId || !prompt) return;

    set((state) => ({
      byKey: patch(state, key, (current) => ({
        ...current,
        error: null,
        messages: [
          ...current.messages,
          { kind: 'user', id: nextId('u'), text: prompt, at: Date.now() },
        ],
      })),
    }));

    // The daemon broadcasts answers on the room stream; make sure it is open
    // before the first task can produce a frame.
    await get().ensureRoomStream();

    const res = await api.sendTurn(chat.sessionId, prompt, mentionIds);
    if (res.ok) return;
    const { apiCode, message } = apiErrorOf(res.data);
    set((state) => ({
      byKey: patch(state, key, (current) => ({
        ...current,
        error: friendlyMessage(apiCode, res.status, message, '发送失败'),
      })),
    }));
  },

  async ensureRoomStream() {
    const key = get().activeKey;
    const chat = key ? get().byKey[key] : undefined;
    if (!key || !chat?.sessionId || chat.roomStreamId) return;

    // The room stream already carries every run's frames. A per-run stream left
    // from `/api/chat` would feed the same answer a second time (and to a card
    // the room reducer cannot match), so hand the session over to the room.
    const runStreamId = chat.streamId;
    if (runStreamId) void connectionApi.streamCancel({ streamId: runStreamId, abortRun: false });

    const streamId = newStreamId();
    set((state) => ({
      streamKeys: {
        ...(runStreamId ? withoutKey(state.streamKeys, runStreamId) : state.streamKeys),
        [streamId]: key,
      },
      byKey: patch(state, key, (current) => ({
        ...current,
        roomStreamId: streamId,
        streamId: null,
        runId: null,
        phase: current.phase === 'settled' || current.phase === 'gaveup' ? current.phase : 'idle',
      })),
    }));
    const spec: Omit<RoomStreamSpec, 'streamId'> = {
      kind: 'room',
      connectionId: chat.connectionId,
      sessionId: chat.sessionId,
      // Resume where this chat stopped applying frames. A first open passes
      // null (live only): the committed past is already in the transcript, and
      // replaying the session's whole event log would be worse than missing a
      // partial answer that will be committed in full at the end.
      after: chat.roomCursor,
    };
    const result = await connectionApi.streamStart({ ...spec, streamId });
    if (result.ok) return;
    set((state) => ({
      streamKeys: withoutKey(state.streamKeys, streamId),
      byKey: patch(state, key, (current) =>
        current.roomStreamId === streamId ? { ...current, roomStreamId: null } : current,
      ),
    }));
  },

  closeRoomStream() {
    const key = get().activeKey;
    const chat = key ? get().byKey[key] : undefined;
    const streamId = chat?.roomStreamId;
    if (!key || !streamId) return;
    void connectionApi.streamCancel({ streamId, abortRun: false });
    set((state) => ({
      byKey: patch(state, key, (current) =>
        current.roomStreamId === streamId ? { ...current, roomStreamId: null } : current,
      ),
      streamKeys: withoutKey(state.streamKeys, streamId),
    }));
  },

  syncSession() {
    const key = get().activeKey;
    if (!key) return;
    void syncSessionFromDaemon(set, get, key);
  },

  answerQuestion(toolUseId, answerText, answers) {
    const key = get().activeKey;
    const chat = key ? get().byKey[key] : undefined;
    const text = answerText.trim();
    if (!key || !chat || !text) return;
    const question = findQuestion(chat.messages, toolUseId);
    if (!question) return;

    // Blocking questions (builtin / Codex): structured answers go through the
    // permission endpoint; the same run continues with the result.
    if (question.permissionId) {
      if (question.answered) return;
      set(questionAnswered(key, toolUseId, true));
      const response = {
        answers: Object.fromEntries(
          Object.entries(answers ?? {}).map(([id, labels]) => [id, { answers: labels }]),
        ),
      };
      void (async () => {
        const res = await api.decidePermission(
          question.permissionId!,
          'allow',
          undefined,
          response,
        );
        if (res.ok || res.status === 404 || res.status === 409) return;
        const { apiCode, message } = apiErrorOf(res.data);
        set((state) => ({
          byKey: patch(state, key, (current) => ({
            ...current,
            messages: markAnswered(current.messages, toolUseId, false),
            error: friendlyMessage(apiCode, res.status, message),
          })),
        }));
      })();
      return;
    }

    // The same gate as `send`, checked *before* marking the card answered: if the
    // run were still busy, `send` would drop the text and the card would read
    // "已发送答案" with nothing sent.
    if (isBusy(chat.phase)) return;

    set(questionAnswered(key, toolUseId, true));
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
    if (!key || !chat) return;
    const streamId = chat.streamId;
    const sessionStreamId = chat.sessionStreamId;
    const roomStreamId = chat.roomStreamId;

    // Detaching must not kill the run: the daemon keeps it, and re-entering the
    // session re-attaches with `?after=`.
    if (streamId) void connectionApi.streamCancel({ streamId, abortRun: false });
    if (sessionStreamId) void connectionApi.streamCancel({ streamId: sessionStreamId, abortRun: false });
    if (roomStreamId) void connectionApi.streamCancel({ streamId: roomStreamId, abortRun: false });

    set((state) => {
      const streamKeys = { ...state.streamKeys };
      if (streamId) delete streamKeys[streamId];
      if (sessionStreamId) delete streamKeys[sessionStreamId];
      if (roomStreamId) delete streamKeys[roomStreamId];
      return {
        byKey: patch(state, key, (current) => ({
          ...current,
          streamId: null,
          sessionStreamId: null,
          roomStreamId: null,
          runId: null,
          phase: 'idle',
          messages: streamId ? finalizeLast(current.messages) : current.messages,
        })),
        streamKeys,
      };
    });
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
    set((state) => ({
      byKey: patch(state, key, (chat) => ({
        ...chat,
        permissionMode: mode,
        // Before the session exists the mode is a creation parameter: `send`
        // reads it from `pendingNew`, so updating only the visible field would
        // show a mode the first run does not actually use.
        pendingNew: chat.pendingNew ? { ...chat.pendingNew, permissionMode: mode } : null,
      })),
    }));
  },

  clearError() {
    const key = get().activeKey;
    if (!key) return;
    set((state) => ({ byKey: patch(state, key, (chat) => ({ ...chat, error: null })) }));
  },

  async setMemoryMode(mode) {
    const key = get().activeKey;
    const chat = key ? get().byKey[key] : undefined;
    if (!key || !chat?.sessionId) return;
    const res = await api.setSessionMemoryMode({ sessionId: chat.sessionId, mode });
    if (!res.ok) {
      const data = res.data as { error?: string; message?: string; code?: string };
      const message =
        data?.code === 'session_not_chat'
          ? '这个会话不支持记忆开关'
          : data?.code === 'memory_not_enabled'
            ? '该工作区未启用记忆'
            : (data?.message ?? data?.error ?? `保存记忆设置失败（HTTP ${res.status}）`);
      set((state) => ({ byKey: patch(state, key, (current) => ({ ...current, error: message })) }));
      return;
    }
    set((state) => ({ byKey: patch(state, key, (current) => ({ ...current, memoryMode: mode })) }));
  },

  async setSessionSelection(model, modelParameters) {
    const key = get().activeKey;
    const chat = key ? get().byKey[key] : undefined;
    if (!key || !chat) return;

    // A session that does not exist yet has nothing to persist to: keep the
    // choice in state and let the first `send` carry it to the daemon.
    if (!chat.sessionId) {
      if (!chat.pendingNew) return;
      set((state) => ({
        byKey: patch(state, key, (current) => ({ ...current, model, modelParameters })),
      }));
      return;
    }

    const res = await api.updateSessionModel(
      chat.sessionId,
      model,
      Object.keys(modelParameters).length ? modelParameters : null,
    );
    if (!res.ok) {
      const data = res.data as { error?: string; message?: string };
      const message = data?.message ?? data?.error ?? `保存模型失败（HTTP ${res.status}）`;
      set((state) => ({ byKey: patch(state, key, (current) => ({ ...current, error: message })) }));
      return;
    }
    set((state) => ({
      byKey: patch(state, key, (current) => ({
        ...current,
        model: res.data.session.model,
        modelParameters: res.data.session.modelParameters ?? {},
      })),
    }));
  },

  applyStreamEvent(event) {
    const key = get().streamKeys[event.streamId];
    if (!key) return;

    const ownerChat = get().byKey[key];
    const isSessionStream = ownerChat?.sessionStreamId === event.streamId;
    const isRoomStream = ownerChat?.roomStreamId === event.streamId;

    if (event.kind === 'session') {
      if (isSessionStream) applySessionEvent(set, get, key, event.event);
      return;
    }

    // Phase and terminal events for a watch only mean "the socket state
    // changed"; the run stream owns everything the user sees.
    if (isSessionStream && event.kind === 'done') {
      set((state) => ({
        byKey: patch(state, key, (current) =>
          current.sessionStreamId === event.streamId ? { ...current, sessionStreamId: null } : current,
        ),
        streamKeys: withoutKey(state.streamKeys, event.streamId),
      }));
      return;
    }

    if (isSessionStream) return;

    // The room stream multiplexes several runs. Its phase/reconnect state is
    // not the composer's busy state (a room stays usable while supplements
    // run), so only `done` needs to clear the handle.
    if (isRoomStream) {
      if (event.kind === 'phase') return;
      if (event.kind === 'done') {
        set((state) => ({
          byKey: patch(state, key, (current) => {
            if (current.roomStreamId !== event.streamId) return current;
            return {
              ...current,
              roomStreamId: null,
              ...(event.outcome === 'giveup'
                ? { error: friendlyMessage(event.apiCode, event.httpCode, event.message ?? '房间流已断开') }
                : {}),
            };
          }),
          streamKeys: withoutKey(state.streamKeys, event.streamId),
        }));
        return;
      }
    }

    if (event.kind === 'phase') {
      set((state) => ({
        byKey: patch(state, key, (chat) => ({ ...chat, phase: phaseOf(event.phase), error: null })),
      }));
      return;
    }

    if (event.kind === 'frames') {
      const before = get().byKey[key]?.permissions.seenIds.length ?? 0;
      set((state) => ({
        byKey: patch(state, key, (chat) => {
          if (!isRoomStream) return reduceFrames(chat, event.frames);
          const next = reduceRoomFrames(chat, event.frames);
          const positions = event.frames
            .map((frame) => frame.roomSeq)
            .filter((seq): seq is number => typeof seq === 'number');
          if (positions.length === 0) return next;
          return { ...next, roomCursor: Math.max(chat.roomCursor ?? 0, ...positions) };
        }),
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
      if (chat.sessionId) {
        const sessionId = chat.sessionId;
        const expectedChat = chat;
        void api.session(sessionId).then((detail) => {
          // A reopened/reset chat may now occupy the same key. Its newer
          // metadata must not be replaced by this older request.
          if (!detail.ok || get().byKey[key] !== expectedChat) return;
          set((state) => ({ byKey: patch(state, key, (current) => ({ ...current, runs: detail.data.runs })) }));
        });
      }
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

    // Room frames name the agent that produced them; stamp it on the answer so
    // a live card is labelled without waiting for a reload.
    if (frame.agentId) {
      const last = messages[messages.length - 1];
      if (last?.kind === 'assistant' && !last.agentId) {
        messages = [...messages.slice(0, -1), { ...last, agentId: frame.agentId }];
      }
    }
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

/**
 * Fold a room batch into the chat.
 *
 * A single-run stream has exactly one assistant card, so the reducer can always
 * append to "the last one". A room multiplexes several runs whose deltas
 * interleave, so each run owns its own card, matched by `runId`; a terminal
 * status closes only that card and leaves its siblings running.
 */
export function reduceRoomFrames(chat: ChatSessionState, frames: SseFrame[]): ChatSessionState {
  let messages = chat.messages;
  let todos = chat.todos;
  let contextUsage = chat.contextUsage;
  let permissions = chat.permissions;
  let runtime = chat.runtime;
  let sessionId = chat.sessionId;

  for (const frame of frames) {
    const event = frame.event;

    if (event.type === 'permission_request') {
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
      if (event.sessionId && !sessionId) sessionId = event.sessionId;
    }

    const runId = frame.runId;
    if (!runId) continue;

    type Assistant = Extract<ChatMessage, { kind: 'assistant' }>;
    let index = messages.findIndex(
      (message) => message.kind === 'assistant' && message.runId === runId,
    );
    if (index < 0) {
      messages = [
        ...messages,
        { ...newAssistant(nextId('a')), runId, agentId: frame.agentId ?? null },
      ];
      index = messages.length - 1;
    }

    const target = messages[index] as Assistant;
    const next = applyFrame(
      { messages: [target], todos, contextUsage, terminal: false, terminalSucceeded: false },
      frame,
      () => nextId('a'),
    );
    let updated = next.messages[next.messages.length - 1] as Assistant;
    if (next.terminal) updated = finalizeLast([updated])[0] as Assistant;
    messages = messages.map((message, i) => (i === index ? updated : message));
    todos = next.todos;
    contextUsage = next.contextUsage;
  }

  return { ...chat, messages, todos, contextUsage, permissions, runtime, sessionId };
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
    messages.push({
      kind: 'user',
      id: nextId('u'),
      text: run.prompt,
      runId: run.id,
      at: run.startedAt,
      ...(run.attachmentIds?.length ? { attachmentIds: run.attachmentIds } : {}),
    });
    const response = fetched[index];
    if (!response) {
      // Still running: attach() will fill and continue this one.
      messages.push({
        ...newAssistant(nextId('a')),
        runId: run.id,
        agentId: run.agentId ?? null,
      });
      return;
    }
    const events = response.ok ? response.data.events : [];
    const rebuilt = buildAssistantFromEvents(events, () => nextId('a'));
    // The speaker is a property of the run, not of its frames: keep it when
    // folding the replay so the room timeline can label the answer.
    messages.push({ ...rebuilt.assistant, runId: run.id, agentId: run.agentId ?? null });
    if (rebuilt.contextUsage) contextUsage = rebuilt.contextUsage;
    if (rebuilt.todos.length) todos = rebuilt.todos;
  });

  // Legacy sessions predate per-run events; fall back to the aggregated rows.
  // These are raw snake_case DB rows — the one place the contract lies.
  if (messages.length === 0) {
    for (const raw of rawMessages) {
      const row = raw as {
        role?: unknown;
        content?: unknown;
        created_at?: unknown;
        agent_id?: unknown;
      };
      if (typeof row?.content !== 'string') continue;
      const at = typeof row.created_at === 'number' ? row.created_at : undefined;
      if (row.role === 'user') {
        messages.push({ kind: 'user', id: nextId('u'), text: row.content, at });
      } else {
        messages.push({
          kind: 'assistant',
          id: nextId('a'),
          blocks: [{ kind: 'text', text: row.content }],
          usage: null,
          error: null,
          done: true,
          agentId: typeof row.agent_id === 'string' ? row.agent_id : null,
        });
      }
    }
  }

  return { messages, todos, contextUsage };
}

type SetState = (updater: (state: ChatStore) => Partial<ChatStore>) => void;
type GetState = () => ChatStore;

/** Keep a session watch open for as long as its chat is on screen. */
async function startSessionWatch(
  set: SetState,
  key: string,
  connectionId: string,
  sessionId: string,
): Promise<void> {
  const streamId = newStreamId();
  set((state) => ({
    streamKeys: { ...state.streamKeys, [streamId]: key },
    byKey: patch(state, key, (chat) => ({ ...chat, sessionStreamId: streamId })),
  }));
  const spec: Omit<SessionStreamSpec, 'streamId'> = { kind: 'session', connectionId, sessionId };
  const result = await connectionApi.streamStart({ ...spec, streamId });
  if (result.ok) return;
  set((state) => ({
    streamKeys: withoutKey(state.streamKeys, streamId),
    byKey: patch(state, key, (current) =>
      current.sessionStreamId === streamId ? { ...current, sessionStreamId: null } : current,
    ),
  }));
}

function applySessionEvent(
  set: SetState,
  get: GetState,
  key: string,
  event: SessionEvent,
): void {
  const chat = get().byKey[key];
  if (!chat || chat.sessionId === null) return;
  if (event.type !== 'state' && event.sessionId !== chat.sessionId) return;

  if (event.type === 'state') {
    if (event.session.id !== chat.sessionId) return;
    patchSessionTitle(set, get, key, event.session.title);
    // A run (or a room) of our own is already streaming the truth; hints would
    // duplicate it.
    if (chat.streamId || chat.roomStreamId) return;
    const running = event.session.runningRunId;
    const stale = chat.lastActiveAt === null || event.session.lastActiveAt > chat.lastActiveAt;
    if (running !== null || stale) {
      void syncSessionFromDaemon(set, get, key);
    }
    return;
  }

  if (event.type === 'session_updated') {
    patchSessionTitle(set, get, key, event.title);
    return;
  }

  // run_started / run_finished. The daemon publishes these for *every* run,
  // including the one this client is streaming, so the hint has to be
  // idempotent rather than "usually skipped".
  //
  // Neither of the two cheap guards is reliable on its own: `streamId` is already
  // null once `done` lands, and `runs` only catches up a round trip later. The one
  // fact that survives both windows is that a rendered run has a user message
  // carrying its id — stamped from the first frame we stream, and by
  // `rebuildHistory` on every reload. So that is the only condition worth
  // encoding; no parallel bookkeeping to keep in sync.
  //
  // While history is loading there are no messages to check against, and the
  // rebuild that is already in flight contains this run — so stay out of its way.
  if (chat.streamId || chat.historyLoading) return;
  // The rail shows `running`, which just changed on the server.
  void useSessions.getState().refreshCurrent(chat.connectionId, { silent: true });
  // In a room, every run arrives on the multiplexed stream. Attaching a
  // per-run stream here would append a second user bubble and a second card.
  if (chat.roomStreamId) return;
  if (isRunRendered(chat, event.run.id)) return;
  appendExternalRun(set, key, chat.connectionId, event.run);
}

/** Has this run already produced a bubble in the transcript? */
function isRunRendered(chat: ChatSessionState, runId: string): boolean {
  return chat.messages.some((message) => message.kind === 'user' && message.runId === runId);
}

function patchSessionTitle(
  set: SetState,
  get: GetState,
  key: string,
  title: string | null,
): void {
  const chat = get().byKey[key];
  if (!chat || chat.title === title) return;
  set((state) => ({ byKey: patch(state, key, (current) => ({ ...current, title })) }));
  if (chat.sessionId) {
    useSessions.getState().patchTitle(chat.connectionId, chat.sessionId, title ?? '');
  }
}

/**
 * A run started (or finished) on another device. Append its prompt and a live
 * assistant bubble, then attach to the run's own stream — which replays from
 * zero, so a run that already finished still renders in full.
 */
function appendExternalRun(
  set: SetState,
  key: string,
  connectionId: string,
  run: SessionRunBrief,
): void {
  set((state) => ({
    byKey: patch(state, key, (chat) => ({
      ...chat,
      error: null,
      messages: [
        ...chat.messages,
        {
          kind: 'user',
          id: nextId('u'),
          text: run.prompt,
          runId: run.id,
          at: run.startedAt,
          ...(run.attachmentIds.length ? { attachmentIds: run.attachmentIds } : {}),
        },
        newAssistant(nextId('a')),
      ],
    })),
  }));
  void attachRun(set, key, connectionId, run.id);
}

/** Re-read a session after a reconnect, or when it changed while we were away. */
async function syncSessionFromDaemon(set: SetState, get: GetState, key: string): Promise<void> {
  const before = get().byKey[key];
  // A live stream owns the transcript; rebuilding underneath it would replace
  // cards the user is watching (a room does the same for all its runs).
  if (!before?.sessionId || before.streamId || before.roomStreamId) return;
  const sessionId = before.sessionId;
  const detail = await api.session(sessionId);
  const current = get().byKey[key];
  if (
    !detail.ok ||
    !current ||
    current.sessionId !== sessionId ||
    current.streamId ||
    current.roomStreamId
  ) {
    return;
  }

  const { session, runs, messages } = detail.data;
  const rebuilt = await rebuildHistory(runs, session.runningRunId, messages);
  const latest = get().byKey[key];
  if (!latest || latest.sessionId !== sessionId || latest.streamId || latest.roomStreamId) return;

  set((state) => ({
    byKey: patch(state, key, (chat) => ({
      ...chat,
      title: session.title,
      workspaceId: session.workspaceId ?? null,
      lastActiveAt: session.lastActiveAt,
      cwd: session.cwd,
      runtime: session.runtime,
      permissionMode: session.permissionMode,
      runId: session.runningRunId,
      messages: rebuilt.messages,
      runs,
      todos: rebuilt.todos,
      contextUsage: rebuilt.contextUsage,
    })),
  }));
  if (session.running && session.runningRunId) {
    void attachRun(set, key, before.connectionId, session.runningRunId);
  }
}

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

function findQuestion(messages: ChatMessage[], toolUseId: string) {
  for (const message of messages) {
    if (message.kind !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.kind === 'question' && block.toolUseId === toolUseId) return block;
    }
  }
  return null;
}

function markAnswered(messages: ChatMessage[], toolUseId: string, answered: boolean): ChatMessage[] {
  return messages.map((message) =>
    message.kind === 'assistant'
      ? {
          ...message,
          blocks: message.blocks.map((block) =>
            block.kind === 'question' && block.toolUseId === toolUseId
              ? { ...block, answered }
              : block,
          ),
        }
      : message,
  );
}

function questionAnswered(key: string, toolUseId: string, answered: boolean) {
  return (state: ChatStore): Partial<ChatStore> => ({
    byKey: patch(state, key, (chat) => ({
      ...chat,
      messages: markAnswered(chat.messages, toolUseId, answered),
    })),
  });
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
