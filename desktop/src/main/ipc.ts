import { app, BrowserWindow, dialog, ipcMain, shell as electronShell } from 'electron';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path, { isAbsolute } from 'node:path';
import { IPC } from '../shared/ipc';
import { ROUTES } from '../shared/routes';
import type {
  AppPrefs,
  KnowledgeExportInput,
  KnowledgeExportResult,
  ManagedDaemonStartInput,
  ManagedDaemonStartResult,
  ManagedDaemonStatus,
  ManagedDaemonStopResult,
  ManagedDaemonTokenResult,
  AttachmentGetInput,
  AttachmentUploadInput,
  ConnectInput,
  DaemonRequest,
  NotifyInput,
  RevealInput,
  RevealResult,
  StreamCancelInput,
  StreamSpec,
  TrayState,
} from '../shared/ipc';
import type { ConnectionManager } from './connection/manager';
import type { StreamManager } from './streams/manager';
import type { WindowRegistry } from './windows';
import { shouldNotify } from '../shared/notifyDecision';
import { firstFreePort } from './daemon/ports';
import type { AppTray } from './tray';
import { closeNotification, showNotification } from './notify';
import { listRecent, loadPrefs, savePrefs } from './settings';
import { isAllowedMethod, isAllowedPath } from './daemon/proxy';

export interface ShellDeps {
  tray: AppTray;
  showWindow(sessionId?: string): void;
  quitApp(): void;
  openSessionWindow(sessionId: string): void;
  /** The daemon we can start and own; wired in `index.ts`. */
  daemon: {
    status(): ManagedDaemonStatus;
    start(input: ManagedDaemonStartInput): Promise<ManagedDaemonStartResult>;
    stop(): Promise<ManagedDaemonStopResult>;
    setToken(token?: string): Promise<ManagedDaemonTokenResult>;
  };
}

