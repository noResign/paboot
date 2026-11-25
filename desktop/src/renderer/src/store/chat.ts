import { create } from 'zustand';
import { api, connectionApi } from '../ipc/client';
import { apiErrorOf, describeDropped, friendlyMessage } from '../../../shared/errors';
import {
  applyFrame,
  buildAssistantFromEvents,
  finalizeAssistant,
  finalizeLast,
  newAssistant,
} from './chat/applyEvent';
import { dismissPermission, enqueuePermission, setInputError, setSubmitting } from './chat/permissions';
import { emptyChat, emptyPermissions } from './chat/types';
import type { PendingAnswer, PendingPermission } from './chat/types';
import type { ChatMessage, ChatSessionState, ContentBlock, TodoItem } from './chat/types';
import type { ContextUsage } from '../../../shared/format';
import type {
  ProductPermissionMode,
  QuestionAnswers,
  RunDto,
  SessionEvent,
  SessionRunBrief,
  SseFrame,
} from '../../../shared/contract';
import type {
  AttachStreamSpec,
  RoomStreamSpec,
  SessionStreamSpec,
  StreamEvent,
  StreamSpec,
} from '../../../shared/ipc';
import { useSessions } from './sessions';
import {
  closePermissionNotification,
  closeQuestionNotification,
  notifyPermission,
  notifyQuestion,
  notifyRunFinished,
} from '../notify/notifier';

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

/**
 * Turns whose POST is in flight, per chat key.
 *
 * A fast double Enter/double click must not become two turns: each POST creates
 * a new question on the timeline and a new set of runs. Checked synchronously,
 * before any await, so both events see the same state.
 */
const turnsInFlight = new Set<string>();

/**
 * Minimum gap between two completed room answers entering the transcript.
 *
 * Execution stays concurrent; only presentation is serialized so several
 * agents finishing together read like successive group-chat messages.
 */
