import { BrowserWindow, nativeImage, net, protocol, screen, shell, type Session } from 'electron';
import { loadWindowBounds, saveWindowBounds, type WindowBounds } from './settings';
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The renderer is served over a custom `paboot://` scheme rather than
 * `file://` because `file://` has a `null` origin, which breaks localStorage /
 * IndexedDB and makes routing awkward. It must be registered before `app.ready`.
 */
export const APP_SCHEME = 'paboot';
export const APP_ORIGIN = `${APP_SCHEME}://app`;

const RENDERER_DIR = join(__dirname, '../renderer');

/**
 * The window icon. Without it Linux window managers fall back to a generic
 * placeholder in the dock/taskbar — the app icon is only consulted for packaged
 * builds, via the `.desktop` entry.
 *
 * Ships in the app because electron-builder's `files` include `build/icon.png`;
 * in a dev run the same relative path resolves inside the checkout.
 *
 * Resized at runtime rather than shipped at 128: **Electron only sets
 * `_NET_WM_ICON` when the icon is ≤128px** (measured: 128 works, 256 and up
 * leave the property empty, whether passed as a path or as a NativeImage).
 * Scaling the 1024 packaging master here keeps a single source image.
 */
const WINDOW_ICON_PATH = join(__dirname, '../../build/icon.png');
const WINDOW_ICON_SIZE = 128;

function windowIcon(): Electron.NativeImage | undefined {
  if (!existsSync(WINDOW_ICON_PATH)) return undefined;
  const image = nativeImage.createFromPath(WINDOW_ICON_PATH);
  return image.isEmpty() ? undefined : image.resize({ width: WINDOW_ICON_SIZE });
}

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** Serve the built SPA, with path-traversal rejection and an extension-less fallback. */
export function installAppProtocol(): void {
  const root = normalize(RENDERER_DIR);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname);
    // Chromium occasionally asks for `/index.html` directly; serve it rather
    // than redirect so a router never observes that path.
    if (rel !== '/' && rel !== '/index.html' && extname(rel) === '') {
      return serve(join(root, 'index.html'));
    }
    const requested = rel === '/' ? '/index.html' : rel;
    const resolved = normalize(join(root, requested));
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      return new Response('forbidden', { status: 403 });
    }
    if (!isFile(resolved)) return new Response('not found', { status: 404 });
    return serve(resolved);
  });
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function serve(file: string): Promise<Response> {
  return net.fetch(pathToFileURL(file).toString());
}

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' paboot-media: data: blob:",
  "media-src 'self' paboot-media: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join('; ');

/** Vite HMR needs inline/eval scripts and a websocket back to the dev server. */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' paboot-media: data: blob:",
  "media-src 'self' paboot-media: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * CSP is set on responses, not via a `<meta>` tag — a meta tag can be stripped
 * by an injection, the header cannot. dev vs prod is chosen by whether
 * electron-vite handed us a dev-server URL.
 */
export function installCsp(session: Session): void {
  const csp = process.env['ELECTRON_RENDERER_URL'] ? DEV_CSP : PROD_CSP;
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
    });
  });
}

export interface WindowOptions {
  /**
   * Asked when the user closes the window. Returning is not enough — the close
   * must be `preventDefault`ed first, so the caller decides whether to hide, to
   * quit, or to leave the window alone.
   */
  onCloseRequested(win: BrowserWindow, event: Electron.Event): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** True when `bounds` still overlaps some connected display's work area. */
function onSomeDisplay(bounds: WindowBounds): boolean {
  return screen.getAllDisplays().some(({ workArea }) =>
    bounds.x < workArea.x + workArea.width &&
    bounds.x + bounds.width > workArea.x &&
    bounds.y < workArea.y + workArea.height &&
    bounds.y + bounds.height > workArea.y,
  );
}

export function createWindow(options: WindowOptions): BrowserWindow {
  // Reopen where the user left it, when that spot is still on a connected
  // display. Otherwise fall back to a display-relative size: a fixed box is
  // cramped on a big monitor and overflows a small one, so take 92% of the work
  // area, capped.
  const saved = loadWindowBounds();
  const restore = saved && onSomeDisplay(saved) ? saved : null;
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: restore?.width ?? clamp(Math.round(workArea.width * 0.92), 960, 1600),
    height: restore?.height ?? clamp(Math.round(workArea.height * 0.92), 640, 1000),
    ...(restore ? { x: restore.x, y: restore.y } : { center: true }),
    minWidth: 960,
    minHeight: 640,
    show: false,
    icon: windowIcon(),
    backgroundColor: '#111214',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  if (restore?.maximized) win.maximize();

  win.on('ready-to-show', () => win.show());

  // Remember geometry for the next launch. move/resize fire continuously, so
  // persist is debounced; a close flushes immediately.
  let saveTimer: NodeJS.Timeout | null = null;
  const persistBounds = (): void => {
    if (win.isDestroyed()) return;
    saveWindowBounds({ ...win.getNormalBounds(), maximized: win.isMaximized() });
  };
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistBounds, 400);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    persistBounds();
  });

  // Closing the window is not quitting the app (the tray keeps it alive and
  // runs continue on the daemon); the decision belongs to the caller.
  win.on('close', (event) => options.onCloseRequested(win, event));

  // External links never navigate this window; they open in the user's browser
  // and only over http(s).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadURL(`${APP_ORIGIN}/`);
  }
  return win;
}
