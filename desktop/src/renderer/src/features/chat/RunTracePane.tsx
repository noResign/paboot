import { useEffect, useRef, useState } from 'react';
import { api } from '../../ipc/client';
import { agentDisplayName } from './agentLabel';
import { AssistantRow } from './Transcript';
import { buildAssistantFromEvents } from '../../store/chat/applyEvent';
import { Icon } from '../../ui/Icon';
import { findLiveAnswer } from './liveAnswers';
import { useStickToBottom } from './useStickToBottom';
import { transcriptSignature } from './transcriptSignature';
import { pickTraceMessage } from './traceMessage';
import type { ChatMessage, ChatSessionState } from '../../store/chat/types';
import type { SessionAgentDto } from '../../../../shared/contract';

interface Props {
  runId: string;
  chat: ChatSessionState;
  agents: SessionAgentDto[];
  /** The run's owner, when the session's run list already knows it. */
  agentId: string | null;
  /**
   * The assistant tab is the visible one. The panel itself is keep-alive, so a
   * re-entry refreshes the fetched trace instead of remounting (and must not
   * drop the user's chosen run).
   */
  active: boolean;
  onClose(): void;
}

/**
 * The right-hand run trace.
 *
 * It sits beside the assistant tab instead of replacing its content, so opening
 * a trace does not lose the roster/live view the user was reading. A live run
 * renders straight from `pendingAnswers`; a finished one is replayed from the
 * run's persisted events.
 */
export function RunTracePane({ runId, chat, agents, agentId, active, onClose }: Props) {
  const [trace, setTrace] = useState<Extract<ChatMessage, { kind: 'assistant' }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const traceAgentId = useRef<string | null>(null);

  const liveTrace = findLiveAnswer(chat, runId);
  const liveTraceAgentId = liveTrace?.agentId ?? null;
  // Remembered so a finished run's replay can still name its speaker: the new
  // run is usually not in `chat.runs` yet, so the `agentId` prop is still null
  // when the fetch lands. No reset on `runId` is needed — the pane is keyed by
  // run in `ChatView`, so switching runs mounts a fresh ref.
  useEffect(() => {
    if (liveTraceAgentId) traceAgentId.current = liveTraceAgentId;
  }, [liveTraceAgentId]);

  useEffect(() => {
    if (liveTrace) {
      setTrace(null);
      setError(null);
      return;
    }
    let live = true;
    setError(null);
    // Re-entering the tab re-runs this effect. Keep the snapshot already on
    // screen (no flicker); drop it only when the pane switched runs.
    setTrace((current) => (current?.runId === runId ? current : null));
    void api.runEvents(runId).then((res) => {
      if (!live) return;
      if (!res.ok) {
        setError(`无法读取运行过程（HTTP ${res.status}）`);
        return;
      }
      const rebuilt = buildAssistantFromEvents(res.data.events, () => `trace-${runId}`);
      setTrace({
        ...rebuilt.assistant,
        runId,
        agentId: agentId ?? traceAgentId.current,
      });
    });
    return () => {
      live = false;
    };
  }, [runId, liveTrace?.runId, agentId, active]);

  // Not `liveTrace?.message ?? trace`: the clear in the effect above happens
  // after paint, so `trace` can still hold the previously opened run's
  // snapshot. Showing it and replacing it a moment later is exactly the
  // "still shows the last agent" behaviour.
  const message = pickTraceMessage(liveTrace, trace, runId);
  // The live trace keeps growing at the bottom; follow it unless the user scrolls up.
  const { ref: bodyRef, onScroll } = useStickToBottom({
    resetKey: runId,
    signature: message ? transcriptSignature([message]) : 'empty',
  });

  return (
    <aside className="trace-pane">
      <div className="trace-pane-head">
        <b>运行轨迹{liveTrace ? ' · 实时' : ''}</b>
        <button className="icon-btn" title="关闭轨迹" aria-label="关闭轨迹" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="trace-pane-body" ref={bodyRef} onScroll={onScroll}>
        {error && <div className="error-text">{error}</div>}
        {!message && !error && <div className="hint">正在读取运行过程…</div>}
        {message && (
          <AssistantRow
            message={message}
            agentNames={new Map(agents.map((agent) => [agent.id, agentDisplayName(agent)]))}
            // Only a live answer can be answered from here; a fetched trace is
            // a historical record whose permission/question already settled.
            interactive={Boolean(liveTrace)}
          />
        )}
      </div>
    </aside>
  );
}