const DISPLAY_GAP_MS = 300;
const displayTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  /** Chat directly with this workspace assistant; it becomes the leader. */
  agentId?: string | null;
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
  send(text: string, attachmentIds?: string[], mentionIds?: string[]): Promise<void>;
  /**
   * One input addressed to several agents (`POST /turns`). The answers arrive
   * on the room stream, not on this promise.
   */
  sendTurn(text: string, mentionIds: string[], attachmentIds?: string[]): Promise<void>;
  /** Open the room stream for the current multi-agent session (idempotent). */
  /** Open the multiplexed room stream; false when it could not be established. */
  ensureRoomStream(): Promise<boolean>;
  /** The roster says who the main speaker is; leader answers stream live. */
  setLeaderAgentId(agentId: string | null): void;
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
  /**
   * Stop one queued/running task. Returns false when the daemon refused it
   * (usually because the task just finished) so the caller can refresh.
   */
  cancelTask(taskId: string): Promise<boolean>;
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
   * Used after a change that the session row reflects (e.g. a permission or
   * model change): the transcript is untouched, only the header fields move.
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
    const rebuilt = await rebuildHistory(runs, messages);
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
        purpose: session.purpose ?? null,
        memoryMode: session.memoryMode ?? 'normal',
        model: session.model,
        modelParameters: session.modelParameters ?? {},
        messages: rebuilt.messages,
        pendingAnswers: rebuilt.pendingAnswers,
        runs,
        todos: rebuilt.todos,
        contextUsage: rebuilt.contextUsage,
        // The initial room stream resumes after everything already folded into
        // history. Without this handoff, a live-only stream can drop the
        // prefix of an answer that was in flight while the session opened.
        roomCursor: rebuilt.roomCursor,
        historyLoading: false,
      })),
    }));

    const running = runs.find((run) => run.id === session.runningRunId);
    // Turn runs belong to the room stream; a per-run attach would block the
    // composer and draw the question twice. ChatView opens the room stream once
    // the roster is known.
    if (session.running && session.runningRunId && !running?.turnId) {
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

  async send(text, attachmentIds = [], mentionIds = []) {
    // Interactive chat has one send path whether the room currently has one
    // agent or several. `sendTurn` creates the session lazily when needed.
    await get().sendTurn(text, mentionIds, attachmentIds);
  },

  async sendTurn(text, mentionIds, attachmentIds = []) {
    const key = get().activeKey;
    const chat = key ? get().byKey[key] : undefined;
    // Match the single-chat composer: an image-only send still needs a prompt
    // the model can act on. The wording is the same so both paths feel alike.
    const prompt = text.trim() || (attachmentIds.length > 0 ? '请查看这些图片。' : '');
    if (!key || !chat || !prompt || turnsInFlight.has(key)) return;

    turnsInFlight.add(key);
    const messageId = nextId('u');
    // Put the user's bubble on screen before any await. Room-stream setup can
    // involve a roster fetch and an SSE handshake; a slow/failed handshake must
    // never make the message look like it vanished.
    set((state) => ({
      byKey: patch(state, key, (current) => ({
        ...current,
        error: null,
        turnSending: true,
        dispatchedTasks: [],
        messages: [
          ...current.messages,
          {
            kind: 'user',
            id: messageId,
            text: prompt,
            at: Date.now(),
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          },
        ],
      })),
    }));
    try {
      // There is no separate "first message creates the session" run anymore:
      // create the session, then send the turn through the same room path used
      // by every later message. The optimistic bubble is already on screen.
      let current = get().byKey[key];
      if (!current?.sessionId) {
        const pending = current?.pendingNew;
        const created = await api.createSession({
          workspaceId: pending?.workspaceId ?? current?.workspaceId ?? undefined,
          runtime: pending?.runtime ?? current?.runtime ?? undefined,
          ...(pending?.agentId ? { agentId: pending.agentId } : {}),
          permissionMode: (pending?.permissionMode ?? current?.permissionMode ?? 'ask') as ProductPermissionMode,
          model: current?.model ?? null,
          modelParameters:
            current && Object.keys(current.modelParameters).length > 0
              ? current.modelParameters
              : null,
          title: prompt,
        });
        if (!created.ok) {
          const { apiCode, message } = apiErrorOf(created.data);
          set((state) => ({
            byKey: patch(state, key, (chatState) => ({
              ...chatState,
              turnSending: false,
              error: friendlyMessage(apiCode, created.status, message, '创建会话失败'),
            })),
          }));
          return;
        }
        const session = created.data.session;
        set((state) => ({
          byKey: patch(state, key, (chatState) => ({
            ...chatState,
            sessionId: session.id,
            title: session.title,
            workspaceId: session.workspaceId ?? null,
            runtime: session.runtime,
            permissionMode: session.permissionMode,
            purpose: session.purpose ?? null,
            model: session.model,
            modelParameters: session.modelParameters ?? {},
            pendingNew: null,
          })),
        }));
        current = get().byKey[key];
      }

      // The answers exist only on the room stream. Sending before it is open
      // leaves an invisible run behind and lets the session watcher attach a
      // per-run stream to it (a second user bubble and a blocked composer).
      if (!(await get().ensureRoomStream())) {
        set((state) => ({
          byKey: patch(state, key, (current) => ({
            ...current,
            turnSending: false,
            error: '无法建立房间流，消息没有发送；请重试',
          })),
        }));
        return;
      }
      // A session created here never went through `openSession`, which is the
      // only other place that opens the watch. Without it the daemon's
      // first-turn title update would only show up after reopening the chat.
      const watched = get().byKey[key];
      if (watched?.sessionId && !watched.sessionStreamId) {
        // Best-effort: a failed watch must not stop the message from sending.
        await startSessionWatch(set, key, watched.connectionId, watched.sessionId).catch(
          () => undefined,
        );
      }

      // Stable id: a retry (lost response, double submit) re-attaches instead of
      // creating a second question.
      const res = await api.sendTurn(
        current!.sessionId!,
        prompt,
        mentionIds,
        crypto.randomUUID(),
        attachmentIds,
      );
      if (res.ok) {
        // Stamp the turn onto the question: session hints for any run of this
        // turn then see it as already rendered instead of appending a copy.
        const turnId = res.data.turnId;
        const dispatchedTasks = res.data.tasks.map((task) => ({
          taskId: task.id,
          agentId: task.agentId,
        }));
        // An addressed agent that got no task is a fact the user has to see:
        // otherwise a full room or a disabled agent looks like a dead mention.
        const droppedNotice = describeDropped(res.data.dropped ?? []);
        set((state) => ({
          byKey: patch(state, key, (chatState) => ({
            ...chatState,
            turnSending: false,
            dispatchedTasks,
            error: droppedNotice,
            messages: chatState.messages.map((message) =>
              message.kind === 'user' && message.id === messageId
                ? { ...message, turnId }
                : message,
            ),
          })),
        }));
        void useSessions.getState().refreshCurrent(chat.connectionId);
        return;
      }
      const { apiCode, message } = apiErrorOf(res.data);
      set((state) => ({
        byKey: patch(state, key, (current) => ({
          ...current,
          turnSending: false,
          dispatchedTasks: [],
          error: friendlyMessage(apiCode, res.status, message, '发送失败'),
        })),
      }));
    } catch (err) {
      // Every awaited step above is expected to resolve with a result, but an
      // unexpected throw must not leave the composer stuck on "正在发送…" with
      // no way back — the state is only cleared on the paths that return.
      set((state) => ({
        byKey: patch(state, key, (current) => ({
          ...current,
          turnSending: false,
          dispatchedTasks: [],
          error: err instanceof Error ? err.message : '发送失败，请重试',
        })),
      }));
    } finally {
      turnsInFlight.delete(key);
    }
  },

  async ensureRoomStream(): Promise<boolean> {
    const key = get().activeKey;
    let chat = key ? get().byKey[key] : undefined;
    if (!key || !chat?.sessionId) return false;

    if (chat.roomStreamId) return true;

    // The leader's answer only streams live when we know who the leader is.
    // Learn it alongside opening the stream rather than before it: both are one
    // round trip, and serializing them is time the user spends wondering why
    // the agent has not started.
    const roster =
      !chat.leaderAgentId && chat.sessionId
        ? api.sessionAgents(chat.sessionId).then((res) => {
            if (!res?.ok) return;
            const sessionId = chat!.sessionId;
            set((state) => ({
              byKey: patch(state, key, (current) =>
                current.sessionId === sessionId
                  ? withLeaderAgent(current, res.data.leaderId ?? null)
                  : current,
              ),
            }));
          })
        : null;

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
    const [result] = await Promise.all([
      connectionApi.streamStart({ ...spec, streamId }),
      roster,
    ]);
    if (result.ok) return true;
    set((state) => ({
      streamKeys: withoutKey(state.streamKeys, streamId),
      byKey: patch(state, key, (current) =>
        current.roomStreamId === streamId ? { ...current, roomStreamId: null } : current,
      ),
    }));
    return false;
  },

  setLeaderAgentId(agentId) {
    const key = get().activeKey;
    if (!key) return;
    set((state) => ({
      byKey: patch(state, key, (current) => withLeaderAgent(current, agentId)),
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
    const found = findQuestion(chat, toolUseId);
    if (!found) return;
    const question = found.block;

    // Blocking questions (builtin / Codex): structured answers go through the
    // permission endpoint; the same run continues with the result.
    if (question.permissionId) {
      // A done answer means the run already released the permission id.
      if (question.answered || found.done) return;
      // Record the picks locally as well: the live block came from a stream
      // event that carries no answer, so without this the card stays blank
      // until the session is reloaded from persisted events.
      set(questionAnswered(key, toolUseId, true, answers ?? null));
      // The notice outlived its question the moment we answered it.
      closeQuestionNotification(question.permissionId);
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
            ...markAnsweredChat(current, toolUseId, false),
            error: friendlyMessage(apiCode, res.status, message),
          })),
        }));
      })();
      return;
    }

    // Claude's non-blocking question path continues as a normal turn. Address
    // the agent that asked — a read-only member's question must not be answered
    // by the leader — and let the per-agent queue serialize it behind that
    // agent's live run.
    if (question.answered) return;
    // No answer to record here: this path sends the choice as the next user
    // message, which is already on the timeline right below the card.
    set(questionAnswered(key, toolUseId, true));
    // Address the asker explicitly. If the roster has not loaded yet we cannot
    // tell whether it is the leader; sending a member's answer to the leader is
    // worse than a leader turn taking the `mention` source.
    const mentionIds = found.agentId ? [found.agentId] : [];
    void get().send(text, [], mentionIds);
  },

  stop() {
    const key = get().activeKey;
    const chat = key ? get().byKey[key] : undefined;
    if (!key || !chat) return;

    // A room has several runs and no single per-run stream to cancel. Stop the
    // whole session at the daemon, keep the multiplexed stream open for the
    // cancellation terminal frames, and finalize what is already on screen.
    if (chat.roomStreamId && chat.sessionId) {
      const sessionId = chat.sessionId;
      void api.cancelSessionRuns(sessionId).then((res) => {
        if (!res.ok) {
          const { apiCode, message } = apiErrorOf(res.data);
          set((state) => ({
            byKey: patch(state, key, (current) => ({
              ...current,
              error: friendlyMessage(apiCode, res.status, message, '停止失败'),
            })),
          }));
        }
      });
      set((state) => ({
        byKey: patch(state, key, (current) => ({
          ...current,
          messages: finalizeAll(current.messages),
          pendingAnswers: [],
          turnSending: false,
          dispatchedTasks: [],
          permissions: emptyPermissions(),
        })),
      }));
      scheduleDisplayDrain(set, get, key);
      return;
    }

    if (!chat.streamId) return;
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

  async cancelTask(taskId: string): Promise<boolean> {
    const key = get().activeKey;
    const chat = key ? get().byKey[key] : undefined;
    if (!key || !chat) return false;
    const res = await api.cancelTask(taskId);
    if (!res.ok) {
      const { apiCode, message } = apiErrorOf(res.data);
      set((state) => ({
        byKey: patch(state, key, (current) => ({
          ...current,
          error: friendlyMessage(apiCode, res.status, message, '停止任务失败'),
        })),
      }));
      return false;
    }
    // A queued task has no run to produce a frame, so drop its row here. A
    // running one finalizes through the terminal frame the room stream sends.
    set((state) => ({
      byKey: patch(state, key, (current) => ({
        ...current,
        dispatchedTasks: current.dispatchedTasks.filter((task) => task.taskId !== taskId),
      })),
    }));
    return true;
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

    const local = await api.decidePermission(pending.permissionId, decision, reason, response);
    let ok = local.ok;
    let status = local.status;
    let payload: unknown = local.data;

    // A peer run's approval lives on the other machine: this daemon has no
    // PermissionManager entry, so the local answer 404s. Relay it instead.
    if (!local.ok && local.status === 404 && pending.runId) {
      const relayed = await api.decidePeerPermission(
        pending.runId,
        pending.permissionId,
        decision === 'deny' ? 'deny' : 'allow',
      );
      if (relayed.ok || relayed.status === 404 || relayed.status === 409) {
        ok = relayed.ok;
        status = relayed.status;
        payload = relayed.data;
      }
    }

    const { apiCode, message } = apiErrorOf(payload);

    set((state) => ({
      byKey: patch(state, key, (current) => {
        // A 404/409 means the request is already over (someone else answered, or
        // it timed out) — treat it as resolved rather than showing an error.
        if (ok || status === 404 || status === 409) {
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
              setInputError(current.permissions, friendlyMessage(apiCode, status, message)),
              false,
            ),
          };
        }
        return {
          ...current,
          permissions: setSubmitting(current.permissions, false),
          error: friendlyMessage(apiCode, status, message),
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
            // The socket is gone; do not leave half-written cards in the
            // pending area forever. Their text is best-effort anyway.
            const flushed = current.pendingAnswers.map((answer) => ({
              ...answer,
              message: { ...answer.message, done: true },
            }));
            return {
              ...current,
              roomStreamId: null,
              // Anything still running will never get a terminal frame now;
              // leaving it unfinished keeps a spinner on screen forever.
              messages: finalizeAll(current.messages),
              pendingAnswers: [],
              turnSending: false,
              dispatchedTasks: [],
              displayQueue: [...current.displayQueue, ...flushed],
              ...(event.outcome === 'giveup'
                ? { error: friendlyMessage(event.apiCode, event.httpCode, event.message ?? '房间流已断开') }
                : {}),
            };
          }),
          streamKeys: withoutKey(state.streamKeys, event.streamId),
        }));
        scheduleDisplayDrain(set, get, key);
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

      scheduleDisplayDrain(set, get, key);

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
          // A blocking question is its own kind of "needs a human": it emits no
          // permission_request and blocks the run, so without a notice the user
          // in another app is never told. Replay carries `answerStatus`, which
          // is what keeps this from re-announcing history.
          if (e.type === 'question' && e.permissionId && !e.answerStatus) {
            notifyQuestion(e.permissionId, e.questions, session);
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

/**
 * Close every assistant card still marked running.
 *
 * Used when the room stream ends: no further terminal frame can arrive, so an
 * unfinished card would spin forever. `finalizeLast` is not enough — several
 * runs can be live at once.
 */
function finalizeAll(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) =>
    message.kind === 'assistant' ? finalizeAssistant(message) : message,
  );
}


