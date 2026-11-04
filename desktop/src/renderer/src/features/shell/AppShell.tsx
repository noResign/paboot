import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnection } from '../../store/connection';
import { useScope, useSessions, visibleSessions } from '../../store/sessions';
import {
  directoryName,
  fallbackWorkspaceId,
  initialWorkspaceId,
  sessionMatchesDir,
  visibleWorkspaces,
  workspaceDirectories,
  workspaceLabel,
} from '../../store/workspaceList';
import { lastWorkspaceIdentity, readLastWorkspace, writeLastWorkspace } from '../../store/lastWorkspace';
import { lastSessionKey, readLastSession, writeLastSession } from '../../store/lastSession';
import { useChat, type NewSessionOptions } from '../../store/chat';
import { ASIDE_MIN, useAppearance, type ThemePreference } from '../../store/appearance';
import { failedKey, needsInputKey, parseNeedsInput } from '../../store/chat/selectors';
import { api } from '../../ipc/client';
import { Icon } from '../../ui/Icon';
import { SessionList } from '../sessions/SessionList';
import { ChatView } from '../chat/ChatView';
import { NewSessionDialog } from '../new-session/NewSessionDialog';
import { SettingsPage, type SettingsSection } from '../settings/SettingsPage';
import { TasksPage } from '../tasks/TasksPage';
import { WorkspaceOverview } from '../workspaces/WorkspaceOverview';
import { ChatAside } from '../files/ChatAside';
import { CommandPalette } from '../palette/CommandPalette';
import { ShortcutHelp } from '../palette/ShortcutHelp';
import { ConnectionSwitcher } from '../connect/ConnectionSwitcher';
import { useToolGroups } from '../chat/toolGroups';
import { comboLabel, isEditableTarget, isModifierless, matchShortcut } from '../../shortcuts/shortcuts';
import { IS_MAC } from '../../ui/platform';
import { createWindowFocus } from './windowFocus';
import type { PaletteItem } from '../../commands/palette';
import { runtimeIdentity } from '../../../../shared/runtime-identity';
import type { SessionDto } from '../../../../shared/contract';

/** One per renderer process — see `windowFocus.ts` for why it is memoized. */
const windowFocus = createWindowFocus(() => window.paboot.focusSession());

type Page = 'chat' | 'settings' | 'tasks';

/**
 * macOS runs with `titleBarStyle: 'hiddenInset'` (src/main/window.ts), so the
 * traffic lights float over the web content rather than sitting in a title bar.
 * The class reserves the strip they occupy — see `.shell.darwin` in app.css.
 * (`IS_MAC` itself lives in `ui/platform`.)
 */

/** How often the rail re-asks the daemon what is running (sessions.md §6.2). */
const SESSION_POLL_MS = 5000;
/** The narrowest conversation column that still fits its header/action row. */
const CHAT_FLOOR = 560;

/**
 * Left rail + main area. Desktop shows the list and the content side by side
 * rather than pushing pages — "which session is running / waiting on me" has to
 * be visible without navigating.
 */
