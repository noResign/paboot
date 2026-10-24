import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnection } from '../../store/connection';
import { useScope, useSessions, visibleSessions } from '../../store/sessions';
import { fallbackWorkspaceId } from '../../store/workspaceList';
import { useChat, type NewSessionOptions } from '../../store/chat';
import { useAppearance, type ThemePreference } from '../../store/appearance';
import { failedKey, needsInputKey, parseNeedsInput } from '../../store/chat/selectors';
import { api } from '../../ipc/client';
import { RefreshIcon } from '../../ui/RefreshIcon';
import { SessionList } from '../sessions/SessionList';
import { ChatView } from '../chat/ChatView';
import { NewSessionDialog } from '../new-session/NewSessionDialog';
import { SettingsPage, type SettingsSection } from '../settings/SettingsPage';
import { FilesPage } from '../files/FilesPage';
import { TasksPage } from '../tasks/TasksPage';
import { ChatAside } from '../files/ChatAside';
import { CommandPalette } from '../palette/CommandPalette';
import { ShortcutHelp } from '../palette/ShortcutHelp';
import { ConnectionSwitcher } from '../connect/ConnectionSwitcher';
import { useToolGroups } from '../chat/toolGroups';
import { comboLabel, isEditableTarget, isModifierless, matchShortcut } from '../../shortcuts/shortcuts';
import { IS_MAC } from '../../ui/platform';
import { createWindowFocus } from './windowFocus';
import type { PaletteItem } from '../../commands/palette';
import type { SessionDto } from '../../../../shared/contract';

/** One per renderer process — see `windowFocus.ts` for why it is memoized. */
const windowFocus = createWindowFocus(() => window.paboot.focusSession());

type Page = 'chat' | 'settings' | 'files' | 'tasks';

/**
 * macOS runs with `titleBarStyle: 'hiddenInset'` (src/main/window.ts), so the
 * traffic lights float over the web content rather than sitting in a title bar.
 * The class reserves the strip they occupy — see `.shell.darwin` in app.css.
 * (`IS_MAC` itself lives in `ui/platform`.)
 */

/** How often the rail re-asks the daemon what is running (sessions.md §6.2). */
const SESSION_POLL_MS = 5000;

/**
 * Left rail + main area. Desktop shows the list and the content side by side
 * rather than pushing pages — "which session is running / waiting on me" has to
 * be visible without navigating.
 */
