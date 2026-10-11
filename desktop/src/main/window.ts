import { BrowserWindow, nativeImage, net, protocol, shell, type Session } from 'electron';
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

export function createWindow(options: WindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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

  win.on('ready-to-show', () => win.show());

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
