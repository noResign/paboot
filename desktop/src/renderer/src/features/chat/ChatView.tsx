import { useEffect, useState } from 'react';
import { useChat } from '../../store/chat';
import { api } from '../../ipc/client';
import { useSessions } from '../../store/sessions';
import { formatContextUsage, contextPercent } from '../../../../shared/format';
import { PERMISSION_MODE_LABEL } from '../../../../shared/runtime-identity';
import { RuntimeBadge } from '../../ui/RuntimeIcon';
import { comboLabel } from '../../shortcuts/shortcuts';
import { IS_MAC } from '../../ui/platform';
import { requiresModal } from '../../store/chat/permissions';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { useStickToBottom } from './useStickToBottom';
import { transcriptSignature } from './transcriptSignature';
import { TodoPanel } from './TodoPanel';
import { PermissionDialog, InlinePermissionCard } from '../permissions/PermissionDialog';
import { SessionPermissionsDialog } from '../permissions/SessionPermissionsDialog';
import { TranscriptSkeleton } from '../../ui/Skeleton';
import type { ChatSessionState } from '../../store/chat/types';
import type { ModelOptionDto } from '../../../../shared/contract';

interface Props {
  workspaceName: string | null;
  asideVisible: boolean;
  onToggleAside(): void;
  /** Collapse the conversation column so the right panel gets the width. */
  onCollapseChat(): void;
}

export function ChatView({ workspaceName, asideVisible, onToggleAside, onCollapseChat }: Props) {
  const chat = useChat((state) => (state.activeKey ? state.byKey[state.activeKey] : undefined));
  const send = useChat((state) => state.send);
  const stop = useChat((state) => state.stop);
  const decide = useChat((state) => state.decide);
  const patchSessionTitle = useSessions((state) => state.patchTitle);
  const patchChatTitle = useChat((state) => state.patchTitle);
  const setPermissionMode = useChat((state) => state.setPermissionMode);
  const setSessionSelection = useChat((state) => state.setSessionSelection);

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [showPerms, setShowPerms] = useState(false);
  // Rollback is destructive: two-step confirm, and a second step when it would
  // also discard later runs.
  const [rollback, setRollback] = useState<{ runId: string; needForce: boolean; laterRuns?: number } | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackNotice, setRollbackNotice] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOptionDto[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // The catalogue belongs to the runtime. The daemon caches it, so refetching
  // per session is cheap after the first call.
  useEffect(() => {
    const sessionId = chat?.sessionId;
    const runtime = chat?.runtime;
    setModelsError(null);
    if (!sessionId || !runtime) {
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
  }, [chat?.sessionId, chat?.runtime]);

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
    setRollbackBusy(true);
    setRollbackNotice(null);
    const res = await api.runRollback(target, rollback.needForce);
    setRollbackBusy(false);
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
          {renaming ? (
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
              className="chat-title"
              title={chat.sessionId ? '点击重命名' : '新会话'}
              onClick={() => {
                setDraft(chat.title ?? '');
                setRenaming(true);
              }}
            >
              {chat.title ?? (chat.pendingNew ? '新会话' : '未命名会话')}
            </div>
          )}
          <div className="chat-sub">
            {chat.runtime && <RuntimeBadge id={chat.runtime} />}
            {workspaceName && <span>{workspaceName}</span>}
            <span className="mono cwd" title={chat.cwd ?? ''}>
              {chat.cwd ?? ''}
            </span>
            {chat.permissionMode && <span className="badge">{PERMISSION_MODE_LABEL[chat.permissionMode as 'ask'] ?? chat.permissionMode}</span>}
          </div>
        </div>

        <div className="chat-head-actions">
          <button className="btn ghost" title="收起会话，把宽度让给右侧文件栏" onClick={onCollapseChat}>
            ⇤
          </button>
          {chat.sessionId && (
            <button
              className={`btn ghost${asideVisible ? ' active' : ''}`}
              title={asideVisible ? '收起文件右栏' : '在右侧显示文件改动 / 全部文件'}
              onClick={onToggleAside}
            >
              ◧ 文件
            </button>
          )}
          {chat.contextUsage && <ContextRing usage={chat.contextUsage} />}
          <RunStatus chat={chat} />
          {busy && (
            <button className="btn" onClick={stop} title={`停止当前运行 ${comboLabel('stop-run', IS_MAC)}`}>
              停止
            </button>
          )}
          {chat.sessionId && (
            <button className="btn ghost" title="会话权限设置" onClick={() => setShowPerms(true)}>
              ⚙
            </button>
          )}
        </div>
      </div>

      <TodoPanel todos={chat.todos} />

      {chat.error && <div className="chat-banner error">{chat.error}</div>}
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
      {chat.phase === 'reconnecting' && <div className="chat-banner">● 连接中断，正在重连…</div>}
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
            onRollback={(runId) => setRollback({ runId, needForce: false })}
          />
        )}
      </div>

      {showJump && (
        <button className="jump-latest" onClick={jumpToBottom} title="有新内容，跳到最新">
          ↓ 跳到最新
        </button>
      )}

      <Composer
        disabled={busy || chat.historyLoading}
        busy={busy}
        notice={
          busy
            ? '该会话正在运行，输入暂时禁用 —— 运行中的任务在 daemon 上执行，切换会话不受影响。'
            : null
        }
        placeholder={busy ? '任务正在运行…' : '给 Agent 发消息'}
        showModel={Boolean(chat.sessionId)}
        model={chat.model}
        models={models}
        modelsError={modelsError}
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
        onSend={(text) => void send(text)}
      />

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
      return <span className="run-status">● 正在连接…</span>;
    case 'live':
      return <span className="run-status">● 正在执行…</span>;
    case 'reconnecting':
      return <span className="run-status warn">⟳ 重连中…</span>;
    case 'gaveup':
      return <span className="run-status error">✗ 连接已断开</span>;
    case 'settled':
      return <span className="run-status">✓ 已结束</span>;
    default: {
      const last = chat.messages[chat.messages.length - 1];
      if (!last || last.kind !== 'assistant') return null;
      if (last.error) return <span className="run-status error">✗ 失败</span>;
      return last.done ? <span className="run-status ok">✓ 完成</span> : null;
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