export function AppShell() {
  // Several hosts can be live at once (§4); the rail and main area are scoped to
  // whichever one is current.
  const connectionId = useConnection((state) => state.activeId);
  const disconnectAll = useConnection((state) => state.disconnectAll);
  const scope = useScope(connectionId);
  const loadWorkspaces = useSessions((state) => state.loadWorkspaces);
  const loadSessions = useSessions((state) => state.loadSessions);
  const patchTitle = useSessions((state) => state.patchTitle);
  const dropSession = useSessions((state) => state.remove);

  const openSession = useChat((state) => state.openSession);
  const startNew = useChat((state) => state.startNew);
  const stopRun = useChat((state) => state.stop);
  const activeChat = useChat((state) => (state.activeKey ? state.byKey[state.activeKey] : undefined));
  // Stable primitives, so a streamed token does not re-render the whole shell.
  const waitingKey = useChat((state) => needsInputKey(state.byKey));
  const failedIds = useChat((state) => failedKey(state.failedIds));

  const railWidth = useAppearance((state) => state.railWidth);
  const setRailWidth = useAppearance((state) => state.setRailWidth);
  const zoom = useAppearance((state) => state.zoom);
  const setZoom = useAppearance((state) => state.setZoom);
  const setTheme = useAppearance((state) => state.setTheme);
  const toggleToolGroups = useToolGroups((state) => state.toggleAll);
  const asideVisible = useAppearance((state) => state.asideVisible);
  const toggleAside = useAppearance((state) => state.toggleAside);
  const railVisible = useAppearance((state) => state.railVisible);
  const toggleRail = useAppearance((state) => state.toggleRail);
  const chatVisible = useAppearance((state) => state.chatVisible);
  const toggleChat = useAppearance((state) => state.toggleChat);

  /*
   * host → workspace → session → run is a nested chain of ids: a workspace id
   * only means something on the connection it was picked on. Keeping the choice
   * in one piece with its connection lets the mismatch be resolved *during
   * render*, so switching hosts never leaves a render holding the previous
   * host's workspace id. Resetting it in an effect (the obvious version) did:
   * the sessions effect then fired once with `(new connection, old workspace)`,
   * and the daemon answered `GET /api/sessions?workspaceId=<unknown>` with 404 —
   * the rail flashed「加载失败（HTTP 404）」before the real list arrived.
   */
  const [workspaceChoice, setWorkspaceChoice] = useState<{ connectionId: string | null; id: string }>({
    connectionId: null,
    id: '',
  });
  const workspaceId = workspaceChoice.connectionId === connectionId ? workspaceChoice.id : '';
  const setWorkspaceId = useCallback(
    (id: string) => setWorkspaceChoice({ connectionId, id }),
    [connectionId],
  );
  useEffect(() => {
    setTaskFilter(null);
  }, [connectionId, workspaceId]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [page, setPage] = useState<Page>('chat');
  /** When set, the Tasks page shows only this session's tasks. */
  const [taskFilter, setTaskFilter] = useState<{ id: string; title: string | null } | null>(null);
  // Which settings section is showing; kept here so the palette can open one directly.
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('connection');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // The palette searches every workspace, not just the one the rail shows.
  // Fetched fresh each time it opens; until then it falls back to the rail's list.
  const [paletteSessions, setPaletteSessions] = useState<SessionDto[] | null>(null);

  const needsInput = useMemo(() => parseNeedsInput(waitingKey), [waitingKey]);
  const failed = useMemo(() => new Set(failedIds ? failedIds.split(',') : []), [failedIds]);
  // The loaded batch only belongs to the workspace it was fetched for. Anything
  // else — the "every workspace" answer that used to land before the default
  // workspace resolved, or a batch left over mid-switch — must not render.
  const sessions = useMemo(() => visibleSessions(scope, workspaceId), [scope, workspaceId]);

  // A different host means a different session list: drop the rail's selection.
  // The workspace choice needs no reset here — it is scoped to its connection,
  // so it already reads as empty for the new host; the default-workspace effect
  // below then picks for that host.
  useEffect(() => {
    setSelectedId(null);
  }, [connectionId]);

  // Workspaces first: they decide which workspace's sessions to ask for.
  useEffect(() => {
    if (!connectionId) return;
    void loadWorkspaces(connectionId);
  }, [connectionId, loadWorkspaces]);

  // Sessions only once a workspace is chosen. Never with an empty id — the daemon
  // answers that with *every* workspace's sessions, which is the batch that used
  // to flash into the rail before the default workspace resolved.
  useEffect(() => {
    if (!connectionId || !workspaceId) return;
    void loadSessions(connectionId, workspaceId);
  }, [connectionId, workspaceId, loadSessions]);

  /*
   * The rail's running marker comes from polling, not push (sessions.md §6.2):
   * a run another device started, or one that ended while this client was
   * looking at a different session, is only visible if we ask again. The tray
   * count and the rail-foot count are fed from the same list, so they go stale
   * with it. Silent, so a poll never flashes skeletons over what is on screen.
   */
  useEffect(() => {
    if (!connectionId || !workspaceId) return;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void loadSessions(connectionId, workspaceId, { silent: true }).finally(() => {
        inFlight = false;
      });
    }, SESSION_POLL_MS);
    return () => clearInterval(timer);
  }, [connectionId, workspaceId, loadSessions]);

  // Pick the default workspace once, then keep whatever the user chose.
  useEffect(() => {
    if (workspaceId) return;
    const fallback = scope.workspaces.find((workspace) => workspace.isDefault) ?? scope.workspaces[0];
    if (fallback) setWorkspaceId(fallback.id);
  }, [scope.workspaces, workspaceId]);

  // The chosen workspace can disappear under us (deleted from the 工作区 page, or
  // by another device) — fall back rather than showing an empty rail forever.
  useEffect(() => {
    if (!workspaceId || scope.workspaces.length === 0) return;
    if (scope.workspaces.some((workspace) => workspace.id === workspaceId)) return;
    setWorkspaceId(fallbackWorkspaceId(scope.workspaces) ?? '');
    setSelectedId(null);
    useChat.getState().leave();
  }, [scope.workspaces, workspaceId]);

  // A brand-new session only learns its id when the daemon answers the first
  // prompt; highlight it in the rail without re-opening it (that would reload
  // history mid-stream).
  useEffect(() => {
    if (activeChat?.sessionId && activeChat.sessionId !== selectedId) setSelectedId(activeChat.sessionId);
  }, [activeChat?.sessionId, selectedId]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  // The command palette spans the whole host, so it needs a session list the
  // rail deliberately doesn't hold (the rail only ever shows one workspace).
  // Pulled on open — a snapshot is enough for search.
  useEffect(() => {
    if (!paletteOpen || !connectionId) return;
    let cancelled = false;
    void api.sessions().then((res) => {
      if (!cancelled && res.ok) setPaletteSessions(res.data.sessions);
    });
    return () => {
      cancelled = true;
    };
  }, [paletteOpen, connectionId]);

  // The tray lives in main; only the renderer knows what is running.
  useEffect(() => {
    const running = sessions.filter((session) => session.running);
    void window.paboot.trayState({
      runningCount: running.length,
      sessions: running.map((session) => ({ id: session.id, title: session.title ?? '未命名会话' })),
    });
  }, [sessions]);

  /*
   * Report which session this window shows: the notification rule needs it, and
   * only main can see every window (§7.4). One window announcing a session that
   * another window is already displaying is the bug this prevents.
   */
  useEffect(() => {
    void window.paboot.setActiveSession(activeChat?.sessionId ?? null);
  }, [activeChat?.sessionId]);

  // A second window is created with a session to focus; pull it once at boot.
  useEffect(() => {
    if (!connectionId) return;
    void windowFocus.session().then((sessionId) => {
      // No `live` guard on purpose — the pull is one-shot for the process.
      if (!sessionId || !windowFocus.claim()) return;
      setPage('chat');
      setSelectedId(sessionId);
      void openSession(connectionId, sessionId);
    });
  }, [connectionId, openSession]);

  // A tray entry or a notification click asked for a specific session.
  useEffect(
    () =>
      window.paboot.onSelectSession((sessionId) => {
        setPage('chat');
        setSelectedId(sessionId);
        if (connectionId) void openSession(connectionId, sessionId);
      }),
    [connectionId, openSession],
  );

  const selectedWorkspace = scope.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const runningCount = sessions.filter((session) => session.running).length;
  const overlayOpen = paletteOpen || helpOpen || newSessionOpen;

  function openSettings(section: SettingsSection = 'connection'): void {
    setSettingsSection(section);
    setPage('settings');
  }

  function select(id: string): void {
    setPage('chat');
    setSelectedId(id);
    if (connectionId) void openSession(connectionId, id);
  }

  /**
   * Open a session picked from the palette. If it lives in another workspace,
   * switch there first — the rail only ever shows the current workspace, so
   * otherwise there would be no row to highlight.
   */
  function openSessionIn(id: string, targetWorkspaceId: string | null): void {
    if (targetWorkspaceId && targetWorkspaceId !== workspaceId) setWorkspaceId(targetWorkspaceId);
    select(id);
  }

  function switchWorkspace(id: string): void {
    setWorkspaceId(id);
    setSelectedId(null);
    useChat.getState().leave();
  }

  function stepSession(delta: number): void {
    if (sessions.length === 0) return;
    const index = sessions.findIndex((session) => session.id === selectedId);
    const next = sessions[(index + delta + sessions.length) % sessions.length];
    if (next) select(next.id);
  }

  function refresh(): void {
    if (!connectionId) return;
    // Refresh both: a workspace another device just created only shows up if we
    // re-ask for the list (the poll below only re-reads sessions).
    void loadWorkspaces(connectionId, { silent: true });
    if (workspaceId) void loadSessions(connectionId, workspaceId);
  }

  async function renameSession(id: string, title: string): Promise<void> {
    const res = await api.renameSession(id, title);
    if (!res.ok) {
      setToast('重命名失败');
      return;
    }
    if (connectionId) {
      patchTitle(connectionId, id, title);
      useChat.getState().patchTitle(connectionId, id, title);
    }
  }

  async function deleteSession(id: string): Promise<void> {
    const res = await api.deleteSession(id);
    if (!res.ok) {
      setToast('删除失败');
      return;
    }
    if (connectionId) dropSession(connectionId, id);
    if (selectedId === id) setSelectedId(null);
    setToast('会话已删除');
  }

  function copyText(text: string): void {
    void navigator.clipboard.writeText(text).then(
      () => setToast('已复制'),
      () => setToast('复制失败'),
    );
  }

  function createSession(options: NewSessionOptions): void {
    if (!connectionId) return;
    setNewSessionOpen(false);
    setPage('chat');
    setSelectedId(null);
    startNew(connectionId, { ...options, workspaceId: workspaceId || null });
  }

  /** Leave the settings page. */
  function goBack(): void {
    setPage('chat');
  }

  const actions: Record<string, () => void> = {
    'command-palette': () => setPaletteOpen((open) => !open),
    'new-session': () => setNewSessionOpen(true),
    'toggle-rail': toggleRail,
    'go-sessions': () => setPage('chat'),
    'go-settings': () => openSettings(),
    back: goBack,
    refresh,
    'stop-run': stopRun,
    'next-session': () => stepSession(1),
    'prev-session': () => stepSession(-1),
    'zoom-in': () => setZoom(zoom + 10),
    'zoom-out': () => setZoom(zoom - 10),
    'zoom-reset': () => setZoom(100),
    'toggle-tool-groups': toggleToolGroups,
    'toggle-devtools': () => void window.paboot.toggleDevTools(),
    help: () => setHelpOpen(true),
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const shortcut = matchShortcut(event);
      if (!shortcut) return;
      if (isModifierless(shortcut.combo) && isEditableTarget(event.target)) return;
      if (overlayOpen && shortcut.id !== 'command-palette') return;
      const action = actions[shortcut.id];
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  function buildPaletteItems(): PaletteItem[] {
    const items: PaletteItem[] = [];
    for (const session of paletteSessions ?? sessions) {
      items.push({
        id: `session:${session.id}`,
        section: '会话',
        label: session.title ?? '未命名会话',
        hint: [
          scope.workspaces.find((workspace) => workspace.id === session.workspaceId)?.name,
          session.runtime,
          session.running ? '运行中' : null,
        ]
          .filter(Boolean)
          .join(' · '),
        keywords: session.cwd,
        run: () => openSessionIn(session.id, session.workspaceId),
      });
    }
    for (const workspace of scope.workspaces) {
      items.push({
        id: `workspace:${workspace.id}`,
        section: '工作区',
        label: workspace.name,
        hint: `${workspace.sessionCount} 个会话`,
        keywords: 'workspace',
        run: () => switchWorkspace(workspace.id),
      });
    }
    const theme = (value: ThemePreference, label: string): PaletteItem => ({
      id: `theme:${value}`,
      section: '动作',
      label,
      keywords: 'theme appearance',
      run: () => setTheme(value),
    });
    items.push(
      { id: 'action:new-session', section: '动作', label: '新建会话', keywords: 'new create', run: () => setNewSessionOpen(true) },
      { id: 'action:settings', section: '动作', label: '打开设置', keywords: 'preferences', run: () => openSettings() },
      {
        id: 'action:workspaces',
        section: '动作',
        label: '管理工作区',
        keywords: 'workspace 工作区',
        run: () => openSettings('workspaces'),
      },
      { id: 'action:files', section: '动作', label: '浏览文件与改动', keywords: 'files diff 文件', run: () => setPage('files') },
      {
        id: 'action:tasks',
        section: '动作',
        label: '定时任务',
        keywords: 'schedule cron 定时 任务',
        run: () => {
          setTaskFilter(null);
          setPage('tasks');
        },
      },
      { id: 'action:refresh', section: '动作', label: '刷新会话列表', keywords: 'reload refresh', run: refresh },
      { id: 'action:stop', section: '动作', label: '停止当前运行', keywords: 'cancel abort', run: stopRun },
      theme('light', '主题：浅色'),
      theme('dark', '主题：深色'),
      theme('system', '主题：跟随系统'),
      { id: 'action:help', section: '动作', label: '快捷键帮助', keywords: 'help keys', run: () => setHelpOpen(true) },
      {
        id: 'action:disconnect',
        section: '动作',
        label: '断开全部连接',
        keywords: 'disconnect logout',
        run: () => void disconnectAll(),
      },
    );
    return items;
  }

  function startResize(event: React.MouseEvent): void {
    event.preventDefault();
    const onMove = (move: MouseEvent): void => setRailWidth(move.clientX);
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div className={`shell${IS_MAC ? ' darwin' : ''}`}>
      {!railVisible && (
        // Collapsed leaves a strip rather than nothing: without it the only way
        // back is ⌘B or the palette, both invisible (matches the right panel's
        // collapse-to-44px in the design preview).
        <div className="rail-strip">
          <button className="link-btn" title={`展开会话栏 ${comboLabel('toggle-rail', IS_MAC)}`} onClick={toggleRail}>
            ⇥
          </button>
        </div>
      )}
      {railVisible && (
        <aside className="rail" style={{ width: railWidth }}>
          <div className="rail-head">
            <ConnectionSwitcher />
            <select className="ws-select" value={workspaceId} onChange={(event) => switchWorkspace(event.target.value)}>
              {scope.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name} · {workspace.sessionCount} 个会话
                </option>
              ))}
            </select>
            <button className="btn primary" onClick={() => setNewSessionOpen(true)} title={`新建会话 ${comboLabel('new-session', IS_MAC)}`}>
              ＋ 新建会话
            </button>
          </div>

          <div className="rail-list">
            {scope.error ? (
              <div className="empty" style={{ color: 'var(--error)' }}>
                {scope.error}
              </div>
            ) : (
              <SessionList
                sessions={sessions}
                selectedId={selectedId}
                needsInput={needsInput}
                failed={failed}
                loading={scope.loading}
                onSelect={select}
                onRename={(id, title) => void renameSession(id, title)}
                onDelete={(id) => void deleteSession(id)}
                onCopy={copyText}
                onRefresh={refresh}
                onOpenWindow={(id) => void window.paboot.openSessionWindow(id)}
              />
            )}
          </div>

          <div className="rail-foot">
            <button
              className={`link-btn icon-only${page === 'files' ? ' active' : ''}`}
              title="文件与 Diff"
              onClick={() => setPage('files')}
            >
              📁
            </button>
            <button
              className={`link-btn icon-only${page === 'tasks' ? ' active' : ''}`}
              title="定时任务"
              onClick={() => {
                setTaskFilter(null);
                setPage('tasks');
              }}
            >
              ⏰
            </button>
            <button
              className={`link-btn icon-only${page === 'settings' ? ' active' : ''}`}
              title="设置"
              onClick={() => openSettings()}
            >
              ⚙
            </button>
            <button className="link-btn" title={`刷新 ${comboLabel('refresh', IS_MAC)}`} onClick={refresh}>
              <RefreshIcon />
            </button>
            <button className="link-btn" title={`命令面板 ${comboLabel('command-palette', IS_MAC)}`} onClick={() => setPaletteOpen(true)}>
              {comboLabel('command-palette', IS_MAC)}
            </button>
            <button className="link-btn" title={`收起会话栏 ${comboLabel('toggle-rail', IS_MAC)}`} onClick={toggleRail}>
              ⇤
            </button>
            <span className="rail-running">{runningCount > 0 ? `● ${runningCount}` : ''}</span>
          </div>
          <div className="rail-resize" onMouseDown={startResize} title="拖拽调整宽度" />
        </aside>
      )}

      <main className="main">
        {page === 'settings' ? (
          <SettingsPage onBack={goBack} section={settingsSection} onSectionChange={setSettingsSection} />
        ) : page === 'files' ? (
          <FilesPage
            key={connectionId ?? 'none'}
            workspaceId={workspaceId || null}
            workspaceName={selectedWorkspace?.name ?? null}
          />
        ) : page === 'tasks' ? (
          <TasksPage
            connectionId={connectionId}
            workspaceId={workspaceId || null}
            workspaceName={selectedWorkspace?.name ?? null}
            taskFilter={taskFilter}
            onClearTaskFilter={() => setTaskFilter(null)}
            onOpenSession={(id) => {
              if (connectionId) void openSession(connectionId, id);
              setPage('chat');
            }}
          />
        ) : (
          <div className="chat-row">
            {chatVisible ? (
              <ChatView
                workspaceName={selectedWorkspace?.name ?? null}
                asideVisible={asideVisible}
                onToggleAside={toggleAside}
                onCollapseChat={toggleChat}
                onOpenTasks={(sessionId, title) => {
                  setTaskFilter({ id: sessionId, title });
                  setPage('tasks');
                }}
              />
            ) : (
              // Same treatment as the rail: a strip, so there is always a way back.
              <div className="chat-strip">
                <button className="link-btn" title="展开会话" onClick={toggleChat}>
                  ⇥
                </button>
              </div>
            )}
            {asideVisible && (
              // Remount per connection: the browser's tree, root and open file
              // are all host-specific state that must not survive a host switch.
              <ChatAside key={connectionId ?? 'none'} workspaceId={workspaceId || null} onCollapse={toggleAside} />
            )}
          </div>
        )}
      </main>

      {newSessionOpen && (
        <NewSessionDialog
          workspaceName={selectedWorkspace?.name ?? null}
          workspaceId={workspaceId || null}
          onCancel={() => setNewSessionOpen(false)}
          onCreate={createSession}
        />
      )}

      {paletteOpen && <CommandPalette items={buildPaletteItems()} onClose={() => setPaletteOpen(false)} />}
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
