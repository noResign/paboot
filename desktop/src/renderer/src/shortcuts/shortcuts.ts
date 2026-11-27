/**
 * Shortcuts as data, not as scattered `onKeyDown` handlers
 * (docs/local/desktop_ui_design.md §7.1). Matching, the help panel and — when
 * it arrives — user customisation all read this one array; custom overrides
 * will be keyed by `id`, so **ids are stable contracts**: renaming one silently
 * drops the user's binding.
 *
 * `mod` is meta on macOS and ctrl everywhere else, but we accept either so the
 * same muscle memory works over SSH-forwarded X and on a Mac.
 */
export interface Shortcut {
  id: string;
  /** `mod+shift+k` style; the last segment is the key. */
  combo: string;
  label: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'command-palette', combo: 'mod+k', label: '命令面板' },
  { id: 'new-session', combo: 'mod+n', label: '新建会话' },
  { id: 'toggle-rail', combo: 'mod+b', label: '切换左栏显隐' },
  { id: 'go-sessions', combo: 'mod+1', label: '切到会话' },
  { id: 'go-tasks', combo: 'mod+2', label: '切到定时任务' },
  { id: 'go-settings', combo: 'mod+,', label: '设置' },
  // The way back out of a full-area page. Bare, so it stands down while a text
  // field has focus (see `isModifierless`). Named for the action, not the
  // destination: settings is not always entered from the conversation view.
  { id: 'back', combo: 'escape', label: '返回' },
  { id: 'refresh', combo: 'mod+r', label: '刷新会话列表' },
  { id: 'stop-run', combo: 'mod+.', label: '停止当前运行' },
  { id: 'next-session', combo: 'mod+shift+]', label: '下一个会话' },
  { id: 'prev-session', combo: 'mod+shift+[', label: '上一个会话' },
  { id: 'zoom-in', combo: 'mod+=', label: '放大界面' },
  { id: 'zoom-out', combo: 'mod+-', label: '缩小界面' },
  { id: 'zoom-reset', combo: 'mod+0', label: '重置缩放' },
  { id: 'toggle-tool-groups', combo: 'mod+shift+e', label: '展开/折叠全部工具组' },
  // There is no app menu to carry this any more (see main/menu.ts) — the
  // shortcut is the only way in, in dev and packaged builds alike.
  { id: 'toggle-devtools', combo: 'mod+shift+i', label: '开发者工具' },
  { id: 'help', combo: '?', label: '快捷键帮助' },
] as const;

export function shortcutById(id: string): Shortcut | undefined {
  return SHORTCUTS.find((shortcut) => shortcut.id === id);
}

/**
 * Keys arrive shifted (`⌘⇧]` reports `}`), so each combo key accepts its
 * shifted spelling too. Without this, half the table silently never fires.
 */
const KEY_ALIASES: Record<string, string[]> = {
  '=': ['=', '+'],
  '-': ['-', '_'],
  '[': ['[', '{'],
  ']': [']', '}'],
};

const MODIFIER_KEYS = new Set(['shift', 'alt', 'mod']);

/** Keys that are spelled out in a combo but not in the help panel. */
const KEY_LABELS: Record<string, string> = { escape: 'Esc' };

export interface ComboMatchInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Lenient on modifiers not named in the combo (so `mod+=` also fires for
 * `mod+shift+=`), strict on the ones that are.
 */
export function comboMatches(event: ComboMatchInput, combo: string): boolean {
  const parts = combo.split('+').map((part) => part.trim().toLowerCase());
  const key = parts[parts.length - 1];
  if (!key) return false;
  const modifiers = new Set(parts.slice(0, -1));

  const eventMod = event.metaKey || event.ctrlKey;
  if (modifiers.has('mod') !== eventMod) return false;
  if (modifiers.has('shift') && !event.shiftKey) return false;
  if (modifiers.has('alt') && !event.altKey) return false;

  const pressed = event.key.toLowerCase();
  const accepted = KEY_ALIASES[key] ?? [key];
  return accepted.includes(pressed);
}

/** Which shortcut, if any, this key event triggers. */
export function matchShortcut(event: ComboMatchInput): Shortcut | null {
  for (const shortcut of SHORTCUTS) {
    if (comboMatches(event, shortcut.combo)) return shortcut;
  }
  return null;
}

/** Just the `mod` glyph — for prose like「⌘+/−/0」that isn't one combo. */
export function modLabel(isMac: boolean): string {
  return isMac ? '⌘' : 'Ctrl';
}

/** Human-readable combo for the help panel; `mod` renders per platform. */
export function formatCombo(combo: string, isMac: boolean): string {
  return combo
    .split('+')
    .map((part) => {
      const lower = part.trim().toLowerCase();
      if (MODIFIER_KEYS.has(lower)) {
        if (lower === 'mod') return modLabel(isMac);
        if (lower === 'shift') return isMac ? '⇧' : 'Shift';
        return isMac ? '⌥' : 'Alt';
      }
      return KEY_LABELS[lower] ?? part.trim().toUpperCase();
    })
    .join(isMac ? '' : '+');
}

/**
 * Display string for a shortcut id — taken from the same table the help panel
 * uses, so a rebind can never drift from a tooltip. `''` when the id is unknown.
 */
export function comboLabel(id: string, isMac: boolean): string {
  const shortcut = SHORTCUTS.find((item) => item.id === id);
  return shortcut ? formatCombo(shortcut.combo, isMac) : '';
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

/** Single-key combos (`?`) must not steal keystrokes from a text field. */
export function isModifierless(combo: string): boolean {
  return !combo.split('+').some((part) => ['mod', 'shift', 'alt'].includes(part.trim().toLowerCase()));
}
