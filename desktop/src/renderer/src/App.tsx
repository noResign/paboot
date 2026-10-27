import { useEffect, useRef } from 'react';
import { useConnection } from './store/connection';
import { ConnectPage } from './features/connect/ConnectPage';
import { AppShell } from './features/shell/AppShell';
import { SkinFx } from './ui/SkinFx';
import { startStreamBridge } from './bridge/streamBridge';

export function App() {
  const active = useConnection((s) => s.views.find((view) => view.id === s.activeId) ?? null);
  const booting = useConnection((s) => s.booting);
  const boot = useConnection((s) => s.boot);

  // StrictMode replays effects in development; booting twice would start two
  // daemons now that boot can auto-provision one.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // One subscription for the app's lifetime, before anything can stream.
    startStreamBridge();
    void boot();
  }, [boot]);

  // `connected`, not `baseUrl`: a restored target without a token is an
  // address we cannot talk to yet. No active host also lands here — that is how
  // 「＋ 添加电脑」 shows the connect form without dropping the others (§4).
  const content =
    booting && !active ? (
      <div className="boot">正在启动…</div>
    ) : active?.connected ? (
      <AppShell />
    ) : (
      <ConnectPage />
    );

  // The skin's effect layer sits behind everything — the connect page included.
  return (
    <>
      <SkinFx />
      {content}
    </>
  );
}
