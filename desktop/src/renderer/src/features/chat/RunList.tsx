import { useState } from 'react';
import type { RunDto } from '../../../../shared/contract';
import { api } from '../../ipc/client';
import { useChat } from '../../store/chat';

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  queued: '排队',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  rolled_back: '已回滚',
};

interface Props {
  runs: RunDto[];
  connectionId: string;
  sessionId: string | null;
  /** Switch the files view to this run's checkpoint diff. */
  onViewChanges(runId: string): void;
}

/**
 * The session's runs, newest first. Each row can show that run's checkpoint diff
 * or roll the workspace back to before it — including runs that are not the
 * latest, which is the whole point of listing them.
 */
export function RunList({ runs, connectionId, sessionId, onViewChanges }: Props) {
  const [confirm, setConfirm] = useState<{ runId: string; needForce: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function doRollback(runId: string, force: boolean): Promise<void> {
    setBusy(true);
    setNotice(null);
    const res = await api.runRollback(runId, force);
    setBusy(false);
    if (res.ok) {
      setConfirm(null);
      // Reload the session so the tree, run statuses and the synthetic note all
      // reflect the rollback.
      if (sessionId) void useChat.getState().openSession(connectionId, sessionId);
      return;
    }
    const data = res.data as { code?: string; error?: string };
    if (data?.code === 'later_runs_exist') {
      setConfirm({ runId, needForce: true });
      return;
    }
    setConfirm(null);
    setNotice(data?.error ?? '回滚失败');
  }

  if (runs.length === 0) return <div className="run-list-empty">暂无运行记录</div>;

  return (
    <div className="run-list">
      {notice && <div className="run-list-notice">{notice}</div>}
      {[...runs].reverse().map((run) => {
        const canDiff = run.checkpoint?.status === 'complete';
        const canRollback = Boolean(run.checkpoint?.preRef) && run.status !== 'rolled_back';
        const pending = confirm?.runId === run.id;
        return (
          <div key={run.id} className="run-row">
            <div className="run-row-main">
              <span className={`run-status run-status-${run.status}`}>
                {STATUS_LABEL[run.status] ?? run.status}
              </span>
              <span className="run-prompt" title={run.prompt}>
                {run.prompt}
              </span>
            </div>
            <div className="run-row-time">{new Date(run.startedAt).toLocaleString()}</div>
            <div className="run-row-actions">
              {canDiff && (
                <button className="btn ghost tiny" onClick={() => onViewChanges(run.id)}>
                  改动
                </button>
              )}
              {canRollback &&
                (pending ? (
                  <>
                    <button className="btn danger tiny" disabled={busy} onClick={() => void doRollback(run.id, confirm.needForce)}>
                      {confirm.needForce ? '丢弃后续并回滚' : '确认回滚'}
                    </button>
                    <button className="btn ghost tiny" disabled={busy} onClick={() => setConfirm(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button className="btn ghost tiny" onClick={() => setConfirm({ runId: run.id, needForce: false })}>
                    回滚
                  </button>
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
