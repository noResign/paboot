import { useState } from 'react';
import { api } from '../../ipc/client';
import { useChat } from '../../store/chat';
import { agentDisplayName } from './agentLabel';
import { hasUnansweredQuestion } from './conversationSegments';
import { listLiveAnswers } from './liveAnswers';
import { apiErrorOf, friendlyMessage } from '../../../../shared/errors';
import type { ChatMessage, ChatSessionState } from '../../store/chat/types';
import type { AgentProfileDto, SessionAgentDto } from '../../../../shared/contract';

interface Props {
  sessionId: string | null;
  agents: SessionAgentDto[];
  workspaceAgents: AgentProfileDto[];
  chat: ChatSessionState;
  onOpenTrace(runId: string): void;
  onChanged(): void;
}

/**
 * The assistant tab: live work first, then room membership.
 *
 * Live answers deliberately live here rather than in the conversation
 * transcript. The conversation is reserved for finalized messages, so a long
 * answer cannot keep growing above messages the user sent after it.
 */
export function AssistantTab({
  sessionId,
  agents,
  workspaceAgents,
  chat,
  onOpenTrace,
  onChanged,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<SessionAgentDto | null>(null);

  function errorText(res: { status: number; data: unknown }): string {
    const { apiCode, message } = apiErrorOf(res.data);
    return friendlyMessage(apiCode, res.status, message, '操作失败');
  }

  async function run(action: () => Promise<{ ok: boolean; status: number; data: unknown }>) {
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      if (!res.ok) {
        setError(errorText(res));
        return;
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Stop one agent's queued/running answer; the store owns the optimistic row. */
  async function cancelTask(taskId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const ok = await useChat.getState().cancelTask(taskId);
      if (!ok) setError('这个任务可能已经结束，已刷新');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  function agentName(agentId: string | null | undefined): string {
    if (!agentId) return '助手';
    const member = agents.find((agent) => agent.id === agentId);
    if (member) return agentDisplayName(member);
    return workspaceAgents.find((agent) => agent.id === agentId)?.name ?? '助手';
  }

  function messageText(message: Extract<ChatMessage, { kind: 'assistant' }>): string {
    const text = message.blocks
      .filter((block) => block.kind === 'text')
      .map((block) => (block.kind === 'text' ? block.text : ''))
      .join('\n')
      .trim();
    if (text) return text;
    if (message.blocks.some((block) => block.kind === 'thinking' && block.active)) return '思考中…';
    return '';
  }

  function toolCount(message: Extract<ChatMessage, { kind: 'assistant' }>): number {
    return message.blocks.filter((block) => block.kind === 'tool').length;
  }

  const addable = workspaceAgents.filter(
    (candidate) => !agents.some((member) => member.id === candidate.id),
  );
  // Room answers live in pendingAnswers, per-run streams in messages; both are
  // live work the user can see and, for a question, act on.
  const liveRows = listLiveAnswers(chat).sort(
    (a, b) =>
      Number(hasUnansweredQuestion(b.message.blocks)) -
      Number(hasUnansweredQuestion(a.message.blocks)),
  );
  const liveCount =
    (chat.turnSending ? 1 : 0) +
    liveRows.length +
    chat.dispatchedTasks.length +
    chat.displayQueue.length;

  return (
    <div className="assistant-tab">
      <section className="assistant-live">
        <div className="assistant-section-head">
          <b>当前协作</b>
          <span>{liveCount > 0 ? `${liveCount} 项进行中 / 待显示` : '当前没有进行中的回答'}</span>
        </div>

        {chat.turnSending && (
          <div className="live-row">
            <span className="pending-answer-dot" />
            <b>消息</b>
            <span>已发出，正在建立房间连接…</span>
          </div>
        )}

        {chat.dispatchedTasks.map((task) => {
          const live =
            chat.pendingAnswers.some((answer) => answer.agentId === task.agentId) ||
            chat.messages.some(
              (message) =>
                message.kind === 'assistant' && message.agentId === task.agentId && !message.done,
            );
          return (
            <div className="live-row" key={task.taskId}>
              <span className="pending-answer-dot" />
              <b>{agentName(task.agentId)}</b>
              <span>{live ? '排队中，等待当前回答结束…' : '已收到任务，准备回答…'}</span>
              <button
                className="btn ghost live-row-stop"
                title="只取消这个排队中的任务，其他助手继续"
                disabled={busy}
                onClick={() => void cancelTask(task.taskId)}
              >
                停止
              </button>
            </div>
          );
        })}

        {liveRows.map((answer) => {
          const text = messageText(answer.message);
          const tools = toolCount(answer.message);
          const awaiting = hasUnansweredQuestion(answer.message.blocks);
          return (
            <div
              className={`assistant-live-card${awaiting ? ' awaiting' : ''}`}
              key={answer.runId}
              role="button"
              tabIndex={0}
              onClick={() => onOpenTrace(answer.runId)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onOpenTrace(answer.runId);
              }}
              title={awaiting ? '打开并回答问题' : '查看实时运行轨迹'}
            >
              <div className="assistant-live-head">
                <span className="pending-answer-dot" />
                <b>{agentName(answer.agentId)}</b>
                <span>正在回答</span>
                {awaiting && <span className="badge ask">需要回答</span>}
                {answer.taskId && (
                  <button
                    className="btn ghost"
                    title="只停止这个助手的回答，其他任务继续"
                    disabled={busy}
                    onClick={(event) => {
                      // The card itself opens the trace; the stop is a local action.
                      event.stopPropagation();
                      void cancelTask(answer.taskId!);
                    }}
                  >
                    停止
                  </button>
                )}
                <span className="assistant-live-open">
                  {awaiting ? '去回答 ›' : '查看轨迹 ›'}
                </span>
              </div>
              {text && <div className="assistant-live-text">{text}</div>}
              {tools > 0 && <div className="assistant-live-meta">{tools} 个工具调用</div>}
            </div>
          );
        })}

        {chat.displayQueue.map((answer) => (
          <div className="live-row" key={answer.runId}>
            <span className="pending-answer-dot ready" />
            <b>{agentName(answer.agentId)}</b>
            <span>已就绪，稍后显示…</span>
          </div>
        ))}
      </section>

      <section className="assistant-roster">
        <div className="assistant-section-head">
          <b>房间成员</b>
          <span>{agents.length} 个助手</span>
        </div>
        {agents.length === 0 && <div className="hint">发送第一条消息后，这里会显示会话成员。</div>}
        {agents.map((agent) => {
          const live = chat.pendingAnswers.some((answer) => answer.agentId === agent.id);
          const queued = chat.dispatchedTasks.some((task) => task.agentId === agent.id);
          const ready = chat.displayQueue.some((answer) => answer.agentId === agent.id);
          return (
          <div className="assistant-member" key={agent.id}>
            <div className="assistant-member-main">
              <div className="assistant-member-name">
                <b>{agentDisplayName(agent)}</b>
                {agent.role === 'leader' && <span className="badge">主答</span>}
                {agent.heavy && <span className="badge">外部 CLI</span>}
                {live && <span className="badge">正在回答</span>}
                {!live && queued && <span className="badge">排队中</span>}
                {!live && !queued && ready && <span className="badge">已就绪</span>}
              </div>
              <div className="hint">
                {agent.available ? agent.summary || agent.backend : agent.enabled ? '当前离线' : '已停用'}
                {agent.hasContext ? ' · 已有自己的上下文' : ''}
              </div>
            </div>
            <div className="assistant-member-actions">
              {agent.taskId && agent.taskStatus && (
                <button
                  className="btn ghost"
                  title={
                    agent.taskStatus === 'running'
                      ? '停止这个助手当前的回答'
                      : '取消这个助手排队中的任务'
                  }
                  disabled={busy}
                  onClick={() => void cancelTask(agent.taskId!)}
                >
                  停止
                </button>
              )}
              {agent.hasContext && (
                <button
                  className="btn ghost"
                  // The daemon refuses this mid-run; disabling here explains it
                  // before the user commits to the click.
                  disabled={busy || live || queued}
                  title={live || queued ? '正在回答，结束后再重置' : undefined}
                  onClick={() => setConfirmReset(agent)}
                >
                  重置上下文
                </button>
              )}
              {agent.role !== 'leader' && sessionId && (
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => void run(() => api.removeSessionAgent(sessionId, agent.id))}
                >
                  移出
                </button>
              )}
            </div>
          </div>
          );
        })}
      </section>

      {sessionId && (
        <section className="assistant-roster">
          <div className="assistant-section-head">
            <b>拉入已有助手</b>
            <span>{addable.length} 个可选</span>
          </div>
          {addable.length === 0 ? (
            <div className="hint">
              这个工作区没有其他可加入的助手。新的助手在 <b>设置 → 助手</b> 里创建。
            </div>
          ) : (
            <div className="agent-picker">
              {addable.map((candidate) => (
                <button
                  key={candidate.id}
                  className="agent-option"
                  disabled={!candidate.available || busy}
                  title={candidate.summary || candidate.backend}
                  onClick={() => void run(() => api.addSessionAgent(sessionId, candidate.id))}
                >
                  <span>{candidate.name}</span>
                  {!candidate.available && (
                    <span className="badge">{candidate.enabled ? '离线' : '已停用'}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="hint">一个房间最多一个可写助手；其他成员以只读身份加入。</div>
        </section>
      )}

      {error && <div className="error-text">{error}</div>}

      {confirmReset && sessionId && (
        <div className="modal-scrim" onClick={() => setConfirmReset(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <span>重置「{agentDisplayName(confirmReset)}」的上下文？</span>
            </div>
            <div className="hint">
              房间里的历史记录会保留，但它的下一次发言会从新的上下文开始。
              <br />
              <br />
              这不会清掉 runtime 自己保存的记忆（例如 Claude 的项目记忆）—— 那部分不归 paboot 管。
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmReset(null)}>
                取消
              </button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => {
                  const target = confirmReset;
                  setConfirmReset(null);
                  void run(() => api.resetAgentContext(sessionId, target.id));
                }}
              >
                重置
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