export function AppShell() {
  // Several hosts can be live at once (§4); the rail and main area are scoped to
  // whichever one is current.
  const connectionId = useConnection((state) => state.activeId);
  // The daemon's stable identity — survives LAN ↔ loopback address changes.
  const serverId = useConnection(
    (state) => state.views.find((view) => view.id === state.activeId)?.serverId ?? null,
  );
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
  const asideWidth = useAppearance((state) => state.asideWidth);
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
  const workspaceIdentity = lastWorkspaceIdentity(connectionId, serverId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Page/session to return to when the workspace overview was opened from somewhere. */
  const [overviewReturn, setOverviewReturn] = useState<{ page: Page; sessionId: string | null } | null>(null);
  /**
   * The overview is a *view* over the live chat, not a reason to tear it down.
   * `leave()` here would make returning re-fetch the session and replay its run —
   * a full skeleton flash for a navigation that never left the session.
   */
  const [overviewOpen, setOverviewOpen] = useState(false);
  /** Rail-only directory filter; never changes what a session belongs to. */
  const [dirFilter, setDirFilter] = useState<string | null>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [page, setPage] = useState<Page>('chat');
  /** When set, the Tasks page shows only this session's tasks. */
  const [taskFilter, setTaskFilter] = useState<{ id: string; title: string | null } | null>(null);
  // Which settings section is showing; kept here so the palette can open one directly.
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('connection');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // The window width decides whether the rail can stay beside the file panel.
  // Tracked here (not in CSS) because the decision changes *which* column is
  // rendered, and the rail's collapse state is persisted while this is not.
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  // The palette searches every workspace, not just the one the rail shows.
  // Fetched fresh each time it opens; until then it falls back to the rail's list.
  const [paletteSessions, setPaletteSessions] = useState<SessionDto[] | null>(null);

  const needsInput = useMemo(() => parseNeedsInput(waitingKey), [waitingKey]);
  const failed = useMemo(() => new Set(failedIds ? failedIds.split(',') : []), [failedIds]);
  // The loaded batch only belongs to the workspace it was fetched for. Anything
  // else — the "every workspace" answer that used to land before the default
  // workspace resolved, or a batch left over mid-switch — must not render.
  const sessions = useMemo(() => visibleSessions(scope, workspaceId), [scope, workspaceId]);
  const selectedWorkspace = scope.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const selectedWorkspaceLabel = workspaceLabel(selectedWorkspace);
  const workspaceDirs = useMemo(
    () => (selectedWorkspace ? workspaceDirectories(selectedWorkspace) : []),
    [selectedWorkspace],
  );
  const shownSessions = useMemo(
    () => (dirFilter ? sessions.filter((session) => sessionMatchesDir(session.cwd, dirFilter)) : sessions),
    [sessions, dirFilter],
  );
  /**
   * The overview takes the main area while it is open — and whenever no chat is
   * open at all (fresh launch, just switched workspace, deleted session). The
   * chat can be alive underneath it; the rail selection says what is *shown*.
   */
  const mainShowsOverview = overviewOpen || !activeChat;

  useEffect(() => {
    setTaskFilter(null);
    setDirFilter(null);
  }, [connectionId, workspaceId]);

  // A filtered directory can disappear from the workspace (removed on another
  // device): clear instead of silently showing an empty rail.
  useEffect(() => {
    if (dirFilter && !workspaceDirs.includes(dirFilter)) setDirFilter(null);
  }, [dirFilter, workspaceDirs]);

  // A different host means a different session list: drop the rail's selection.
  // The workspace choice needs no reset here — it is scoped to its connection,
  // so it already reads as empty for the new host; the default-workspace effect
  // below then picks for that host.
  useEffect(() => {
    setSelectedId(null);
    setOverviewOpen(false);
    setOverviewReturn(null);
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

  // Open where this device left off: the workspace it used last, then the
  // daemon default, then the first. Waits for the list so a stale remembered id
  // is never requested.
  useEffect(() => {
    if (workspaceId || scope.workspaces.length === 0) return;
    const chosen = initialWorkspaceId(scope.workspaces, readLastWorkspace(workspaceIdentity));
    if (chosen) setWorkspaceId(chosen);
  }, [scope.workspaces, workspaceId, workspaceIdentity, setWorkspaceId]);

  // Remember the selection per daemon so the next launch opens it.
  useEffect(() => {
    if (workspaceId) writeLastWorkspace(workspaceIdentity, workspaceId);
  }, [workspaceId, workspaceIdentity]);

  const sessionMemoryKey = lastSessionKey(workspaceIdentity, workspaceId || null);
  /** Restore at most once per workspace visit — a manual "new session" must not be undone. */
  const restoredSessionKey = useRef<string | null>(null);

  // Remember the open session per workspace, so switching hosts restores it.
  useEffect(() => {
    if (!sessionMemoryKey || !selectedId) return;
    writeLastSession(sessionMemoryKey, selectedId);
  }, [sessionMemoryKey, selectedId]);

  // Restore only after the workspace's list actually arrived: opening a stale id
  // would show an empty chat, and the selection would then be written back.
  useEffect(() => {
    if (!connectionId || !sessionMemoryKey || selectedId) return;
    if (scope.loading || sessions.length === 0) return;
    if (restoredSessionKey.current === sessionMemoryKey) return;
    restoredSessionKey.current = sessionMemoryKey;
    const remembered = readLastSession(sessionMemoryKey);
    if (!remembered) return;
    if (!sessions.some((session) => session.id === remembered)) {
      writeLastSession(sessionMemoryKey, null);
      return;
    }
    setPage('chat');
    setSelectedId(remembered);
    void openSession(connectionId, remembered);
  }, [connectionId, sessionMemoryKey, selectedId, scope.loading, sessions, openSession]);

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
  // history mid-stream). The overview deliberately deselects, so it must not be
  // dragged back to the session underneath.
  useEffect(() => {
    if (overviewOpen) return;
    if (activeChat?.sessionId && activeChat.sessionId !== selectedId) setSelectedId(activeChat.sessionId);
  }, [activeChat?.sessionId, selectedId, overviewOpen]);

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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
   * another window is already displaying is the bug this prevents. The overview
   * is not the session, even though the chat stays loaded underneath.
   */
  useEffect(() => {
    void window.paboot.setActiveSession(overviewOpen ? null : (activeChat?.sessionId ?? null));
  }, [activeChat?.sessionId, overviewOpen]);

  // A second window is created with a session to focus; pull it once at boot.
  useEffect(() => {
    if (!connectionId) return;
    void windowFocus.session().then((sessionId) => {
      // No `live` guard on purpose — the pull is one-shot for the process.
      if (!sessionId || !windowFocus.claim()) return;
      setPage('chat');
      setSelectedId(sessionId);
      setOverviewOpen(false);
      setOverviewReturn(null);
      void openSession(connectionId, sessionId);
    });
  }, [connectionId, openSession]);

  // A tray entry or a notification click asked for a specific session.
  useEffect(
    () =>
      window.paboot.onSelectSession((sessionId) => {
        setPage('chat');
        setSelectedId(sessionId);
        setOverviewOpen(false);
        setOverviewReturn(null);
        if (connectionId) void openSession(connectionId, sessionId);
      }),
    [connectionId, openSession],
  );

  // The built-in fallback keeps its id for fetching, but never shows up as a
  // row/menu entry. It is the only entry only until the first real workspace.
  const shownWorkspaces = useMemo(() => visibleWorkspaces(scope.workspaces), [scope.workspaces]);
  const runningCount = sessions.filter((session) => session.running).length;
  /*
   * Four columns are more than a 1280–1440 window can hold. The panel's width
   * is capped so the chat keeps CHAT_FLOOR even at the aside's maximum; the
   * rail only starves when even ASIDE_MIN cannot leave the floor (small
   * windows), and never when the conversation column is collapsed — there is
   * nothing to protect then.
   */
  const railSpace = railVisible ? railWidth : 44;
  const maxAsideWidth = Math.max(ASIDE_MIN, viewportWidth - railSpace - CHAT_FLOOR);
  const effectiveAsideWidth = Math.min(asideWidth, maxAsideWidth);
  const starveIfRailShown =
    asideVisible &&
    chatVisible &&
    page === 'chat' &&
    viewportWidth - railWidth - effectiveAsideWidth < CHAT_FLOOR;
  const railStarved = railVisible && starveIfRailShown;

  /**
   * ⌘B / the strip. Asking for the rail when the file panel is what is in the
   * way closes the panel instead of toggling a flag that cannot change the
   * screen; asking from the collapsed state does both.
   */
  function toggleRailOrMakeRoom(): void {
    if (railVisible && !railStarved) {
      toggleRail();
      return;
    }
    if (!railVisible && !starveIfRailShown) {
      toggleRail();
      return;
    }
    toggleAside();
    if (!railVisible) toggleRail();
  }
  const overlayOpen = paletteOpen || helpOpen || newSessionOpen;

  function openSettings(section: SettingsSection = 'connection'): void {
    setSettingsSection(section);
    setPage('settings');
  }

  function select(id: string): void {
    setPage('chat');
    setSelectedId(id);
    setOverviewOpen(false);
    setOverviewReturn(null);
    if (!connectionId) return;
    // Clicking the session that is already live must not re-open it: that would
    // throw away the transcript and its stream just to rebuild the same
    // conversation. A failed open is the exception — re-click is the retry.
    const live = activeChat?.sessionId === id && !activeChat.error;
    // A run another device started while this one was elsewhere: the rail knows
    // it (its poll says running) but the store has no stream, so a plain render
    // would show a stale transcript. Re-opening is how the stream is attached.
    const missedRun = live && !activeChat.streamId && sessions.some((s) => s.id === id && s.running);
    if (!live || missedRun) {
      void openSession(connectionId, id);
    }
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
    setOverviewOpen(false);
    setOverviewReturn(null);
    useChat.getState().leave();
  }

  /**
   * Take over the main area with the workspace overview. The chat underneath is
   * kept alive: this is navigation, not a session switch, so returning is a
   * render — no refetch, no history skeleton, no run replay.
   */
  function showOverview(): void {
    // Remember where we came from. Re-opening the overview (e.g. from its own
    // directory filter) must not overwrite the earlier target.
    setOverviewReturn((previous) => (overviewOpen ? previous : { page, sessionId: selectedId }));
    setPage('chat');
    setSelectedId(null);
    setOverviewOpen(true);
  }

  const canLeaveOverview =
    overviewReturn !== null &&
    (overviewReturn.page !== 'chat' ||
      (!!overviewReturn.sessionId && sessions.some((session) => session.id === overviewReturn.sessionId)));

  function leaveOverview(): void {
    if (!overviewReturn) return;
    const target = overviewReturn;
    setOverviewReturn(null);
    setOverviewOpen(false);
    if (target.sessionId && sessions.some((session) => session.id === target.sessionId)) {
      select(target.sessionId);
      return;
    }
    setPage(target.page);
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
    // The overview deselects the rail but keeps the chat loaded, so `selectedId`
    // alone is not enough to tell which session is actually on screen.
    if (selectedId === id || activeChat?.sessionId === id) {
      setSelectedId(null);
      useChat.getState().leave();
    }
    setOverviewReturn((previous) =>
      previous?.sessionId === id ? { ...previous, sessionId: null } : previous,
    );
    if (sessionMemoryKey && readLastSession(sessionMemoryKey) === id) {
      writeLastSession(sessionMemoryKey, null);
    }
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
    setOverviewOpen(false);
    setOverviewReturn(null);
    startNew(connectionId, { ...options, workspaceId: workspaceId || null });
  }

  /** Leave the current page; from the overview, return to where it was opened. */
  function goBack(): void {
    if (page !== 'chat') {
      setPage('chat');
      return;
    }
    // `overviewReturn` is only set while the overview is up, so this cannot fire
    // from a normal chat page.
    if (canLeaveOverview) leaveOverview();
  }

  const actions: Record<string, () => void> = {
    'command-palette': () => setPaletteOpen((open) => !open),
    'new-session': () => setNewSessionOpen(true),
    'toggle-rail': toggleRailOrMakeRoom,
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
          workspaceLabel(scope.workspaces.find((workspace) => workspace.id === session.workspaceId)),
          runtimeIdentity(session.runtime).displayName,
          session.running ? '运行中' : null,
        ]
          .filter(Boolean)
          .join(' · '),
        keywords: session.cwd,
        run: () => openSessionIn(session.id, session.workspaceId),
      });
    }
    for (const workspace of shownWorkspaces) {
      items.push({
        id: `workspace:${workspace.id}`,
        section: '工作区',
        label: workspaceLabel(workspace) ?? '',
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
        id: 'action:workspace-overview',
        section: '动作',
        label: '工作区：概览',
        keywords: 'workspace overview 工作区 目录',
        run: showOverview,
      },
      {
        id: 'action:workspaces',
        section: '动作',
        label: '管理工作区',
        keywords: 'workspace 工作区',
        run: () => openSettings('workspaces'),
      },
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
      {(!railVisible || railStarved) && (
        // Collapsed leaves a strip rather than nothing: without it the only way
        // back is ⌘B or the palette, both invisible (matches the right panel's
        // collapse-to-44px in the design preview). The same strip covers the
        // case where the rail is open but starved: its button closes the panel
        // that is taking the room, because toggling railVisible there would
        // change nothing on screen.
        <div className="rail-strip">
          <button
            className="icon-btn"
            title={
              railStarved
                ? '关闭文件栏，恢复会话栏'
                : starveIfRailShown
                  ? '关闭文件栏并展开会话栏'
                  : `展开会话栏 ${comboLabel('toggle-rail', IS_MAC)}`
            }
            onClick={toggleRailOrMakeRoom}
          >
            <Icon name={railStarved || starveIfRailShown ? 'panel-left' : 'chevron-right'} size={16} />
          </button>
        </div>
      )}
      {railVisible && !railStarved && (
        <aside className="rail" style={{ width: railWidth }}>
          <div className="rail-head">
            <ConnectionSwitcher />
            {(shownWorkspaces.length > 0 || selectedWorkspace) && (
              <div className="rail-ws-row">
                {shownWorkspaces.length > 1 ? (
                  <select
                    className="ws-select"
                    value={workspaceId}
                    onChange={(event) => switchWorkspace(event.target.value)}
                  >
                    {shownWorkspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspaceLabel(workspace)} · {workspace.sessionCount} 个会话
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="rail-ws-label">{workspaceLabel(selectedWorkspace)}</span>
                )}
                <button
                  className="icon-btn"
                  title="工作区概览"
                  disabled={!selectedWorkspace}
                  onClick={showOverview}
                >
                  <Icon name="folder" size={15} />
                </button>
              </div>
            )}
            {workspaceDirs.length > 1 && (
              <div className="rail-dir-row">
                <select
                  className="ws-select"
                  value={dirFilter ?? ''}
                  title="按目录筛选会话"
                  onChange={(event) => setDirFilter(event.target.value || null)}
                >
                  <option value="">全部目录</option>
                  {workspaceDirs.map((dir, index) => (
                    <option key={dir} value={dir}>
                      {index === 0 ? `${directoryName(dir)}（主目录）` : directoryName(dir)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <button
              className="btn soft"
              onClick={() => setNewSessionOpen(true)}
              title={`新建会话 ${comboLabel('new-session', IS_MAC)}`}
            >
              <Icon name="plus" size={15} />
              新建会话
            </button>
          </div>

          <div className="rail-list">
            {scope.error ? (
              <div className="empty" style={{ color: 'var(--error)' }}>
                {scope.error}
              </div>
            ) : (
              <SessionList
                sessions={shownSessions}
                filtered={Boolean(dirFilter)}
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
              className={`rail-foot-row${page === 'tasks' ? ' active' : ''}`}
              title="定时任务"
              onClick={() => {
                setTaskFilter(null);
                setPage('tasks');
              }}
            >
              <Icon name="clock" size={15} />
              <span className="rail-foot-label">定时任务</span>
            </button>
            <button
              className={`rail-foot-row${page === 'settings' ? ' active' : ''}`}
              title="设置"
              onClick={() => openSettings()}
            >
              <Icon name="settings" size={15} />
              <span className="rail-foot-label">设置</span>
            </button>
            {runningCount > 0 && (
              <div className="rail-running-row" title={`${runningCount} 个任务正在本机 daemon 上运行`}>
                <span className="live-dot" />
                {runningCount} 个任务运行中
              </div>
            )}
            <div className="rail-foot-utils">
              <button
                className="rail-palette"
                title={`命令面板 ${comboLabel('command-palette', IS_MAC)}`}
                onClick={() => setPaletteOpen(true)}
              >
                <Icon name="search" size={14} />
                <span>搜索</span>
                <kbd>{comboLabel('command-palette', IS_MAC)}</kbd>
              </button>
              <button className="icon-btn" title={`刷新 ${comboLabel('refresh', IS_MAC)}`} onClick={refresh}>
                <Icon name="refresh" size={15} />
              </button>
              <button
                className="icon-btn"
                title={`收起会话栏 ${comboLabel('toggle-rail', IS_MAC)}`}
                onClick={toggleRail}
              >
                <Icon name="panel-left" size={15} />
              </button>
            </div>
          </div>
          <div className="rail-resize" onMouseDown={startResize} title="拖拽调整宽度" />
        </aside>
      )}

      <main className="main">
        {page === 'settings' ? (
          <SettingsPage onBack={goBack} section={settingsSection} onSectionChange={setSettingsSection} />
        ) : page === 'tasks' ? (
          <TasksPage
            connectionId={connectionId}
            workspaceId={workspaceId || null}
            workspaceName={selectedWorkspaceLabel}
            taskFilter={taskFilter}
            onClearTaskFilter={() => setTaskFilter(null)}
            onOpenSession={(id) => select(id)}
          />
        ) : (
          <div className="chat-row">
            {chatVisible ? (
              mainShowsOverview ? (
                connectionId ? (
                  selectedWorkspace ? (
                    <WorkspaceOverview
                      connectionId={connectionId}
                      workspace={selectedWorkspace}
                      sessions={sessions}
                      onNewSession={() => setNewSessionOpen(true)}
                      onOpenSession={select}
                      onFilterDir={(dir) => {
                        setDirFilter(dir);
                        showOverview();
                      }}
                      onCopy={copyText}
                      onOpenSettings={() => openSettings('workspaces')}
                      onWorkspaceCreated={(id) => switchWorkspace(id)}
                      onBack={canLeaveOverview ? leaveOverview : undefined}
                    />
                  ) : (
                    <div className="main-body">{scope.error ?? '正在加载工作区…'}</div>
                  )
                ) : (
                  <div className="main-body">从左侧选择一个会话</div>
                )
              ) : (
                <ChatView
                  workspaceName={selectedWorkspaceLabel}
                  asideVisible={asideVisible}
                  onToggleAside={toggleAside}
                  onCollapseChat={toggleChat}
                  onOpenTasks={(sessionId, title) => {
                    setTaskFilter({ id: sessionId, title });
                    setPage('tasks');
                  }}
                />
              )
            ) : (
              // Same treatment as the rail: a strip, so there is always a way back.
              <div className="chat-strip">
                <button className="icon-btn" title="展开会话" onClick={toggleChat}>
                  <Icon name="chevron-right" size={16} />
                </button>
              </div>
            )}
            {asideVisible && activeChat && !mainShowsOverview && (
              // Remount per connection: the browser's tree, root and open file
              // are all host-specific state that must not survive a host switch.
              <ChatAside
                key={connectionId ?? 'none'}
                workspaceId={workspaceId || null}
                onCollapse={toggleAside}
                maxWidth={maxAsideWidth}
              />
            )}
          </div>
        )}
      </main>

      {newSessionOpen && (
        <NewSessionDialog
          workspaceName={selectedWorkspaceLabel}
          workspacePath={selectedWorkspace?.path ?? null}
          onlyFallback={shownWorkspaces.length === 0}
          onAddWorkspace={() => {
            setNewSessionOpen(false);
            openSettings('workspaces');
          }}
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
