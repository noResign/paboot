import { useEffect, useState } from 'react';
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
import { Composer } from './Composer';
import { useStickToBottom } from './useStickToBottom';
import { transcriptSignature } from './transcriptSignature';
import { TodoPanel } from './TodoPanel';
import { PermissionDialog, InlinePermissionCard } from '../permissions/PermissionDialog';
import { AssistantDialog } from './AssistantDialog';
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
  const sendTurn = useChat((state) => state.sendTurn);
  const ensureRoomStream = useChat((state) => state.ensureRoomStream);
  const closeRoomStream = useChat((state) => state.closeRoomStream);
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
  const [showAssistants, setShowAssistants] = useState(false);
  /** 这台 daemon 是否支持助手功能；404 = 老版本，入口隐藏而不是点了没反应。 */
  const [agentsSupported, setAgentsSupported] = useState(false);
  /** 名册用来把消息上的 agentId 翻成显示名；只有一个成员时不标注。 */
  const [sessionAgents, setSessionAgents] = useState<SessionAgentDto[]>([]);
  /** 工作区里的 agent：@ 的候选池；点名一个非成员会把会话升级成群聊。 */
  const [workspaceAgents, setWorkspaceAgents] = useState<AgentProfileDto[]>([]);
  // Rollback is destructive: two-step confirm, and a second step when it would
  // also discard later runs.
  const [rollback, setRollback] = useState<{ runId: string; needForce: boolean; laterRuns?: number } | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackNotice, setRollbackNotice] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOptionDto[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  /** A room (not a plain chat): the roster is the switch, not a session kind. */
  const isGroup = sessionAgents.length > 1;
  /** Once a room stream exists, every send must go through `/turns`. */
  const roomMode = isGroup || Boolean(chat?.roomStreamId);

  // Probe once per session: the assistant endpoints only exist on a daemon that
  // knows about agents. A 404 hides the entry rather than offering a menu item
  // that does nothing.
  useEffect(() => {
    const sessionId = chat?.sessionId;
    if (!sessionId) {
      setAgentsSupported(false);
      return;
    }
    let live = true;
    void api.sessionAgents(sessionId).then((res) => {
      if (!live) return;
      setAgentsSupported(res.ok);
      setSessionAgents(res.ok ? res.data.agents : []);
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

  // A room's answers arrive on one multiplexed stream instead of a per-run one.
  // Opening it is idempotent; adding the second member is what starts it.
  useEffect(() => {
    if (!chat?.sessionId) return;
    if (isGroup) {
      void ensureRoomStream();
    } else {
      // Back to one assistant: that path streams per run, so the room stream
      // must not stay open feeding the same frames twice.
      closeRoomStream();
    }
  }, [chat?.sessionId, isGroup, ensureRoomStream, closeRoomStream]);

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
  // the store), so local rollback state would otherwise follow the user to the
  // next session. A confirmation/notice belongs to the session it was raised in.
  // The same goes for an open rename box: leaving it set would put the previous
  // session's title into an input over the new one — including a session that
  // has no title to rename yet.
  useEffect(() => {
    setRollback(null);
    setRollbackBusy(false);
    setRollbackNotice(null);
    setRenaming(false);
    setDraft('');
  }, [chat?.key]);

  // The success notice is informational — it should not sit above the
  // transcript forever.
  useEffect(() => {
    if (!rollbackNotice) return;
    const timer = setTimeout(() => setRollbackNotice(null), 6_000);
    return () => clearTimeout(timer);
  }, [rollbackNotice]);

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
      if (agentsSupported) {
        items.push({
          id: 'assistants',
          label: '助手 / 群聊…',
          run: () => setShowAssistants(true),
        });
      }
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

  async function doRollback(): Promise<void> {
    const target = rollback?.runId;
    if (!target) return;
    const sessionKey = useChat.getState().activeKey;
    setRollbackBusy(true);
    setRollbackNotice(null);
    const res = await api.runRollback(target, rollback.needForce);
    setRollbackBusy(false);
    // The user may have switched sessions while the request was in flight; the
    // result must not be painted onto the newly opened one.
    if (useChat.getState().activeKey !== sessionKey) return;
    if (res.ok) {
      setRollback(null);
      setRollbackNotice('已回滚（agent 对话未回退）');
      // Reload the session: runs, statuses, the tree and the synthetic note.
      if (chat?.sessionId) void useChat.getState().openSession(chat.connectionId, chat.sessionId);
      return;
    }
    const data = res.data as { code?: string; laterRuns?: number; error?: string };
    if (data?.code === 'later_runs_exist') {
      setRollback({ runId: target, needForce: true, laterRuns: data.laterRuns });
      return;
    }
    setRollback(null);
    setRollbackNotice(data?.error ?? '回滚失败');
  }

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
            {chat.runtime && <RuntimeBadge id={chat.runtime} />}
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

      <TodoPanel todos={chat.todos} />

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
      {rollback && (
        <div className="chat-banner rollback-confirm">
          <span>
            {rollback.needForce
              ? '该运行之后还有更晚的运行，回滚会把它们一并丢弃。文件恢复到该运行之前，agent 对话不回退。'
              : '把工作区文件恢复到这次发送之前？该轮及之后的文件改动会被覆盖，agent 对话不回退，此操作难以撤销。'}
          </span>
          <button className="btn danger" disabled={rollbackBusy} onClick={() => void doRollback()}>
            {rollback.needForce ? `丢弃后续 ${rollback.laterRuns} 轮并回滚` : '确认回滚'}
          </button>
          <button className="btn ghost" disabled={rollbackBusy} onClick={() => setRollback(null)}>
            取消
          </button>
        </div>
      )}
      {rollbackNotice && <div className="chat-banner">{rollbackNotice}</div>}
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
                sessionAgents.length > 1
                  ? new Map(sessionAgents.map((agent) => [agent.id, agent.name]))
                  : undefined
              }
              onRollback={(runId) => setRollback({ runId, needForce: false })}
            />
          )}
        </div>

        {showJump && (
          <button className="jump-latest" onClick={jumpToBottom} title="有新内容，跳到最新">
            ↓ 跳到最新
          </button>
        )}
      </div>

      {/* 进行区：答案定稿（run 终止）前不进时间线，避免慢的那位把已完成
          的回答挤到新问题上面。这里只展示预览，提交后落到时间线底部。 */}
      {chat.pendingAnswers.length > 0 && (
        <div className="pending-answers">
          {chat.pendingAnswers.map((answer) => {
            const name =
              sessionAgents.find((agent) => agent.id === answer.agentId)?.name ?? '助手';
            const text = answer.message.blocks
              .map((block) => (block.kind === 'text' ? block.text : ''))
              .filter(Boolean)
              .join(' ')
              .trim();
            return (
              <div className="pending-answer" key={answer.runId}>
                <span className="pending-answer-dot" aria-hidden="true" />
                <b>{name}</b>
                <span className="pending-answer-text">{text ? text.slice(-220) : '正在回答…'}</span>
              </div>
            );
          })}
        </div>
      )}

      <Composer
        disabled={busy || chat.historyLoading}
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
          // `@` is workspace-level: mentioning someone outside the room makes
          // this send a turn, and the daemon admits them before routing. A room
          // (or a send that already opened its stream) always takes this path.
          const mentions = mentionIds ?? [];
          if (chat.sessionId && !attachmentIds?.length && (roomMode || mentions.length > 0)) {
            void sendTurn(text, mentions).then(() => refreshAgents());
            return;
          }
          // A new session's first message, or a single-agent send with images.
          void send(text, attachmentIds);
        }}
        onStop={stop}
        mentionAgents={workspaceAgents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          summary: agent.summary,
          available: agent.available,
          heavy: agent.heavy,
          member: sessionAgents.some((member) => member.id === agent.id),
        }))}
        attachmentsEnabled={!roomMode}
      />

      <ContextMenu menu={menu} onClose={closeMenu} />

      {showAssistants && chat.sessionId && (
        <AssistantDialog
          sessionId={chat.sessionId}
          onChanged={refreshAgents}
          onClose={() => {
            setShowAssistants(false);
            refreshAgents();
          }}
        />
      )}

      {showPerms && chat.sessionId && (
        <SessionPermissionsDialog
          sessionId={chat.sessionId}
          runtime={chat.runtime}
          onClose={() => setShowPerms(false)}
          onModeChanged={(mode) => setPermissionMode(mode)}
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