/** Wire the renderer-facing IPC surface. Validation lives here, not in preload. */
export function registerIpc(
  manager: ConnectionManager,
  streams: StreamManager,
  shell: ShellDeps,
  registry: WindowRegistry,
): void {
  ipcMain.handle(IPC.boot, () => manager.bootstrap());

  ipcMain.handle(IPC.request, (_event, req: DaemonRequest) => {
    if (!req || typeof req.path !== 'string' || !isAllowedPath(req.path) || !isAllowedMethod(req.method)) {
      return { status: 0, ok: false, data: { error: 'bad_request', message: '非法请求' } };
    }
    const client = typeof req.connectionId === 'string' ? manager.clientFor(req.connectionId) : null;
    if (!client) {
      return { status: 0, ok: false, data: { error: 'not_connected', message: '尚未连接 daemon' } };
    }
    return client.request(req);
  });

  ipcMain.handle(IPC.attachmentUpload, async (_event, input: AttachmentUploadInput) => {
    if (
      !input ||
      typeof input.connectionId !== 'string' ||
      !(input.bytes instanceof Uint8Array) ||
      typeof input.contentType !== 'string'
    ) {
      return { status: 0, ok: false, data: { error: 'bad_request', message: '非法请求' } };
    }
    const client = manager.clientFor(input.connectionId);
    if (!client) {
      return { status: 0, ok: false, data: { error: 'not_connected', message: '尚未连接 daemon' } };
    }
    return client.uploadImage(input.bytes, input.contentType);
  });

  ipcMain.handle(IPC.attachmentGet, async (_event, input: AttachmentGetInput) => {
    if (!input || typeof input.connectionId !== 'string' || typeof input.id !== 'string') {
      return { status: 0, ok: false, contentType: null, data: null, error: 'bad_request' };
    }
    const client = manager.clientFor(input.connectionId);
    if (!client) {
      return {
        status: 0,
        ok: false,
        contentType: null,
        data: null,
        error: { error: 'not_connected', message: '尚未连接 daemon' },
      };
    }
    return client.attachmentImage(input.id);
  });

  ipcMain.handle(IPC.connGet, () => manager.views()[0] ?? null);
  ipcMain.handle(IPC.connList, () => manager.views());
  ipcMain.handle(IPC.connRemove, async (_event, id: unknown) => {
    if (typeof id === 'string' && id) {
      streams.cancelFor(id);
      await manager.disconnect(id);
    }
    return manager.views();
  });
  // Adding a host must not disturb the others (§4: 全部保持连接).
  ipcMain.handle(IPC.connSet, (_event, input: ConnectInput) => manager.connect(input));
  ipcMain.handle(IPC.connRename, (_event, id: unknown, name: unknown) => {
    if (typeof id !== 'string' || !id) return null;
    if (name !== null && typeof name !== 'string') return null;
    const trimmed = typeof name === 'string' ? name.trim() : '';
    // A display label, not a key: cap it so a paste cannot bloat the settings file.
    if (trimmed.length > 80) return null;
    return manager.rename(id, trimmed || null);
  });
  ipcMain.handle(IPC.connClear, (_event, id: unknown) => {
    if (typeof id === 'string' && id) streams.cancelFor(id);
    else streams.cancelAll();
    manager.clear(typeof id === 'string' && id ? id : undefined);
    return manager.views();
  });
  ipcMain.handle(IPC.connProbe, () => manager.probe());
  // Addresses only (see `RecentConnection`) — the connect form fills one in so
  // switching machines is a paste, not a retype.
  ipcMain.handle(IPC.recentList, () => listRecent());

  ipcMain.handle(IPC.appInfo, () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node,
  }));

  ipcMain.handle(IPC.prefsGet, () => loadPrefs());
  ipcMain.handle(IPC.prefsSet, (_event, patch: Partial<AppPrefs>) => savePrefs(sanitizePrefs(patch)));

  ipcMain.handle(IPC.trayState, (_event, state: TrayState) => {
    shell.tray.setState(sanitizeTrayState(state));
  });

  ipcMain.handle(IPC.notify, (_event, input: NotifyInput) => {
    if (!loadPrefs().desktopNotifications) return;
    const clean = sanitizeNotify(input);
    if (!clean) return;
    // Suppression needs every window (§7.4): a renderer can only see itself, and
    // with two windows open would announce a session the other one is showing.
    if (!shouldNotify(registry.views(), clean.sessionId)) return;
    showNotification(clean, (sessionId) => shell.showWindow(sessionId ?? undefined));
  });

  ipcMain.handle(IPC.notifyClose, (_event, id: string) => {
    if (typeof id === 'string') closeNotification(id);
  });

  ipcMain.handle(IPC.setActiveSession, (event, sessionId: unknown) => {
    registry.setSession(BrowserWindow.fromWebContents(event.sender), typeof sessionId === 'string' ? sessionId : null);
  });

  // The app menu no longer exists (see main/menu.ts), so this is the only way to
  // reach DevTools. It acts on the window the request came from, not "the" window.
  ipcMain.handle(IPC.toggleDevTools, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.toggleDevTools();
  });

  ipcMain.handle(IPC.openSessionWindow, (_event, sessionId: unknown) => {
    if (typeof sessionId === 'string' && sessionId) shell.openSessionWindow(sessionId);
  });

  ipcMain.handle(IPC.daemonStatus, () => shell.daemon.status());
  ipcMain.handle(IPC.daemonStart, async (_event, input: ManagedDaemonStartInput) => {
    // Validation lives here, not in preload: the renderer is not trusted. A
    // workspace is optional — omitting it lets the daemon start on its built-in
    // life workspace; if supplied, it must still be a non-empty path.
    if (!input || (input.workspace !== undefined && (typeof input.workspace !== 'string' || !input.workspace.trim()))) {
      return { ok: false, code: 'bad_workspace', message: '工作目录不合法' };
    }
    // `port <= 0` means「挑一个」: the default range is where the user's own
    // daemon usually lives, so a fixed 4780 would fail on exactly this machine.
    let port = input.port;
    if (!Number.isInteger(port) || port <= 0) {
      const free = await firstFreePort();
      if (free === null) {
        return { ok: false, code: 'no_free_port', message: '4780–4789 都被占用了' };
      }
      port = free;
    } else if (port > 65535) {
      return { ok: false, code: 'bad_port', message: '端口不合法' };
    }
    const workspace = typeof input.workspace === 'string' && input.workspace.trim() ? input.workspace.trim() : undefined;
    return shell.daemon.start({ ...input, port, ...(workspace ? { workspace } : {}) });
  });
  ipcMain.handle(IPC.daemonStop, () => shell.daemon.stop());
  ipcMain.handle(IPC.daemonSetToken, (_event, token: unknown) => {
    // The renderer is untrusted, and this value ends up in an Authorization
    // header — accept only a printable, space-free string, or nothing at all
    // (null/undefined/empty = let main generate one).
    if (token === undefined || token === null || token === '') {
      return shell.daemon.setToken(undefined);
    }
    if (typeof token !== 'string') {
      return { ok: false, code: 'bad_token', message: 'token 必须是字符串' };
    }
    const trimmed = token.trim();
    if (!/^[\x21-\x7e]{8,512}$/.test(trimmed)) {
      return { ok: false, code: 'bad_token', message: 'token 需为 8–512 个可见字符，且不含空格' };
    }
    return shell.daemon.setToken(trimmed);
  });

  ipcMain.handle(IPC.focusSession, (event) =>
    registry.takePending(BrowserWindow.fromWebContents(event.sender)),
  );

  ipcMain.handle(IPC.streamStart, (_event, spec: StreamSpec) => {
    if (!spec || (spec.kind !== 'chat' && spec.kind !== 'attach')) {
      return { ok: false, httpCode: null, apiCode: 'bad_request', message: '非法的流请求' };
    }
    if (typeof spec.streamId !== 'string' || spec.streamId.length === 0 || spec.streamId.length > 64) {
      return { ok: false, httpCode: null, apiCode: 'bad_request', message: '非法的流 id' };
    }
    return streams.start(spec);
  });

  ipcMain.handle(IPC.streamCancel, (_event, input: StreamCancelInput) => {
    if (!input || typeof input.streamId !== 'string') return;
    streams.cancel({ streamId: input.streamId, abortRun: input.abortRun === true });
  });

  // OS file-manager actions only make sense when the daemon is on this machine:
  // a remote daemon's paths do not exist here (and an SSH tunnel would make that
  // invisible to an address check alone, hence `local` on the view).
  ipcMain.handle(IPC.revealPath, async (_event, input: RevealInput): Promise<RevealResult> => {
    if (
      !input ||
      typeof input.connectionId !== 'string' ||
      typeof input.path !== 'string' ||
      (input.kind !== 'file' && input.kind !== 'directory')
    ) {
      return { ok: false, code: 'bad_path', message: '非法参数' };
    }
    if (!manager.view(input.connectionId)?.local) {
      return { ok: false, code: 'not_local', message: '该 daemon 不在本机' };
    }
    if (!isAbsolute(input.path)) {
      return { ok: false, code: 'bad_path', message: '需要绝对路径' };
    }
    if (!existsSync(input.path)) {
      return { ok: false, code: 'not_found', message: '路径不存在' };
    }
    if (input.kind === 'directory') {
      const failure = await electronShell.openPath(input.path);
      return failure ? { ok: false, code: 'open_failed', message: failure } : { ok: true };
    }
    electronShell.showItemInFolder(input.path);
    return { ok: true };
  });

  ipcMain.handle(
    IPC.knowledgeExport,
    async (_event, input: KnowledgeExportInput): Promise<KnowledgeExportResult> => {
      if (
        !input ||
        typeof input.connectionId !== 'string' ||
        typeof input.workspaceId !== 'string' ||
        !input.workspaceId
      ) {
        return { ok: false, code: 'bad_request', message: '非法请求' };
      }
      const client = manager.clientFor(input.connectionId);
      if (!client) return { ok: false, code: 'not_connected', message: '尚未连接 daemon' };

      let bytes: Buffer;
      try {
        const response = await client.fetchRaw(ROUTES.knowledgeExport(input.workspaceId));
        if (!response.ok) {
          return { ok: false, code: 'request_failed', message: `daemon 返回 HTTP ${response.status}` };
        }
        bytes = Buffer.from(await response.arrayBuffer());
      } catch (err) {
        return { ok: false, code: 'request_failed', message: (err as Error).message };
      }

      const suggested = safeZipName(input.suggestedName, input.workspaceId);
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出知识',
        defaultPath: suggested,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (canceled || !filePath) return { ok: false, code: 'canceled', message: '已取消' };

      try {
        await writeFile(filePath, bytes);
        return { ok: true, path: filePath };
      } catch (err) {
        return { ok: false, code: 'write_failed', message: (err as Error).message };
      }
    },
  );
}