/** A room has one visible speaker at a time; status-only frames do not count. */
/**
 * A live answer the transcript is itself growing.
 *
 * Room answers stream in the assistant tab (`pendingAnswers`) and are not part
 * of the conversation, so they must not hold a finished answer back: display is
 * decoupled from a *different* agent's execution. Only a card being written into
 * `messages` (the legacy per-run path) has to finish first, or a completed
 * bubble would land below a still-growing one.
 */
function hasLiveTranscriptAnswer(chat: ChatSessionState): boolean {
  return chat.messages.some((message) => message.kind === 'assistant' && !message.done);
}

/**
 * Append completed agent messages one at a time.
 *
 * This is deliberately a presentation queue, not an execution queue: the
 * daemon has already persisted the answer and the room stream has delivered its
 * terminal frame. We only wait while another agent is visibly streaming, then
 * reveal one queued final bubble per short interval.
 */
function scheduleDisplayDrain(set: SetState, get: GetState, key: string): void {
  if (displayTimers.has(key)) return;
  const chat = get().byKey[key];
  if (!chat || chat.displayQueue.length === 0 || hasLiveTranscriptAnswer(chat)) return;

  const [next, ...rest] = chat.displayQueue;
  if (!next) return;
  set((state) => ({
    byKey: patch(state, key, (current) => ({
      ...current,
      messages: [...current.messages, next.message],
      displayQueue: rest,
    })),
  }));

  const timer = setTimeout(() => {
    displayTimers.delete(key);
    scheduleDisplayDrain(set, get, key);
  }, DISPLAY_GAP_MS);
  displayTimers.set(key, timer);
}

