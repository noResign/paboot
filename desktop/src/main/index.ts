import { app, BrowserWindow, dialog, session } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import {
  IPC,
  type ManagedDaemonStartResult,
  type ManagedDaemonStopResult,
  type ManagedDaemonTokenResult,
} from '../shared/ipc';
import { createWindow, installAppProtocol, installCsp, registerAppScheme } from './window';
import { ConnectionManager, daemonDataDir } from './connection/manager';
import { SYSTEMD_UNIT_NAME, baseUrlOf, systemdUnitPath } from './connection/discovery';
import { DaemonClient } from './daemon/client';
import { isLoopback } from '../shared/net';
import { ROUTES } from '../shared/routes';
import { StreamManager } from './streams/manager';
import { registerIpc } from './ipc';
import { loadManagedDaemon, loadPrefs, saveManagedDaemon, savePrefs } from './settings';
import { AppTray } from './tray';
import { closeAllNotifications } from './notify';
import { resolveCloseAction } from './lifecycle';
import { installMenu } from './menu';
import { WindowRegistry } from './windows';
import { DaemonSupervisor } from './daemon/supervisor';
import { startManagedDaemon } from './daemon/managed-daemon';
import { ensureManagedToken, generateToken, writeManagedToken } from './daemon/managed-token';

// Must happen before app.ready.
registerAppScheme();

const manager = new ConnectionManager();

// Streams live here, not in the renderer: the `?after=` cursor and the liveness
// probe need the token, and a renderer reload must re-attach rather than lose a
// run. Broadcast to every window (M3 multi-window costs nothing extra).
const streams = new StreamManager(
  (connectionId) => manager.clientFor(connectionId),
  (event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.streamEvent, event);
    }
  },
);

let mainWindow: BrowserWindow | null = null;
/** Per-window session + focus, for the notification rule and tray targeting. */
const registry = new WindowRegistry();

/**
 * The daemon we start and own. Left running across app exits on purpose
 * (`detached` + §5): tasks live on the daemon, and the phone may still be
 * connected. Stopping it is an explicit action, not a side effect of quitting.
 *
 * `loadRecord`/`saveRecord` persist its `{pid, startedAt}` so a *later* app run
 * can still recognise a daemon we left running as ours (see
 * `settings.ManagedDaemonRecord`).
 */
const managedDaemon = new DaemonSupervisor(daemonDataDir(), {
  loadRecord: loadManagedDaemon,
  saveRecord: saveManagedDaemon,
});
// Both this daemon and any hand-started one live in `~/.paboot`, so discovery
// can only tell "ours" from "someone else's" by pid (§已定 6).
manager.setManagedPidProvider(() => managedDaemon.pid());

/** Who holds `~/.paboot` right now — for labelling and the quit default only. */
type DaemonProvenance = 'app' | 'systemd' | 'manual';

/** The user unit a local daemon is installed as, if one is installed at all. */
function systemdUnit(): string | null {
  return fs.existsSync(systemdUnitPath(os.homedir())) ? SYSTEMD_UNIT_NAME : null;
}

/**
 * `systemctl --user` talks to this user's own systemd instance, so it needs
 * neither sudo nor a root context — but it does need the session bus, which a
 * launch outside a desktop session (or with a stripped env) may not set.
 */
