import { useEffect, useId, useState } from 'react';
import { useChat } from '../../store/chat';
import { api } from '../../ipc/client';
import { useSessions } from '../../store/sessions';
import { formatContextUsage, contextPercent } from '../../../../shared/format';
import {
  PERMISSION_MODE_LABEL,
  clampPermissionMode,
  permissionModeLabel,
  permissionModeOptions,
} from '../../../../shared/runtime-identity';
import { bypassAllowedOf, useConfig } from '../../store/config';
import { RuntimeBadge } from '../../ui/RuntimeIcon';
import { Icon } from '../../ui/Icon';
import { ContextMenu, useContextMenu, type MenuItem } from '../../ui/ContextMenu';
import { requiresModal } from '../../store/chat/permissions';
import { Transcript } from './Transcript';
import { agentDisplayName } from './agentLabel';
import { findAwaitingAnswer, traceTargetOnJump } from './liveAnswers';
import { QuestionDialog, askerName } from './QuestionDialog';
import { Composer } from './Composer';
import { useStickToBottom } from './useStickToBottom';
import { TabBar, TabPanels, type TabItem } from '../../ui/Tabs';
import { transcriptSignature } from './transcriptSignature';
import { TodoPanel } from './TodoPanel';
import { PermissionDialog, InlinePermissionCard } from '../permissions/PermissionDialog';
import { AssistantTab } from './AssistantTab';
import { RunTracePane } from './RunTracePane';
import { SessionPermissionsDialog } from '../permissions/SessionPermissionsDialog';
import { SessionEndsChips } from './SessionEndsChips';
import { TranscriptSkeleton } from '../../ui/Skeleton';
import type { ChatSessionState } from '../../store/chat/types';
import type {
  AgentProfileDto,
  ModelOptionDto,
  ProductPermissionMode,
  SessionAgentDto,
} from '../../../../shared/contract';

/** Chat pages. Add a `TabItem` and extend this union together. */
type ChatTab = 'chat' | 'assistants';

interface Props {
  workspaceName: string | null;
  workspaceId: string | null;
  asideVisible: boolean;
  onToggleAside(): void;
  /** Collapse the conversation column so the right panel gets the width. */
  onCollapseChat(): void;
  /** Open the Tasks page filtered to this session. */
  onOpenTasks?: (sessionId: string, title: string | null) => void;
}

