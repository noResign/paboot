import { formatCombo, modLabel, SHORTCUTS } from '../../shortcuts/shortcuts';
import { Icon } from '../../ui/Icon';
import { IS_MAC } from '../../ui/platform';

/** `?` — generated from the shortcut table, so it can never drift from it. */
export function ShortcutHelp({ onClose }: { onClose(): void }) {
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal help-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span>快捷键</span>
          <button className="btn ghost" title="关闭" onClick={onClose}>
                <Icon name="x" size={15} />
              </button>
        </div>
        <ul className="help-list">
          {SHORTCUTS.map((shortcut) => (
            <li key={shortcut.id}>
              <kbd className="help-combo mono">{formatCombo(shortcut.combo, IS_MAC)}</kbd>
              <span>{shortcut.label}</span>
            </li>
          ))}
        </ul>
        <div className="hint">
          会话内还有：审批弹窗 <b>{modLabel(IS_MAC)}⏎</b> 允许 / <b>{modLabel(IS_MAC)}⌫</b> 拒绝（Esc 只会聚焦「拒绝」，不会关闭弹窗）。
        </div>
      </div>
    </div>
  );
}