/**
 * Apply the roster's leader id, promoting any leader run that already started
 * while the roster was unknown. Shared by the roster fetch and the stream open,
 * so the two cannot diverge.
 */
function withLeaderAgent(chat: ChatSessionState, agentId: string | null): ChatSessionState {
  if (chat.leaderAgentId === agentId) return chat;
  return { ...chat, leaderAgentId: agentId };
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
      // `sessions.runtime` (leader mirror) is the header's source; a frame's
      // runtime is the answering agent's, which may be a member.
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
  // it so the transcript can pair the question with the run answering it.
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

  return { ...chat, messages, todos, contextUsage, permissions, runId, sessionId, pendingNew, title };
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
  let pending = chat.pendingAnswers;
  let displayQueue = chat.displayQueue ?? [];
  let dispatchedTasks = chat.dispatchedTasks;
  let todos = chat.todos;
  let contextUsage = chat.contextUsage;
  let permissions = chat.permissions;
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
      // Every answering agent's frames carry *its* runtime. The session header
      // shows the leader's, which comes from the session row / roster, so a
      // member running a different backend must not repaint it.
      if (event.sessionId && !sessionId) sessionId = event.sessionId;
    }

    const runId = frame.runId;
    if (!runId) continue;

    // The API ack says "these tasks were created"; the first real frame is the
    // proof that their run actually started. Drop the waiting row then.
    dispatchedTasks = dispatchedTasks.filter((task) =>
      frame.taskId
        ? task.taskId !== frame.taskId
        : frame.agentId
          ? task.agentId !== frame.agentId
          : true,
    );

    type Assistant = Extract<ChatMessage, { kind: 'assistant' }>;
    let index = pending.findIndex((answer) => answer.runId === runId);
    if (index < 0) {
      // Legacy/history can already contain a partial card for this run. Move it
      // into the live area instead of starting over and duplicating it later.
      const existingIndex = messages.findIndex(
        (message) => message.kind === 'assistant' && message.runId === runId,
      );
      const existing =
        existingIndex >= 0
          ? (messages[existingIndex] as Assistant)
          : null;
      if (existingIndex >= 0) messages = messages.filter((_, i) => i !== existingIndex);
      pending = [
        ...pending,
        {
          runId,
          agentId: frame.agentId ?? existing?.agentId ?? null,
          taskId: frame.taskId ?? null,
          message:
            existing ?? { ...newAssistant(nextId('a')), runId, agentId: frame.agentId ?? null },
        },
      ];
      index = pending.length - 1;
    } else if (frame.taskId && pending[index]!.taskId !== frame.taskId) {
      // The first frame of a re-opened run is what names its task; without this
      // the live card has no id to stop until the session is reloaded.
      pending = pending.map((answer, at) =>
        at === index ? { ...answer, taskId: frame.taskId } : answer,
      );
    }

    const entry = pending[index]!;
    const next = applyFrame(
      // Only this run's card changes; every other live answer stays untouched.
      {
        messages: [entry.message],
        todos,
        contextUsage,
        terminal: false,
        terminalSucceeded: false,
      },
      frame,
      () => nextId('a'),
    );
    let updated = next.messages[next.messages.length - 1] as Assistant;
    todos = next.todos;
    contextUsage = next.contextUsage;

    if (next.terminal) {
      // The final message joins the presentation queue. Room answers held back
      // only by *another agent still running* drain immediately; the queue waits
      // only for an answer the transcript itself is still writing.
      updated = finalizeLast([updated])[0] as Assistant;
      displayQueue = [
        ...displayQueue.filter((answer) => answer.runId !== runId),
        { runId, agentId: updated.agentId ?? frame.agentId ?? null, message: updated },
      ];
      pending = pending.filter((answer) => answer.runId !== runId);
    } else {
      pending = pending.map((answer, i) =>
        i === index ? { ...answer, message: updated } : answer,
      );
    }
  }

  return {
    ...chat,
    messages,
    pendingAnswers: pending,
    displayQueue,
    dispatchedTasks,
    todos,
    contextUsage,
    permissions,
    sessionId,
  };
}

