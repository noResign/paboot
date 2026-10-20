import { join } from 'node:path';
import { Menu, Tray, nativeImage } from 'electron';
import type { TrayState } from '../shared/ipc';

export interface TrayDeps {
  onOpen(): void;
  onSelectSession(sessionId: string): void;
  onQuit(): void;
}

const MAX_MENU_SESSIONS = 5;

/**
 * `build/` ships next to `out/` in both dev and the packaged asar — same path
 * trick as the window icon (`window.ts`). `tray-icon.png` is 22px and
 * `tray-icon@2x.png` 44px; Electron picks the 2x file up from the name.
 */
const TRAY_DIR = join(__dirname, '../../build/tray');

/**
 * The tray icon is the app icon at tray size: the brand gradient tile with the
 * mascot's head in white. Deliberately **not** a template image — template
 * images are monochrome by definition (`setTemplateImage` only keeps alpha) and
 * would throw the tile away, leaving the transparent glyph look that reads as a
 * black square on a dark panel.
 */
function trayImage(): Electron.NativeImage {
  return nativeImage.createFromPath(join(TRAY_DIR, 'tray-icon.png'));
}

/**
 * The tray is what keeps the app alive after the window is closed — and being
 * alive is what makes notifications possible at all. It owns no state: the
 * renderer pushes what should be shown (`app:tray:state`), because only the
 * renderer knows which sessions are running.
 */
export class AppTray {
  private tray: Tray | null = null;
  private state: TrayState = { runningCount: 0, sessions: [] };

  constructor(private readonly deps: TrayDeps) {}

  /**
   * Returns false when the platform has no status-notifier host (a bare X
   * session, some minimal desktops). That is not fatal: everything except the
   * tray icon still works, and the window just closes instead of hiding.
   */
  create(): boolean {
    if (this.tray) return true;
    try {
      this.tray = new Tray(trayImage());
      this.tray.on('click', () => this.deps.onOpen());
      this.rebuild();
      return true;
    } catch {
      this.tray = null;
      return false;
    }
  }

  get available(): boolean {
    return this.tray !== null;
  }

  setState(state: TrayState): void {
    this.state = state;
    this.rebuild();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private rebuild(): void {
    if (!this.tray) return;
    const { runningCount, sessions } = this.state;

    const items: Electron.MenuItemConstructorOptions[] = [
      { label: '打开主窗口', click: () => this.deps.onOpen() },
    ];

    if (runningCount > 0) {
      items.push({ type: 'separator' }, { label: `${runningCount} 个任务运行中`, enabled: false });
      for (const session of sessions.slice(0, MAX_MENU_SESSIONS)) {
        items.push({ label: `    ${truncate(session.title)}`, click: () => this.deps.onSelectSession(session.id) });
      }
      if (sessions.length > MAX_MENU_SESSIONS) {
        items.push({ label: `    …还有 ${sessions.length - MAX_MENU_SESSIONS} 个`, enabled: false });
      }
    }

    items.push({ type: 'separator' }, { label: '退出 paboot', click: () => this.deps.onQuit() });

    this.tray.setContextMenu(Menu.buildFromTemplate(items));
    this.tray.setToolTip(runningCount > 0 ? `paboot · ${runningCount} 个任务运行中` : 'paboot');
  }
}

function truncate(text: string, max = 40): string {
  const clean = text.replace(/\s+/g, ' ').trim() || '未命名会话';
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
