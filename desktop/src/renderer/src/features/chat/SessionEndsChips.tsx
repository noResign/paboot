import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../ipc/client';
import type { EndDto } from '../../../../shared/contract';

type SessionEnd = EndDto & { role: string };

/** Session header chips: primary + up to three ends, click to narrow the set. */
export function SessionEndsChips({
  sessionId,
  workspaceId,
}: {
  sessionId: string;
  workspaceId: string;
}) {
  const [sessionEnds, setSessionEnds] = useState<SessionEnd[]>([]);
  const [available, setAvailable] = useState<EndDto[]>([]);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  const load = useCallback(async () => {
    const [session, workspace] = await Promise.all([
      api.sessionEnds(sessionId),
      api.workspaceEnds(workspaceId),
    ]);
    if (session.ok) {
      setSessionEnds(session.data.ends);
      setPrimaryId(session.data.primaryEndId);
    }
    if (workspace.ok) {
      setAvailable(workspace.data.ends.filter((end) => end.status === 'active'));
    }
  }, [sessionId, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Close on any click outside the chips/popover, not just on the trigger.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const primary = sessionEnds.find((end) => end.id === primaryId) ?? sessionEnds[0] ?? null;
  const others = sessionEnds.filter((end) => end.id !== primary?.id);
  const narrowed = available.length > 0 && sessionEnds.length < available.length;

  async function save(next: string[] | null): Promise<void> {
    setBusy(true);
    const res = await api.setSessionEnds(sessionId, next);
    setBusy(false);
    if (!res.ok) return;
    setSessionEnds(res.data.ends);
    setPrimaryId(res.data.primaryEndId);
  }

  function toggle(endId: string): void {
    const ids = sessionEnds.map((end) => end.id);
    const next = ids.includes(endId) ? ids.filter((id) => id !== endId) : [...ids, endId];
    // An empty set means "default" (every active end), matching the API.
    void save(next.length > 0 ? next : null);
  }

  if (!primary) return null;

  return (
    <span className="end-chips" ref={rootRef}>
      <button
        className="end-chip primary"
        title={narrowed ? '会话已收窄可用端；点击修改' : '会话可用端；点击收窄'}
        onClick={() => setOpen((value) => !value)}
      >
        端 {primary.name}
        {others.length > 0 ? ` +${others.length}` : ''}
        <span className="end-chip-caret">▾</span>
      </button>
      {open && (
        <div className="end-chip-pop">
          {available.length === 0 && <span className="hint">没有可用的端</span>}
          {available.map((end) => (
            <label className="switch" key={end.id}>
              <input
                type="checkbox"
                disabled={busy}
                checked={sessionEnds.some((item) => item.id === end.id)}
                onChange={() => toggle(end.id)}
              />
              <span>{end.name}（{end.kind}）</span>
            </label>
          ))}
          <button className="btn" disabled={busy} onClick={() => void save(null)}>
            恢复默认（全部端）
          </button>
        </div>
      )}
    </span>
  );
}