export function ChatView({
  workspaceName,
  workspaceId,
  asideVisible,
  onToggleAside,
  onCollapseChat,
  onOpenTasks,
}: Props) {
  const chat = useChat((state) => (state.activeKey ? state.byKey[state.activeKey] : undefined));
  const bypassAllowed = bypassAllowedOf(useConfig((state) => state.config));
  const send = useChat((state) => state.send);
  const ensureRoomStream = useChat((state) => state.ensureRoomStream);
  const setLeaderAgentId = useChat((state) => state.setLeaderAgentId);
  const stop = useChat((state) => state.stop);
  const decide = useChat((state) => state.decide);
  const patchSessionTitle = useSessions((state) => state.patchTitle);
  const patchChatTitle = useChat((state) => state.patchTitle);
  const setPermissionMode = useChat((state) => state.setPermissionMode);
  const clearError = useChat((state) => state.clearError);
  const setMemoryMode = useChat((state) => state.setMemoryMode);
  const setSessionSelection = useChat((state) => state.setSessionSelection);

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [showPerms, setShowPerms] = useState(false);
  /**
   * Questions the user waved away. A blocking question opens the dialog once;
   * re-opening it on every re-render would fight the user, and the status strip
   * above the composer stays as the way back in.
   */
  const [dismissedQuestions, setDismissedQuestions] = useState<string[]>([]);
  const [tab, setTab] = useState<ChatTab>('chat');
  const [traceRunId, setTraceRunId] = useState<string | null>(null);
  /** 名册用来把消息上的 agentId 翻成显示名；只有一个成员时不标注。 */
  const [sessionAgents, setSessionAgents] = useState<SessionAgentDto[]>([]);
  /** Room capacity from the daemon, so "add" can be disabled instead of failing. */
  const [roomCapacity, setRoomCapacity] = useState<{ used: number; max: number } | null>(null);
  /** 工作区里的 agent：@ 的候选池；点名一个非成员会把会话升级成群聊。 */
  const [workspaceAgents, setWorkspaceAgents] = useState<AgentProfileDto[]>([]);
  const [models, setModels] = useState<ModelOptionDto[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  // Refresh the roster used by both the transcript labels and the 助手 tab.
  useEffect(() => {
    const sessionId = chat?.sessionId;
    if (!sessionId) {
      setLeaderAgentId(null);
      return;
    }
    let live = true;
    void api.sessionAgents(sessionId).then((res) => {
      if (!live) return;
      setSessionAgents(res.ok ? res.data.agents : []);
      setLeaderAgentId(res.ok ? (res.data.leaderId ?? null) : null);
      setRoomCapacity(res.ok ? (res.data.capacity ?? null) : null);
    });
    return () => {
      live = false;
    };
  }, [chat?.sessionId]);

  /** Re-read the roster after the assistant dialog changed its membership. */
  function refreshAgents(): void {
    const sessionId = chat?.sessionId;
    if (!sessionId) return;
    void api.sessionAgents(sessionId).then((res) => {
      setSessionAgents(res.ok ? res.data.agents : []);
      setLeaderAgentId(res.ok ? (res.data.leaderId ?? null) : null);
      setRoomCapacity(res.ok ? (res.data.capacity ?? null) : null);
    });
    refreshMentionAgents();
  }

  /** `@` candidates are workspace-level, not room members. */
  const mentionWorkspaceId = chat?.workspaceId ?? workspaceId;

  async function refreshMentionAgents(): Promise<void> {
    if (!mentionWorkspaceId) return;
    const res = await api.workspaceAgents(mentionWorkspaceId);
    if (res.ok) setWorkspaceAgents(res.data.agents);
  }

  useEffect(() => {
    void refreshMentionAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionWorkspaceId]);

  // Every interactive session uses the multiplexed room stream, even when it
  // currently has one agent. Single-agent is just a room with one leader.
  useEffect(() => {
    if (!chat?.sessionId) return;
    void ensureRoomStream();
  }, [chat?.sessionId, ensureRoomStream]);

  // The catalogue belongs to the runtime. The daemon caches it, so refetching
  // per session is cheap after the first call. A session that has not been
  // created yet already knows its runtime (`startNew`), so the picker can be
  // populated before the first message.
  useEffect(() => {
    const runtime = chat?.runtime;
    setModelsError(null);
    if (!runtime) {
      setModels([]);
      return;
    }
    let live = true;
    void api.agentModels(runtime).then((res) => {
      if (!live) return;
      if (res.ok) {
        setModels(res.data.models);
      } else {
        setModels([]);
        setModelsError('模型列表加载失败');
      }
    });
    return () => {
      live = false;
    };
  }, [chat?.runtime]);

  // This component outlives the session switch (it reads the active chat from
  // the store), so an open rename box would otherwise follow the user to the
  // next session and put the previous title into an input over the new one —
  // including a session that has no title to rename yet.
  useEffect(() => {
    setRenaming(false);
    setDraft('');
    // Message ids belong to one session; carrying the dismissed set across a
    // switch would silently suppress a dialog in the next session.
    setDismissedQuestions([]);
  }, [chat?.key]);

  const tabsId = useId();

  useEffect(() => {
    setTab('chat');
    setTraceRunId(null);
  }, [chat?.key]);

  // Hooks must run before the early return below.
  const { ref: scrollRef, showJump, jumpToBottom, onScroll } = useStickToBottom({
    resetKey: chat?.key ?? null,
    signature: transcriptSignature(chat?.messages ?? []),
  });

  if (!chat) {
    return <div className="main-body">从左侧选择一个会话</div>;
  }

  const pending = chat.permissions.active;
  const busy = chat.phase === 'connecting' || chat.phase === 'live' || chat.phase === 'reconnecting';
  const roomRunning =
    Boolean(chat.roomStreamId) &&
    (chat.dispatchedTasks.length > 0 ||
      chat.pendingAnswers.length > 0 ||
      chat.messages.some((message) => message.kind === 'assistant' && !message.done));
  const leaderAgentId =
    sessionAgents.find((agent) => agent.role === 'leader')?.id ?? chat.leaderAgentId;
  // `sessions.runtime` mirrors the leader; the roster's backend is the same
  // value once loaded, and it is what the header must show even while a member
  // on another backend is answering.
  const leaderBackend = sessionAgents.find((agent) => agent.role === 'leader')?.backend ?? null;
  const liveCount =
    (chat.turnSending ? 1 : 0) +
    chat.dispatchedTasks.length +
    chat.pendingAnswers.length +
    chat.displayQueue.length;
  const liveNames = [
    ...new Set(
      [...chat.pendingAnswers, ...chat.dispatchedTasks, ...chat.displayQueue]
        .map((item) => {
          const member = sessionAgents.find((agent) => agent.id === item.agentId);
          return member
            ? agentDisplayName(member)
            : workspaceAgents.find((agent) => agent.id === item.agentId)?.name;
        })
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  // Builtin/Codex questions emit no permission_request, so the only hint that
  // the room is blocked on the user is this badge (and the live-card one). It
  // also has to see per-run stream answers, which live in `messages`.
  const awaitingAnswer = findAwaitingAnswer(chat);
  const awaitingName = awaitingAnswer
    ? (askerName(awaitingAnswer, sessionAgents, workspaceAgents) ?? '助手')
    : null;
  const liveStatusText = awaitingAnswer
    ? `${awaitingName ?? '助手'} 需要你的回答`
    : chat.turnSending
      ? '正在发送消息…'
      : chat.pendingAnswers.length > 0
        ? `${liveNames.slice(0, 3).join('、')}${liveNames.length > 3 ? ` 等 ${liveNames.length} 个助手` : ''} 正在回答…`
        : chat.dispatchedTasks.length > 0
          ? `${liveNames.slice(0, 3).join('、')} 已派发任务，等待开始…`
          : '回答已就绪，稍后显示…';

  /** Secondary session actions, so the header keeps two or three visible controls. */
  function overflowMenu(current: ChatSessionState): MenuItem[] {
    const items: MenuItem[] = [];
    // Renaming writes `PATCH /api/sessions/:id`; a session that does not exist
    // yet takes its title from the first prompt instead.
    if (current.sessionId) {
      items.push({
        id: 'rename',
        label: '重命名会话',
        run: () => {
          setDraft(current.title ?? '');
          setRenaming(true);
        },
      });
    }
    if (current.sessionId) {
      items.push({ id: 'permissions', label: '会话权限…', run: () => setShowPerms(true) });
      const memoryMode = current.memoryMode ?? 'normal';
      items.push(
        {
          id: 'memory-normal',
          label: '记忆：正常',
          disabled: memoryMode === 'normal',
          run: () => void setMemoryMode('normal'),
        },
        {
          id: 'memory-no-injection',
          label: '记忆：只记录，不注入',
          disabled: memoryMode === 'no_injection',
          run: () => void setMemoryMode('no_injection'),
        },
        {
          id: 'memory-off',
          label: '记忆：本会话关闭',
          disabled: memoryMode === 'off',
          run: () => void setMemoryMode('off'),
        },
      );
      if (onOpenTasks) {
        items.push({
          id: 'tasks',
          label: '本会话的定时任务',
          run: () => onOpenTasks(current.sessionId as string, current.title ?? null),
        });
      }
    } else if (current.pendingNew) {
      // Same menu shape as a real session, so the header does not grow a set of
      // items the moment the first message lands. All three write `sessions.*`,
      // which has no row to write to yet — hence disabled, not hidden.
      items.push(
        { id: 'permissions', label: '会话权限（需先发消息）', disabled: true, run: () => {} },
        { id: 'memory', label: '记忆（需先发消息）', disabled: true, run: () => {} },
        { id: 'tasks', label: '定时任务（需先发消息）', disabled: true, run: () => {} },
      );
    }
    items.push({ id: 'collapse-chat', label: '收起会话列', run: onCollapseChat });
    return items;
  }

  /** The permission mode pill: a real session opens ⑩, a pending one edits the creation parameter. */
  function openPermissionControl(event: React.MouseEvent, current: ChatSessionState): void {
    if (current.sessionId) {
      setShowPerms(true);
      return;
    }
    openMenu(
      event,
      permissionModeOptions(current.runtime, bypassAllowed).map((option) => ({
        id: `mode-${option.mode}`,
        label: PERMISSION_MODE_LABEL[option.mode],
        disabled: current.permissionMode === option.mode,
        run: () => setPermissionMode(option.mode),
      })),
    );
  }

  async function commitRename(): Promise<void> {
    const title = draft.trim();
    setRenaming(false);
    if (!chat || !chat.sessionId || !title || title === chat.title) return;
    const res = await api.renameSession(chat.sessionId, title);
    if (res.ok) {
      patchSessionTitle(chat.connectionId, chat.sessionId, title);
      patchChatTitle(chat.connectionId, chat.sessionId, title);
    }
  }

  const chatPanel = (
    <div className="chat-scroll-wrap">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {chat.historyLoading ? (
          <TranscriptSkeleton />
        ) : chat.messages.length === 0 ? (
          <div className="main-body">发送一条消息开始对话</div>
        ) : (
          <Transcript
            messages={chat.messages}
            scrollRef={scrollRef}
            runs={chat.runs}
            agentNames={
              sessionAgents.length > 0
                ? new Map(sessionAgents.map((agent) => [agent.id, agentDisplayName(agent)]))
                : undefined
            }
            leaderAgentId={leaderAgentId}
            onOpenTrace={(runId) => {
              setTraceRunId(runId);
              setTab('assistants');
            }}
          />
        )}
      </div>

      {showJump && (
        <button className="jump-latest" onClick={jumpToBottom} title="有新内容，跳到最新">
          ↓ 跳到最新
        </button>
      )}
    </div>
  );

  const traceAgentId = traceRunId
    ? (chat.runs.find((run) => run.id === traceRunId)?.agentId ?? null)
    : null;

  const assistantPanel = (
    <div className="assistant-page">
      <div className="chat-scroll">
        <AssistantTab
          sessionId={chat.sessionId}
          agents={sessionAgents}
          capacity={roomCapacity}
          workspaceAgents={workspaceAgents}
          chat={chat}
          onOpenTrace={(runId) => setTraceRunId(runId)}
          onChanged={refreshAgents}
        />
      </div>
      {traceRunId && (
        <RunTracePane
          // Keyed by run: everything this pane holds (the fetched snapshot, the
          // remembered speaker, the scroll position) describes one run. Switching
          // agents must start from a clean instance, not reconcile the previous
          // one — the render guard in the pane covers the content, this covers
          // the state around it.
          key={traceRunId}
          runId={traceRunId}
          chat={chat}
          agents={sessionAgents}
          agentId={traceAgentId}
          active={tab === 'assistants'}
          onClose={() => setTraceRunId(null)}
        />
      )}
    </div>
  );

  const tabs: TabItem[] = [
    { id: 'chat', label: '对话', content: chatPanel },
    {
      id: 'assistants',
      label: (
        <>
          助手
          {sessionAgents.length > 0 && <span className="tab-count">{sessionAgents.length}</span>}
          {awaitingAnswer && <span className="tab-ask">需回答</span>}
          {liveCount > 0 && <span className="tab-live" title="有回答正在进行或等待显示" />}
        </>
      ),
      disabled: !chat.sessionId && !chat.pendingNew,
      content: assistantPanel,
    },
  ];

  return (
    <div className="chat">
      <div className="chat-head">
        <div className="chat-head-main">
          {/*
            A session that does not exist yet has no title to edit — the daemon
            names it after the first prompt. The `sessionId` guard is structural,
            not just defensive: `renaming` is component-local and must never be
            able to put a text box where the "新会话" label belongs.
          */}
          {renaming && chat.sessionId ? (
            <input
              className="title-input"
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitRename();
                if (event.key === 'Escape') setRenaming(false);
              }}
            />
          ) : (
            <div
              className={`chat-title${chat.sessionId ? '' : ' no-rename'}`}
              title={
                chat.sessionId
                  ? `${chat.title ?? '未命名会话'}（点击重命名）`
                  : '标题由第一条消息生成'
              }
              onClick={() => {
                // The daemon names a new session after its first prompt; there
                // is nothing to rename until then.
                if (!chat.sessionId) return;
                setDraft(chat.title ?? '');
                setRenaming(true);
              }}
            >
              {chat.title ?? (chat.pendingNew ? '新会话' : '未命名会话')}
            </div>
          )}
          <div className="chat-sub">
            {/* The header names the room's leader, not whichever member last spoke. */}
            {(leaderBackend ?? chat.runtime) && (
              <RuntimeBadge id={(leaderBackend ?? chat.runtime)!} />
            )}
            {chat.cwd ? (
              <span className="mono cwd" title={chat.cwd}>
                {shortCwd(chat.cwd)}
              </span>
            ) : (
              workspaceName && <span>{workspaceName}</span>
            )}
            {chat.sessionId && workspaceId && (
              <SessionEndsChips sessionId={chat.sessionId} workspaceId={workspaceId} />
            )}
            {chat.permissionMode && (
              <button
                className="badge-btn"
                title={
                  chat.sessionId
                    ? '会话权限设置'
                    : '首条消息之前切换权限模式（随这条消息一起提交）'
                }
                onClick={(event) => openPermissionControl(event, chat)}
              >
                {permissionModeLabel(
                  clampPermissionMode(chat.permissionMode as ProductPermissionMode, bypassAllowed),
                )}
              </button>
            )}
          </div>
        </div>

        <div className="chat-head-actions">
          {(chat.sessionId || chat.pendingNew) && (
            <button
              className={`btn ghost${asideVisible ? ' active' : ''}`}
              title={asideVisible ? '收起文件栏' : '在右侧显示文件改动 / 全部文件'}
              onClick={onToggleAside}
            >
              <Icon name="panel-right" size={15} />
              文件
            </button>
          )}
          {chat.contextUsage ? <ContextRing usage={chat.contextUsage} /> : <ContextRingPlaceholder />}
          <RunStatus chat={chat} />
          <button
            className="icon-btn"
            title="更多操作"
            onClick={(event) => openMenu(event, overflowMenu(chat))}
          >
            <Icon name="more" size={16} />
          </button>
        </div>
      </div>

      <TabBar
        tabs={tabs}
        activeId={tab}
        onChange={(id) => setTab(id as ChatTab)}
        label="会话与助手"
        idPrefix={tabsId}
      />

      {/*
        Keyed by session: the strip's "was this list put away?" answer belongs to
        one conversation, and remounting is what makes the first render read the
        right one. Without the key the component survives a session switch and
        paints the previous session's dismissal for a frame.
      */}
      <TodoPanel key={chat.sessionId ?? 'new'} todos={chat.todos} sessionId={chat.sessionId} />

      {chat.error && (
        <div className="chat-banner error chat-banner-dismissible">
          <span>{chat.error}</span>
          <button
            className="chat-banner-close"
            title="关闭"
            aria-label="关闭"
            onClick={clearError}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {chat.phase === 'reconnecting' && <div className="chat-banner">连接中断，正在重连…</div>}
      {chat.phase === 'settled' && (
        <div className="chat-banner">该运行已结束（daemon 侧已不在运行），以上为已收到的事件。</div>
      )}

      {pending && !requiresModal(pending.toolName) && (
        <InlinePermissionCard
          permission={pending}
          queued={chat.permissions.queue.length}
          submitting={chat.permissions.submitting}
          inputError={chat.permissions.inputError}
          runtime={chat.runtime}
          onDecide={(decision, reason, response) => void decide(decision, reason, response)}
        />
      )}

      <TabPanels tabs={tabs} activeId={tab} idPrefix={tabsId} />

      {tab === 'chat' && (liveCount > 0 || awaitingAnswer !== null) && (
        <button
          className={`chat-live-status${awaitingAnswer ? ' attention' : ''}`}
          onClick={() => {
            // A blocked question opens the answer dialog again (dismissing it
            // earlier must not be a dead end). Other live work goes to the
            // assistant tab, where the per-run detail lives.
            if (awaitingAnswer) {
              setDismissedQuestions((current) =>
                current.filter((id) => id !== awaitingAnswer.message.id),
              );
              return;
            }
            // An open trace follows the jump when the target is unambiguous
            // (one agent running); with several, close it so the live cards
            // below — one per agent — are what the user picks from. A pane the
            // user never opened (or already closed) stays closed.
            setTraceRunId((open) => traceTargetOnJump(chat, open));
            setTab('assistants');
          }}
        >
          <span className="pending-answer-dot" />
          <span>{liveStatusText}</span>
          <span className="chat-live-status-link">
            {awaitingAnswer ? '去回答' : '查看助手'}
          </span>
        </button>
      )}

      <Composer
        disabled={busy || chat.historyLoading || chat.turnSending}
        busy={busy}
        placeholder={busy ? '任务正在运行…' : '给 Agent 发消息'}
        showModel={Boolean(chat.sessionId || chat.pendingNew)}
        model={chat.model}
        models={models}
        modelsError={modelsError}
        imagesSupported={models.find((option) => option.id === chat.model)?.supportsImages !== false}
        parameters={models.find((option) => option.id === chat.model)?.parameters ?? []}
        modelParameters={chat.modelParameters}
        onModelChange={(model) => {
          // Keep only knobs the new model still supports; the rest fall back
          // to that model's defaults.
          const supported = models.find((option) => option.id === model)?.parameters ?? [];
          const next = Object.fromEntries(
            Object.entries(chat.modelParameters).filter(([key, value]) =>
              supported.some(
                (parameter) =>
                  parameter.id === key && parameter.values.some((option) => option.id === value),
              ),
            ),
          );
          void setSessionSelection(model, next);
        }}
        onParameterChange={(parameterId, valueId) => {
          const next = { ...chat.modelParameters };
          if (valueId === null) delete next[parameterId];
          else next[parameterId] = valueId;
          void setSessionSelection(chat.model, next);
        }}
        onSend={(text, attachmentIds, mentionIds) => {
          // One interactive path: create the session lazily if needed, open the
          // room stream, then POST a turn. Single-agent sessions simply route
          // that turn to the leader.
          void send(text, attachmentIds, mentionIds).then(() => refreshAgents());
        }}
        canStop={!busy && roomRunning}
        onStop={stop}
        mentionAgents={workspaceAgents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          summary: agent.summary,
          available: agent.available,
          heavy: agent.heavy,
          member: sessionAgents.some((member) => member.id === agent.id),
        }))}
      />

      <ContextMenu menu={menu} onClose={closeMenu} />

      {showPerms && chat.sessionId && (
        <SessionPermissionsDialog
          sessionId={chat.sessionId}
          runtime={chat.runtime}
          onClose={() => setShowPerms(false)}
          onModeChanged={(mode) => setPermissionMode(mode)}
        />
      )}

      {awaitingAnswer && !dismissedQuestions.includes(awaitingAnswer.message.id) && !pending && (
        <QuestionDialog
          answer={awaitingAnswer}
          agentName={awaitingName}
          onClose={() =>
            setDismissedQuestions((current) =>
              current.includes(awaitingAnswer.message.id)
                ? current
                : [...current, awaitingAnswer.message.id],
            )
          }
        />
      )}

      {pending && requiresModal(pending.toolName) && (
        <PermissionDialog
          permission={pending}
          queued={chat.permissions.queue.length}
          submitting={chat.permissions.submitting}
          inputError={chat.permissions.inputError}
          runtime={chat.runtime}
          onDecide={(decision, reason, response) => void decide(decision, reason, response)}
        />
      )}
    </div>
  );
}