interface RebuiltHistory {
  messages: ChatMessage[];
  pendingAnswers: PendingAnswer[];
  todos: TodoItem[];
  contextUsage: ContextUsage | null;
  /** Last room position represented by the fetched run events. */
  roomCursor: number | null;
}

/**
 * Rebuild a transcript from runs and their per-run event replays, rather than
 * from the aggregated `messages` (which has no tool cards, thinking or usage).
 * Replays are independent, so they are fetched with a small concurrency limit
 * and assembled in run order.
 */
async function rebuildHistory(
  inputRuns: RunDto[],
  rawMessages: unknown[],
): Promise<RebuiltHistory> {
  // The live room appends answers in commit order, not run-start order. Sort by
  // the assistant message's committed_seq so a reload does not move a slow
  // answer across a newer user question. Active runs have no commit yet and go
  // last, preserving their live placeholder position.
  const runs = [...inputRuns].sort((a, b) => {
    const ac = a.answerCommittedSeq ?? Number.POSITIVE_INFINITY;
    const bc = b.answerCommittedSeq ?? Number.POSITIVE_INFINITY;
    return ac !== bc ? ac - bc : a.startedAt - b.startedAt;
  });
  // Fetch every run, including active ones. A room may have several runs in
  // flight at once; using the singular session.runningRunId would mark all but
  // one as completed and render truncated cards.
  const fetched = await mapLimit(runs, 4, async (run) => await api.runEvents(run.id));
  let roomCursor: number | null = null;
  for (const response of fetched) {
    if (!response?.ok) continue;
    for (const frame of response.data.events) {
      if (typeof frame.roomSeq === 'number') {
        roomCursor = Math.max(roomCursor ?? 0, frame.roomSeq);
      }
    }
  }

  const messages: ChatMessage[] = [];
  const pendingAnswers: PendingAnswer[] = [];
  let contextUsage: ContextUsage | null = null;
  let todos: TodoItem[] = [];
  // Room tasks: one user question, several runs (one per answering agent).
  // Draw the question on the first run of each turn only.
  const seenTurns = new Set<string>();

  runs.forEach((run, index) => {
    const turnId = run.turnId ?? null;
    const questionDrawn = turnId !== null && seenTurns.has(turnId);
    if (turnId !== null) seenTurns.add(turnId);
    if (!questionDrawn) {
      messages.push({
        kind: 'user',
        id: nextId('u'),
        text: run.prompt,
        runId: run.id,
        ...(turnId !== null ? { turnId } : {}),
        at: run.startedAt,
        ...(run.attachmentIds?.length ? { attachmentIds: run.attachmentIds } : {}),
      });
    }
    const response = fetched[index];
    const active = run.status === 'running';
    const fallback = {
      ...newAssistant(nextId('a')),
      done: !active,
      runId: run.id,
      agentId: run.agentId ?? null,
    };
    if (!response || !response.ok) {
      if (active) pendingAnswers.push({ runId: run.id, agentId: run.agentId ?? null, message: fallback });
      else messages.push(fallback);
      return;
    }
    const rebuilt = buildAssistantFromEvents(response.data.events, () => nextId('a'), {
      finalize: !active,
    });
    const assistant = { ...rebuilt.assistant, runId: run.id, agentId: run.agentId ?? null };
    if (active) {
      pendingAnswers.push({ runId: run.id, agentId: run.agentId ?? null, message: assistant });
    } else {
      // The speaker is a property of the run, not of its frames: keep it when
      // folding the replay so the room timeline can label the answer.
      messages.push(assistant);
    }
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

  return { messages, pendingAnswers, todos, contextUsage, roomCursor };
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
  // Room runs are room-owned even when the stream is not open yet: make it so
  // instead of binding a one-run stream (which would block the composer).
  if (event.run.turnId) {
    void get().ensureRoomStream();
    return;
  }
  if (isRunRendered(chat, event.run)) return;
  appendExternalRun(set, key, chat.connectionId, event.run);
}

/** Has this run (or its turn) already produced a question bubble? */
function isRunRendered(
  chat: ChatSessionState,
  run: { id: string; turnId?: string | null },
): boolean {
  return chat.messages.some(
    (message) =>
      message.kind === 'user' &&
      (message.runId === run.id ||
        (run.turnId !== undefined && run.turnId !== null && message.turnId === run.turnId)),
  );
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
  const rebuilt = await rebuildHistory(runs, messages);
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
      purpose: session.purpose ?? null,
      runId: session.runningRunId,
      messages: rebuilt.messages,
      pendingAnswers: rebuilt.pendingAnswers,
      runs,
      todos: rebuilt.todos,
      contextUsage: rebuilt.contextUsage,
      roomCursor: rebuilt.roomCursor,
      displayQueue: [],
      turnSending: false,
      dispatchedTasks: [],
    })),
  }));
  const running = runs.find((run) => run.id === session.runningRunId);
  if (session.running && session.runningRunId && !running?.turnId) {
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

interface FoundQuestion {
  block: Extract<ContentBlock, { kind: 'question' }>;
  /** The agent that asked. A non-leader's answer must be routed back to it. */
  agentId: string | null;
  /** The answer is final, so a blocking permission cannot still be pending. */
  done: boolean;
}

function findQuestion(chat: ChatSessionState, toolUseId: string): FoundQuestion | null {
  const candidates: { message: ChatMessage; agentId: string | null }[] = [
    ...chat.messages.map((message) => ({
      message,
      agentId: message.kind === 'assistant' ? (message.agentId ?? null) : null,
    })),
    ...chat.pendingAnswers.map((answer) => ({ message: answer.message, agentId: answer.agentId })),
    ...chat.displayQueue.map((answer) => ({ message: answer.message, agentId: answer.agentId })),
  ];
  for (const { message, agentId } of candidates) {
    if (message.kind !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.kind === 'question' && block.toolUseId === toolUseId) {
        return { block, agentId, done: message.done };
      }
    }
  }
  return null;
}

