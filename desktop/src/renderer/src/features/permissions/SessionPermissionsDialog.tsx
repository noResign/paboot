import { useEffect, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { api } from '../../ipc/client';
import { friendlyMessage, apiErrorOf } from '../../../../shared/errors';
import { permissionModeOptions, PERMISSION_MODE_LABEL } from '../../../../shared/runtime-identity';
import type { PermissionGrantDto, ProductPermissionMode } from '../../../../shared/contract';

interface Props {
  sessionId: string;
  runtime: string | null;
  onClose(): void;
  /** Tell the chat view the mode changed so its badge follows. */
  onModeChanged(mode: ProductPermissionMode): void;
}

/**
 * Per-session approval settings. This is the only place a "allow all" grant can
 * be revoked — and revoking never un-approves anything already approved.
 */
export function SessionPermissionsDialog({ sessionId, runtime, onClose, onModeChanged }: Props) {
  const [mode, setMode] = useState<ProductPermissionMode | null>(null);
  const [grants, setGrants] = useState<PermissionGrantDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    const res = await api.sessionPermissions(sessionId);
    if (!res.ok) {
      setError(`加载失败（HTTP ${res.status}）`);
      return;
    }
    setMode(res.data.mode);
    setGrants(res.data.grants);
  }

  useEffect(() => {
    void refresh();
  }, [sessionId]);

  async function changeMode(next: ProductPermissionMode): Promise<void> {
    setBusy(true);
    const res = await api.setSessionPermissionMode(sessionId, next);
    setBusy(false);
    if (!res.ok) {
      const { apiCode, message } = apiErrorOf(res.data);
      setError(friendlyMessage(apiCode, res.status, message));
      return;
    }
    setMode(next);
    onModeChanged(next);
  }

  async function revoke(toolName: string): Promise<void> {
    setBusy(true);
    const res = await api.revokePermissionGrant(sessionId, toolName);
    setBusy(false);
    if (!res.ok) {
      setError('撤销失败');
      return;
    }
    await refresh();
  }

  async function revokeAll(): Promise<void> {
    setBusy(true);
    const res = await api.revokeAllPermissionGrants(sessionId);
    setBusy(false);
    if (!res.ok) {
      setError('撤销失败');
      return;
    }
    await refresh();
  }

  const modes = permissionModeOptions(runtime);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal session-perms-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>会话权限</span>
          <button className="btn ghost" title="关闭" onClick={onClose}>
                <Icon name="x" size={15} />
              </button>
        </div>

        <div className="field">
          <label>权限模式</label>
          <div className="mode-picker">
            {modes.map((option) => (
              <button
                key={option.mode}
                className={`mode-option${option.mode === mode ? ' active' : ''}`}
                disabled={busy || mode === null}
                onClick={() => void changeMode(option.mode)}
              >
                <b>{PERMISSION_MODE_LABEL[option.mode]}</b>
                <span>{option.description}</span>
              </button>
            ))}
          </div>
          <div className="hint">改模式只影响<b>下一次</b>运行，不会打断正在跑的 run。</div>
        </div>

        <div className="field">
          <label>
            已授权工具（{grants.length}）
            {grants.length > 0 && (
              <button className="btn ghost tiny" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void revokeAll()}>
                全部撤销
              </button>
            )}
          </label>
          {grants.length === 0 ? (
            <div className="hint">没有已授权的工具。「允许全部」会在这里留下一条记录。</div>
          ) : (
            <ul className="grant-list">
              {grants.map((grant) => (
                <li key={grant.toolName} className={`grant-item${mode === 'bypass' ? ' paused' : ''}`}>
                  <code className="mono">{grant.toolName}</code>
                  <span className="hint">{new Date(grant.createdAt).toLocaleString()}</span>
                  <button className="btn ghost tiny" disabled={busy} onClick={() => void revoke(grant.toolName)}>
                    撤销
                  </button>
                </li>
              ))}
            </ul>
          )}
          {mode === 'bypass' && (
            <div className="hint">当前是 bypass：所有审批都被跳过，这些授权处于「已暂停」状态，改回其他模式后重新生效。</div>
          )}
        </div>

        <div className="perm-scope">
          这些授权是 <b>Session + toolName</b>，存在 daemon 上，所以
          <b>其他设备看这个会话时同样免问</b>；撤销只影响后续请求，撤不回已经批准并执行过的操作。
        </div>

        {error && <div className="error-text">{error}</div>}
      </div>
    </div>
  );
}
