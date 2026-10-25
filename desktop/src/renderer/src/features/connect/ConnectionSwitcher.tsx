import { useEffect, useRef, useState } from 'react';
import { useConnection } from '../../store/connection';
import { displayHost, maskAddress } from '../../../../shared/net';

/**
 * The rail-top connection pill, now a real switcher (`▾ 我的笔记本（本机） /
 * 家里的台式机 / ＋ 添加电脑…`, technical plan §4). Every host in the list is
 * **already connected** in main — switching is navigation, not a reconnect, so
 * hopping between machines costs nothing.
 */
export function ConnectionSwitcher() {
  const views = useConnection((state) => state.views);
  const activeId = useConnection((state) => state.activeId);
  const switchTo = useConnection((state) => state.switchTo);
  const addHost = useConnection((state) => state.addHost);
  const removeHost = useConnection((state) => state.removeHost);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = views.find((view) => view.id === activeId) ?? null;
  const label = active ? displayHost(active.name, active.host) : '未选择主机';

  return (
    <div className="conn-switch" ref={ref}>
      <button
        className="conn-pill"
        onClick={() => setOpen((value) => !value)}
        title={active?.host ? maskAddress(active.host) : ''}
      >
        <span className={`dot ${active?.connected ? 'ok' : 'warn'}`} />
        <span className="conn-name">{label}</span>
        <span className="chevron">▾</span>
      </button>

      {open && (
        <div className="conn-menu">
          {views.map((view) => (
            <div key={view.id} className={`conn-row${view.id === activeId ? ' active' : ''}`}>
              <button
                className="conn-pick"
                title={view.host ? maskAddress(view.host) : ''}
                onClick={() => {
                  setOpen(false);
                  switchTo(view.id);
                }}
              >
                <span className={`dot ${view.connected ? 'ok' : 'err'}`} />
                <span className="conn-row-name">{displayHost(view.name, view.host)}</span>
                {!view.connected && (
                  <span className="hint" style={{ margin: 0 }}>
                    {maskAddress(view.error ?? '未连接')}
                  </span>
                )}
              </button>
              <button className="icon-btn danger" title="移除这台主机" onClick={() => void removeHost(view.id)}>
                ✕
              </button>
            </div>
          ))}

          <button
            className="ctx-item"
            onClick={() => {
              setOpen(false);
              addHost();
            }}
          >
            ＋ 添加电脑…
          </button>
          <div className="hint conn-note">
            所有主机保持连接；切换只是换作用域，不会重连。多窗口可并排看两台。
          </div>
        </div>
      )}
    </div>
  );
}