function RunStatus({ chat }: { chat: ChatSessionState }) {
  switch (chat.phase) {
    case 'connecting':
      return <span className="run-pill live">连接中…</span>;
    case 'live':
      return <span className="run-pill live">执行中…</span>;
    case 'reconnecting':
      return <span className="run-pill warn">重连中…</span>;
    case 'gaveup':
      return <span className="run-pill error">已断开</span>;
    case 'settled':
      return <span className="run-pill">已结束</span>;
    default: {
      const last = chat.messages[chat.messages.length - 1];
      if (!last || last.kind !== 'assistant') return null;
      if (last.error) return <span className="run-pill error">失败</span>;
      return last.done ? <span className="run-pill ok">完成</span> : null;
    }
  }
}

/**
 * Occupancy of the context window. No number on the ring itself (it is too
 * small to read) — the exact `45.2k / 168k · 27%` lives in the tooltip. With no
 * reported capacity it degrades to mono text rather than inventing a
 * denominator.
 */
function ContextRing({ usage }: { usage: NonNullable<ChatSessionState['contextUsage']> }) {
  const percent = contextPercent(usage);
  if (percent === null) {
    return (
      <span className="ctx-text mono" title={formatContextUsage(usage)}>
        {formatContextUsage(usage)}
      </span>
    );
  }
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  return (
    <span className="ctx-ring" title={formatContextUsage(usage)}>
      <svg width="24" height="24" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r={radius} fill="none" stroke="var(--border)" strokeWidth="2.5" />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - percent / 100)}
          transform="rotate(-90 12 12)"
        />
      </svg>
    </span>
  );
}

/**
 * No run has reported usage yet — a session that has not sent its first message,
 * or a runtime that never sends `usage`. Draws the same empty track a 0% ring
 * would: it holds the ring's place so the header does not shift when real data
 * arrives, without inventing a number.
 */
function ContextRingPlaceholder() {
  return (
    <span className="ctx-ring" title="还没有上下文用量（发出第一条消息后显示）">
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r={9} fill="none" stroke="var(--border)" strokeWidth="2.5" />
      </svg>
    </span>
  );
}

/** `…/OpenProject/paboot`: the tail identifies the directory, the prefix does not. */
function shortCwd(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join('/')}`;
}
