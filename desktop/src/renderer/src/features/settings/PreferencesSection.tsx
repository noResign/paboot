import { useEffect, useState } from 'react';
import { api } from '../../ipc/client';
import { apiErrorOf, friendlyMessage } from '../../../../shared/errors';
import {
  clampPermissionMode,
  permissionModeOptions,
  PERMISSION_MODE_LABEL,
} from '../../../../shared/runtime-identity';
import type { ProductPermissionMode } from '../../../../shared/contract';

/**
 * 默认偏好 (pages/settings.md §6.7): the daemon-side defaults a new session
 * inherits. Only the permission mode is configurable — "default agent" has no
 * daemon setting, so both clients just preselect the first *available* one
 * (`defaultAgentId`); there is nothing to store.
 */
export function PreferencesSection() {
  const [mode, setMode] = useState<ProductPermissionMode | null>(null);
  const [bypassAllowed, setBypassAllowed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void api.config().then((res) => {
      if (!live) return;
      if (!res.ok) {
        setError(`加载失败（HTTP ${res.status}）`);
        return;
      }
      setBypassAllowed(res.data.bypassAllowed);
      setMode(clampPermissionMode(res.data.defaultPermissionMode, res.data.bypassAllowed));
    });
    return () => {
      live = false;
    };
  }, []);

  async function choose(next: ProductPermissionMode): Promise<void> {
    if (next === mode || busy) return;
    const previous = mode;
    // Optimistic: the choice sticks now and rolls back only if the daemon refuses
    // — same shape as the Android settings screen (沿用).
    setMode(next);
    setError(null);
    setBusy(true);
    const res = await api.updateConfig({ defaultPermissionMode: next });
    setBusy(false);
    if (!res.ok) {
      setMode(previous);
      const { apiCode, message } = apiErrorOf(res.data);
      setError(friendlyMessage(apiCode, res.status, message, '保存默认权限模式失败'));
    }
  }

  const effectiveMode = mode === null ? null : clampPermissionMode(mode, bypassAllowed);

  return (
    <section className="settings-section">
      <h3>默认偏好</h3>
      <div className="field">
        <label>新建会话的默认权限模式</label>
        <div className="mode-picker">
          {permissionModeOptions(null, bypassAllowed).map((option) => (
            <button
              key={option.mode}
              className={`mode-option${option.mode === effectiveMode ? ' active' : ''}`}
              disabled={busy || effectiveMode === null}
              onClick={() => void choose(option.mode)}
            >
              <b>{PERMISSION_MODE_LABEL[option.mode]}</b>
              <span>{option.description}</span>
            </button>
          ))}
        </div>
        <div className="hint">只决定新会话的初始值；会话建好后仍可在会话设置里单独改。</div>
      </div>
      <div className="field">
        <label>默认 Agent</label>
        <div className="hint" style={{ marginTop: 0 }}>
          新建会话自动选中第一个<b>已安装</b>的 Agent，无需配置。
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}
    </section>
  );
}