function systemctlEnv(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  const runtimeDir = process.env['XDG_RUNTIME_DIR'] ?? (uid === undefined ? undefined : `/run/user/${uid}`);
  if (!runtimeDir) return process.env;
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    ...(process.env['DBUS_SESSION_BUS_ADDRESS'] ? {} : { DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` }),
  };
}

/** `systemctl --user <args>`, carrying what it said on stderr when it fails. */
function runSystemctl(args: string[]): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    execFile('systemctl', ['--user', ...args], { timeout: 20_000, env: systemctlEnv() }, (err, _stdout, stderr) => {
      if (!err) return resolve({ ok: true, message: '' });
      const detail = String(stderr ?? '').trim().split('\n')[0]?.trim() || (err as Error).message;
      resolve({ ok: false, message: detail });
    });
  });
}

/** The unit's live MainPID, or null when systemd cannot say. */
function systemdMainPid(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'systemctl',
      ['--user', 'show', '-p', 'MainPID', '--value', SYSTEMD_UNIT_NAME],
      { timeout: 10_000, env: systemctlEnv() },
      (err, stdout) => {
        if (err) return resolve(null);
        const pid = Number.parseInt(String(stdout).trim(), 10);
        resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
      },
    );
  });
}

/**
 * Whether the daemon holding the data dir *is* the systemd unit's process — the
 * check that decides between `systemctl stop` and signalling a pid, so an
 * installed-but-inactive unit never swallows a stop meant for a hand-started
 * daemon.
 */
async function systemdOwnsLive(): Promise<boolean> {
  if (systemdUnit() === null) return false;
  const live = managedDaemon.livePid();
  if (live === null) return false;
  return (await systemdMainPid()) === live;
}

/**
 * Start a daemon of our own, from the bundled copy — what both「启动」flows
 * (connect page and settings) do. Deliberately *not* `systemctl start` even when
 * a unit is installed: a daemon the user starts from the app is the app's, which
 * is what makes it fully manageable (restart, 改 token) afterwards. The unit is
 * only consulted to *stop* a daemon it owns, and to bounce one it owns.
 */
function spawnLocalDaemon(input: {
  workspace: string;
  port: number;
  host?: string;
}): Promise<ManagedDaemonStartResult> {
  return startManagedDaemon(managedDaemon, {
    ...input,
    dataDir: daemonDataDir(),
    userCommand: null,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
  });
}

/** Start the installed unit and wait for it — used when bouncing a systemd daemon. */
async function startSystemdUnit(): Promise<ManagedDaemonStartResult> {
  const started = await runSystemctl(['start', SYSTEMD_UNIT_NAME]);
  if (!started.ok) {
    return {
      ok: false,
      code: 'systemd_failed',
      message: `systemctl --user start ${SYSTEMD_UNIT_NAME} 失败：${started.message}`,
    };
  }
  const ready = await managedDaemon.waitReady();
  if (!ready) return { ok: false, code: 'timeout', message: 'systemd 已启动 paboot，但没有等到它就绪' };
  const token = ensureManagedToken(daemonDataDir());
  if (!token) return { ok: false, code: 'no_token', message: `无法读取 ${daemonDataDir()}/token` };
  return { ok: true, pid: ready.pid, listen: ready.listen, token };
}

/** Stop whatever holds the data dir: the unit when systemd owns it, else the pid. */
async function stopLocalDaemon(): Promise<ManagedDaemonStopResult> {
  if (await systemdOwnsLive()) {
    const res = await runSystemctl(['stop', SYSTEMD_UNIT_NAME]);
    if (res.ok) return { ok: true };
    console.warn('[paboot] systemctl stop failed, falling back to a direct signal:', res.message);
    if (await managedDaemon.stop()) return { ok: true };
    return { ok: false, message: `systemctl --user stop 失败（${res.message}），直接向 pid 发信号也没能停下它` };
  }
  if (await managedDaemon.stop()) return { ok: true };
  return { ok: false, message: 'daemon 没有在超时内退出（详见日志）' };
}

/**
 * Non-loopback IPv4 addresses of this machine, for the「局域网地址」row. Read from
 * the interfaces rather than from where some outbound request happens to land:
 * behind a proxy (or a VPN) that reports the proxy's address, which would be a
 * confident lie about how the phone should reach this machine.
 */
function localLanAddresses(): string[] {
  const found = new Set<string>();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address) found.add(iface.address);
    }
  }
  return [...found];
}

/** A bind that means "every interface" rather than one specific address. */
function isWildcardBind(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

const daemonApi = {
  status: () => {
    const pid = managedDaemon.livePid();
    const provenance: DaemonProvenance | null =
      pid === null ? null : managedDaemon.pid() !== null ? 'app' : systemdUnit() !== null ? 'systemd' : 'manual';
    const live = pid === null ? null : managedDaemon.liveRuntime();
    // '' means the daemon did not report a bind host (older build) — treat it as
    // unknown, never as "open to the LAN".
    const bindHost = live && live.host !== '' ? live.host : null;
    const port = live ? Number.parseInt(live.listen.slice(live.listen.lastIndexOf(':') + 1), 10) : Number.NaN;
    // Only a bind that is not loopback is reachable from the LAN; a wildcard bind
    // answers on every interface, a specific one only on itself.
    const lanAddresses: string[] = [];
    if (bindHost !== null && !isLoopback(bindHost) && Number.isInteger(port)) {
      for (const ip of isWildcardBind(bindHost) ? localLanAddresses() : [bindHost]) {
        lanAddresses.push(`${ip}:${port}`);
      }
    }
    return {
      running: pid !== null,
      pid,
      provenance,
      /** A unit is installed — it owns stopping (and bouncing) that daemon. */
      systemd: systemdUnit() !== null,
      restartable: systemdUnit() !== null || managedDaemon.hasLaunchSpec(),
      bindHost,
      lanAddresses,
      logPath: managedDaemon.logPath,
    };
  },
  start: async (input: { workspace: string; port: number; host?: string }) => {
    const res = await spawnLocalDaemon(input);
    // Bring the app's own connection to it back with the process.
    if (res.ok) await manager.reDialLocal();
    return res;
  },
  // A failed stop has to reach the user: without it the only symptom is "the
  // status still says running", which reads as a dead button.
  stop: async (): Promise<ManagedDaemonStopResult> => {
    const outcome = await stopLocalDaemon();
    // The daemon's death takes our connection with it; say so, or the window sits
    // on stale data with no way back to the connect page.
    if (outcome.ok) manager.markLocalDown();
    return outcome;
  },
  // 「改 token」: the running daemon only reads <data-dir>/token at startup, so we
  // stop it, swap the file, and start it again — leaving it down would make the
  // change look like it "didn't take".
  setToken: async (token?: string): Promise<ManagedDaemonTokenResult> => {
    const next = token ?? generateToken();
    const viaSystemd = systemdUnit() !== null;
    const status = daemonApi.status();
    const wasRunning = status.running;
    // We can only bring back a daemon we know how to start: through its unit, or
    // one *this run* spawned (`startLast` needs the command we launched, which
    // lives in memory). A daemon an earlier run left behind qualifies as ours but
    // not as restartable — stopping it there would strand it.
    const canRestart = viaSystemd || (status.provenance === 'app' && managedDaemon.hasLaunchSpec());
    const restart = () =>
      viaSystemd ? startSystemdUnit() : managedDaemon.startLast();

    if (wasRunning && !canRestart) {
      // Someone else's daemon, started in a way we do not know: write the token
      // and leave it running — taking it down would strand it with no way back.
      if (!writeManagedToken(daemonDataDir(), next)) {
        return { ok: false, code: 'token_write_failed', message: `无法写入 ${daemonDataDir()}/token` };
      }
      return { ok: true, token: next, restarted: false, listen: null };
    }

    if (wasRunning) await daemonApi.stop();
    if (!writeManagedToken(daemonDataDir(), next)) {
      // We may have just stopped it — bring it back rather than leave it down.
      if (wasRunning) await restart();
      return { ok: false, code: 'token_write_failed', message: `无法写入 ${daemonDataDir()}/token` };
    }
    if (!wasRunning) return { ok: true, token: next, restarted: false, listen: null };
    const res = await restart();
    if (!res.ok) {
      return { ok: false, code: res.code, message: `token 已改，但 daemon 重启失败：${res.message}` };
    }
    // It came back with a new token: re-dial so the app's own connection follows
    // (its old client would 401 on every request otherwise).
    await manager.reDialLocal();
    return { ok: true, token: next, restarted: true, listen: res.listen };
  },
};
/** Set on the way out, so the window's `close` handler stops intercepting. */
let quitting = false;
let closePromptOpen = false;

const tray = new AppTray({
  onOpen: () => showWindow(),
  // Raise the window that already has this session rather than always the main
  // one — with several windows open, that is where the user expects to land.
  onSelectSession: (sessionId) => {
    const existing = registry.showing(sessionId);
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    showWindow(sessionId);
  },
  onQuit: () => quitApp(),
});

function showWindow(sessionId?: string): void {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (sessionId) win.webContents.send(IPC.selectSession, sessionId);
}

/**
 * Quitting is the one place a managed daemon's fate is decided (§7.5). Attached
 * daemons (systemd, started by hand) are never touched — they are not ours.
 *
 * Default is 「一并停止」, so a user who never looks at the dialog does not leave
 * a process behind; 「保留」 is the deliberate opt-out for "keep serving the phone".
 * Quitting again mid-dialog is a no-op (`quitResolved`).
 */
let quitResolved = false;
let quitPromptOpen = false;

/**
 * What the quit prompt needs beyond ownership: can the phone reach this daemon,
 * and is anything actually running on it. One short authenticated round trip
 * each, best-effort — a failure just means the default falls back to ownership
 * (design §7.5's「自适应默认」).
 */
async function localDaemonFacts(): Promise<{ exposed: boolean; runningTasks: number } | null> {
  const live = managedDaemon.liveRuntime();
  if (!live) return null;
  const token = ensureManagedToken(daemonDataDir());
  if (!token) return null;
  const client = new DaemonClient({ baseUrl: baseUrlOf(live.listen, live.tls), token });
  const [config, sessions] = await Promise.all([
    client.request<{ server?: { host?: string } }>({ method: 'GET', path: ROUTES.config, timeoutMs: 2_000 }),
    client.request<{ sessions?: Array<{ runningRunId?: string | null }> }>({
      method: 'GET',
      path: ROUTES.sessions,
      timeoutMs: 2_000,
    }),
  ]);
  if (!config.ok && !sessions.ok) return null;
  const host = config.ok ? (config.data.server?.host ?? null) : null;
  const runningTasks = sessions.ok
    ? (sessions.data.sessions ?? []).filter((session) => session.runningRunId).length
    : 0;
  return { exposed: host !== null && !isLoopback(host), runningTasks };
}

async function resolveDaemonOnQuit(): Promise<boolean> {
  const status = daemonApi.status();
  if (!status.running) return true;
  const { daemonOnQuit } = loadPrefs();
  if (daemonOnQuit === 'stop') {
    await daemonApi.stop();
    return true;
  }
  if (daemonOnQuit === 'keep') return true;
  if (quitPromptOpen) return false;

  quitPromptOpen = true;
  try {
    const ours = status.provenance === 'app';
    const systemd = status.provenance === 'systemd';
    const facts = await localDaemonFacts();
    const tasks = facts?.runningTasks ?? 0;
    // 自适应默认 (design §7.5): keep when someone else could be relying on it —
    // it is not ours, or the phone can reach it, or work is in flight. Stopping
    // is then a deliberate click, never a stray Enter.
    const keepByDefault = !ours || facts?.exposed === true || tasks > 0;
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      message: ours ? '本应用启动的本机 daemon 还在运行' : '本机 daemon 还在运行（不是本应用启动的）',
      detail:
        (tasks > 0 ? `有 ${tasks} 个任务在跑，停止会中断它们。` : '') +
        '保留的话，手机和其它电脑仍能连上它，正在跑的任务也不会中断；停止则这台机器上的 agent 全部结束。' +
        (systemd ? '它由 systemd 托管，停止后要重新起来得用 systemctl --user start paboot。' : ''),
      buttons: ['一并停止', '保留（手机仍可连接）', '取消'],
      defaultId: keepByDefault ? 1 : 0,
      cancelId: 2,
      checkboxLabel: '记住我的选择',
      noLink: true,
    };
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const { response, checkboxChecked } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    if (response === 2) return false; // cancelled → the app stays up
    if (response === 1) {
      if (checkboxChecked) savePrefs({ daemonOnQuit: 'keep' });
      return true;
    }
    await daemonApi.stop();
    if (checkboxChecked) savePrefs({ daemonOnQuit: 'stop' });
    return true;
  } finally {
    quitPromptOpen = false;
  }
}

function quitApp(): void {
  // Everything real happens in `before-quit`, so the tray menu, ⌘Q and the
  // window-close prompt all take the same path.
  app.quit();
}

function createMainWindow(): BrowserWindow {
  const win = createWindow({
    onCloseRequested: (target, event) => {
      if (quitting) return;
      // Must be decided synchronously — the rest of the handler may await.
      event.preventDefault();
      void resolveClose(target);
    },
  });
  mainWindow = win;
  registry.add(win);
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    registry.remove(win);
  });
  return win;
}

/**
 * A second window pinned to one session — `§7.3`: 每个窗口一个会话，可并排看两个
 * agent. Closing it really closes it: the tray's「打开主窗口」only knows the main
 * window, so hiding a secondary one would strand it with no way back.
 */
function openSessionWindow(sessionId: string): void {
  const win = createWindow({ onCloseRequested: () => {} });
  registry.add(win);
  registry.setPending(win, sessionId);
  win.on('closed', () => registry.remove(win));
}

function hideOrQuit(win: BrowserWindow, behavior: 'tray' | 'quit'): void {
  if (resolveCloseAction(behavior, tray.available) === 'quit') {
    quitApp();
    return;
  }
  win.hide();
}

async function resolveClose(win: BrowserWindow): Promise<void> {
  const { closeBehavior } = loadPrefs();
  if (closeBehavior !== 'ask') {
    hideOrQuit(win, closeBehavior);
    return;
  }
  if (closePromptOpen) return;
  closePromptOpen = true;
  try {
    const { response, checkboxChecked } = await dialog.showMessageBox(win, {
      type: 'question',
      message: '关闭窗口时',
      detail:
        'paboot 会在托盘常驻，正在跑的任务不受影响——它们在 daemon 上执行，关掉这个窗口不会中断。',
      buttons: ['最小化到托盘', '退出应用', '取消'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: '记住我的选择',
      noLink: true,
    });
    if (response === 2) return;
    const behavior = response === 1 ? 'quit' : 'tray';
    if (checkboxChecked) savePrefs({ closeBehavior: behavior });
    hideOrQuit(win, behavior);
  } finally {
    closePromptOpen = false;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  // An explicit quit (tray menu, ⌘Q, File ▸ Quit) must not be intercepted by
  // the window's "closing is not quitting" handler — but it *is* the moment the
  // managed daemon's fate is decided, which needs to be async.
  app.on('before-quit', (event) => {
    quitting = true;
    if (quitResolved) return;
    event.preventDefault();
    void (async () => {
      let proceed = true;
      try {
        proceed = await resolveDaemonOnQuit();
      } catch (err) {
        // A failed stop must not trap the user in a windowless app.
        console.warn('[paboot] resolving the managed daemon on quit failed:', err);
      }
      if (!proceed) {
        // The user cancelled the prompt: undo the quit, or the app exits anyway
        // and the next window close would sail straight through (`quitting`).
        quitting = false;
        return;
      }
      quitResolved = true;
      closeAllNotifications();
      app.quit();
    })();
  });

  app.whenReady().then(() => {
    installMenu();
    installAppProtocol();
    installCsp(session.defaultSession);
    registerIpc(manager, streams, { tray, showWindow, quitApp, openSessionWindow, daemon: daemonApi }, registry);

    if (!tray.create()) {
      // Everything except the tray still works; `hideOrQuit` degrades to quitting.
      console.warn('[paboot] no system tray available on this desktop');
    }

    createMainWindow();

    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // With a tray the app outlives its window by design; without one there is
    // nothing left to interact with.
    if (!tray.available) app.quit();
  });
}