/**
 * Mark a question answered, and record *what* was answered.
 *
 * The picks have to be written onto the block here, not only sent to the
 * daemon. A live block is built from stream events, which carry no answer, so
 * without this the card shows a blank option list until the session is
 * reloaded from events (which is exactly the "switch away and back" bug).
 */
function markAnswered(
  messages: ChatMessage[],
  toolUseId: string,
  answered: boolean,
  answers?: QuestionAnswers | null,
  answerText?: string | null,
): ChatMessage[] {
  return messages.map((message) =>
    message.kind === 'assistant'
      ? {
          ...message,
          blocks: message.blocks.map((block) =>
            block.kind === 'question' && block.toolUseId === toolUseId
              ? {
                  ...block,
                  answered,
                  ...(answers ? { answers } : {}),
                  ...(answerText ? { answerText } : {}),
                }
              : block,
          ),
        }
      : message,
  );
}

function markAnsweredAnswer(
  answer: PendingAnswer,
  toolUseId: string,
  answered: boolean,
  answers?: QuestionAnswers | null,
  answerText?: string | null,
): PendingAnswer {
  return {
    ...answer,
    message: markAnswered([answer.message], toolUseId, answered, answers, answerText)[0] as PendingAnswer['message'],
  };
}

function markAnsweredChat(
  chat: ChatSessionState,
  toolUseId: string,
  answered: boolean,
  answers?: QuestionAnswers | null,
  answerText?: string | null,
): Pick<ChatSessionState, 'messages' | 'pendingAnswers' | 'displayQueue'> {
  return {
    messages: markAnswered(chat.messages, toolUseId, answered, answers, answerText),
    pendingAnswers: chat.pendingAnswers.map((answer) =>
      markAnsweredAnswer(answer, toolUseId, answered, answers, answerText),
    ),
    displayQueue: chat.displayQueue.map((answer) =>
      markAnsweredAnswer(answer, toolUseId, answered, answers, answerText),
    ),
  };
}

function questionAnswered(
  key: string,
  toolUseId: string,
  answered: boolean,
  answers?: QuestionAnswers | null,
  answerText?: string | null,
) {
  return (state: ChatStore): Partial<ChatStore> => ({
    byKey: patch(state, key, (chat) => ({
      ...chat,
      ...markAnsweredChat(chat, toolUseId, answered, answers, answerText),
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