function safeZipName(suggested: string | undefined, workspaceId: string): string {
  const fallback = `knowledge-${workspaceId.replace(/[^A-Za-z0-9_-]/g, '_')}.zip`;
  if (typeof suggested !== 'string' || !suggested.trim()) return fallback;
  const name = path.basename(suggested.trim());
  if (!/^[^/\\:*?"<>|]+\.zip$/i.test(name)) return fallback;
  return name.slice(0, 120);
}

const DAEMON_ON_QUIT = new Set(['ask', 'stop', 'keep']);
const CLOSE_BEHAVIORS = new Set<AppPrefs['closeBehavior']>(['tray', 'quit', 'ask']);

function sanitizePrefs(patch: Partial<AppPrefs>): Partial<AppPrefs> {
  const out: Partial<AppPrefs> = {};
  if (patch && typeof patch === 'object') {
    if (patch.closeBehavior && CLOSE_BEHAVIORS.has(patch.closeBehavior)) out.closeBehavior = patch.closeBehavior;
    if (patch.daemonOnQuit && DAEMON_ON_QUIT.has(patch.daemonOnQuit)) out.daemonOnQuit = patch.daemonOnQuit;
    if (typeof patch.desktopNotifications === 'boolean') out.desktopNotifications = patch.desktopNotifications;
    if (typeof patch.autoStartDaemon === 'boolean') out.autoStartDaemon = patch.autoStartDaemon;
  }
  return out;
}

const MAX_TRAY_SESSIONS = 20;

function sanitizeTrayState(state: TrayState): TrayState {
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  return {
    runningCount: Number.isFinite(state?.runningCount) ? Math.max(0, Math.trunc(state.runningCount)) : 0,
    sessions: sessions
      .filter((s): s is { id: string; title: string } => Boolean(s) && typeof s.id === 'string')
      .slice(0, MAX_TRAY_SESSIONS)
      .map((s) => ({ id: s.id, title: String(s.title ?? '') })),
  };
}

function sanitizeNotify(input: NotifyInput): NotifyInput | null {
  if (!input || typeof input.id !== 'string' || !input.id) return null;
  if (typeof input.title !== 'string' || typeof input.body !== 'string') return null;
  return {
    id: input.id,
    title: input.title.slice(0, 200),
    body: input.body.slice(0, 500),
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : null,
  };
}
