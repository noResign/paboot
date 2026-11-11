import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { api } from '../../ipc/client';
import type {
  CapabilityDeviceDto,
  EndDto,
  EndImpactDto,
  EndSuggestionDto,
} from '../../../../shared/contract';
import { Icon } from '../../ui/Icon';
import { DirectoryPickerDialog } from '../workspaces/DirectoryPickerDialog';
import {
  archiveConfirmLabel,
  deleteConfirmLabel,
  impactLines,
  splitEnds,
} from './endLifecycle';

interface Props {
  workspaceId: string;
  workspaceName: string;
  /** When set, the panel is scoped to this end (opened from the end detail). */
  endId?: string;
  onClose(): void;
}

interface Shot {
  png: string;
  width: number;
  height: number;
}

interface PendingAction {
  kind: 'archive' | 'delete';
  end: EndDto;
}

function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const record = data as { error?: unknown; message?: unknown };
    if (typeof record.message === 'string' && record.message) return record.message;
    if (typeof record.error === 'string' && record.error) return record.error;
  }
  return `请求失败（HTTP ${status}）`;
}

function basename(directory: string): string {
  const parts = directory.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'Android';
}

export function DevicePanel({ workspaceId, workspaceName, endId, onClose }: Props) {
  const [ends, setEnds] = useState<EndDto[]>([]);
  const [suggestions, setSuggestions] = useState<EndSuggestionDto[]>([]);
  const [activeEnd, setActiveEnd] = useState<EndDto | null>(null);
  const [devices, setDevices] = useState<CapabilityDeviceDto[]>([]);
  const [serial, setSerial] = useState<string | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [clickEnabled, setClickEnabled] = useState(false);
  const [mirroring, setMirroring] = useState(false);
  const [rootPicker, setRootPicker] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [impact, setImpact] = useState<EndImpactDto | null>(null);
  const [impactBusy, setImpactBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api.workspaceEnds(workspaceId);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      setLoading(false);
      return;
    }
    setEnds(res.data.ends);
    const active = endId
      ? res.data.ends.find((end) => end.id === endId) ?? null
      : splitEnds(res.data.ends).active;
    setActiveEnd(active);
    setShot(null);
    setDevices([]);
    setSerial(null);
    setMirroring(false);
    if (!active) {
      const scanned = await api.endSuggestions(workspaceId);
      if (scanned.ok) setSuggestions(scanned.data.suggestions);
    } else {
      setSuggestions([]);
    }
    setLoading(false);
  }, [workspaceId, endId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDevices = useCallback(
    async (endId: string) => {
      const res = await api.deviceList(workspaceId, endId);
      if (!res.ok) {
        setError(errorMessage(res.data, res.status));
        return;
      }
      setDevices(res.data.devices);
      const online = res.data.devices.filter((device) => device.state === 'device');
      setSerial(res.data.serial ?? (online.length === 1 ? online[0]!.serial : null));
    },
    [workspaceId],
  );

  useEffect(() => {
    if (!activeEnd) return;
    void loadDevices(activeEnd.id);
  }, [activeEnd, loadDevices]);

  useEffect(() => {
    setShot(null);
    if (!serial) setMirroring(false);
  }, [serial]);

  useEffect(() => {
    if (!activeEnd || !serial || !mirroring) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      const res = await api.deviceAction<Shot>(workspaceId, {
        action: 'screenshot',
        endId: activeEnd.id,
        serial,
      });
      if (cancelled) return;
      if (res.ok) {
        setShot(res.data);
        setError(null);
      } else {
        setError(errorMessage(res.data, res.status));
      }
      timer = setTimeout(() => void tick(), 1500);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeEnd, serial, mirroring, workspaceId]);

  async function addEnd(directory: string): Promise<void> {
    setBusy(true);
    setError(null);
    const created = await api.createWorkspaceEnd(workspaceId, basename(directory));
    if (!created.ok) {
      setError(errorMessage(created.data, created.status));
      setBusy(false);
      return;
    }
    const endId = created.data.end.id;
    const bound = await api.bindEndRoot(workspaceId, endId, directory);
    if (!bound.ok) {
      setError(errorMessage(bound.data, bound.status));
      setBusy(false);
      return;
    }
    const activated = await api.activateEnd(workspaceId, endId);
    setBusy(false);
    if (!activated.ok) {
      setError(errorMessage(activated.data, activated.status));
      return;
    }
    setNotice('Android 端已添加');
    await load();
  }

  async function addRoot(root: string): Promise<void> {
    if (!activeEnd) return;
    setBusy(true);
    setError(null);
    const bound = await api.bindEndRoot(workspaceId, activeEnd.id, root);
    setBusy(false);
    if (!bound.ok) {
      setError(errorMessage(bound.data, bound.status));
      return;
    }
    setNotice('已添加端目录');
    await load();
  }

  async function removeRoot(root: string): Promise<void> {
    if (!activeEnd) return;
    setBusy(true);
    setError(null);
    const res = await api.unbindEndRoot(workspaceId, activeEnd.id, root);
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setNotice('已移除端目录');
    await load();
  }

  function closeImpact(): void {
    setPending(null);
    setImpact(null);
    setImpactBusy(false);
  }

  async function openImpact(kind: PendingAction['kind'], end: EndDto): Promise<void> {
    setPending({ kind, end });
    setImpact(null);
    setImpactBusy(true);
    setError(null);
    const res = await api.endImpact(workspaceId, end.id);
    setImpactBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      closeImpact();
      return;
    }
    setImpact(res.data.impact);
  }

  async function confirmPending(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    setError(null);
    const res =
      pending.kind === 'archive'
        ? await api.archiveEnd(workspaceId, pending.end.id)
        : await api.deleteWorkspaceEnd(workspaceId, pending.end.id);
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setNotice(pending.kind === 'archive' ? '端已归档' : '端已移除');
    closeImpact();
    await load();
  }

  async function restoreEnd(end: EndDto): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await api.restoreEnd(workspaceId, end.id);
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setNotice('端已恢复');
    await load();
  }

  async function selectDevice(next: string): Promise<void> {
    if (!activeEnd) return;
    setSerial(next);
    const res = await api.selectDevice(workspaceId, activeEnd.id, next);
    if (!res.ok) setError(errorMessage(res.data, res.status));
  }

  async function onMirrorClick(event: MouseEvent<HTMLImageElement>): Promise<void> {
    if (!mirroring || !clickEnabled || !shot || !activeEnd || !serial) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.round(((event.clientX - rect.left) / rect.width) * shot.width);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * shot.height);
    const res = await api.deviceAction(workspaceId, {
      action: 'tap',
      endId: activeEnd.id,
      serial,
      x,
      y,
    });
    if (!res.ok) setError(errorMessage(res.data, res.status));
  }

  const online = useMemo(
    () => devices.filter((device) => device.state === 'device'),
    [devices],
  );
  const groups = useMemo(() => splitEnds(ends), [ends]);

  return (
    <div
      className="kn-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Android 设备"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
    <div className="kn-panel device-panel">
      <header className="kn-head">
        <div className="kn-head-copy">
          <div className="kn-head-title">
            <Icon name="eye" size={16} />
            <h2>Android 设备</h2>
            <span className="badge subtle">{workspaceName}</span>
          </div>
          <p className="hint">
            进入后不会自动投屏；点「开始投屏」查看设备画面，需要时再停止。点击操作默认关闭。
          </p>
        </div>
        <div className="kn-head-actions">
          <button className="icon-btn" title="刷新" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
          </button>
          <button className="icon-btn kn-close" title="关闭" aria-label="关闭" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
      </header>

      <div className="device-body">
        {loading ? (
          <p className="hint">加载中…</p>
        ) : !activeEnd ? (
          <>
            <div className="section-head">
              <h3>添加 Android 端</h3>
            </div>
            <p className="hint">
              在工作区里找到 Android 工程后添加；端只用于设备能力，不改变会话目录。目录若不在主工作区内，
              请先在「设置 → 工作区管理」中加为附加目录。
            </p>
            {suggestions.length === 0 ? (
              <p className="hint">没有发现 Gradle / AndroidManifest.xml。可先添加工程目录再重新扫描。</p>
            ) : (
              suggestions.map((suggestion) => (
                <div className="device-suggestion" key={suggestion.path}>
                  <div>
                    <div className="mono">{suggestion.path}</div>
                    <div className="hint">{suggestion.reasons.join(' · ')}</div>
                  </div>
                  <button
                    className="btn primary"
                    disabled={busy}
                    onClick={() => void addEnd(suggestion.path)}
                  >
                    添加
                  </button>
                </div>
              ))
            )}
            {groups.draft.length > 0 && (
              <p className="hint">有 {groups.draft.length} 个草稿端尚未激活。</p>
            )}
            {groups.archived.length > 0 && (
              <p className="hint">下方已归档的端可恢复后继续使用。</p>
            )}
          </>
        ) : (
          <>
            <div className="device-toolbar">
              <div className="device-row">
                <span className="badge subtle">端：{activeEnd.name}</span>
                <span className="hint">
                  {activeEnd.roots.length > 0 ? `${activeEnd.roots.length} 个目录` : '未绑定目录'}
                </span>
                <span className="mem-spacer" />
                {!endId && (
                  <>
                    <button className="btn" disabled={busy} onClick={() => setRootPicker(true)}>
                      添加目录
                    </button>
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => void openImpact('archive', activeEnd)}
                    >
                      归档
                    </button>
                    <button className="btn" disabled title="请先归档端，再到归档列表移除">
                      移除端
                    </button>
                  </>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={clickEnabled}
                    onChange={(event) => setClickEnabled(event.target.checked)}
                  />
                  允许点击操作
                </label>
              </div>
              {activeEnd.roots.length > 0 && (
                <div className="device-roots">
                  {activeEnd.roots.map((root) => (
                    <div className="device-root-row" key={root}>
                      <span className="mono device-root" title={root}>
                        {root}
                      </span>
                      {!endId && (
                        <button
                          className="icon-btn"
                          title="移除目录"
                          disabled={busy}
                          onClick={() => void removeRoot(root)}
                        >
                          <Icon name="x" size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {!endId && (
                <p className="hint">
                  端目录需位于主工作区，或先在「设置 → 工作区管理」中加为附加目录；一个端可以添加多个目录。
                </p>
              )}
              <div className="device-row">
                <select
                  className="mem-select device-select"
                  value={serial ?? ''}
                  disabled={online.length === 0}
                  onChange={(event) => void selectDevice(event.target.value)}
                >
                  <option value="">选择设备…</option>
                  {online.map((device) => (
                    <option key={device.serial} value={device.serial}>
                      {device.model ?? device.serial}（{device.serial}）
                    </option>
                  ))}
                </select>
                <button
                  className={`btn${mirroring ? '' : ' primary'}`}
                  disabled={!serial}
                  onClick={() => {
                    if (mirroring) {
                      setMirroring(false);
                      setShot(null);
                    } else {
                      setMirroring(true);
                    }
                  }}
                >
                  {mirroring ? '停止投屏' : '开始投屏'}
                </button>
                {devices.length === 0 && (
                  <span className="hint">没有发现设备；检查 USB 调试与 adb。</span>
                )}
              </div>
            </div>

            {mirroring && shot ? (
              <div className="device-stage">
                <img
                  className="device-mirror"
                  src={`data:image/png;base64,${shot.png}`}
                  alt="Android 设备画面"
                  style={{ cursor: clickEnabled ? 'crosshair' : 'default' }}
                  onClick={(event) => void onMirrorClick(event)}
                />
              </div>
            ) : (
              <div className="device-empty">
                <b>{mirroring ? '正在获取设备画面…' : '投屏未开始'}</b>
                <span className="hint">
                  {mirroring
                    ? '请稍候，第一帧到达后会显示在这里。'
                    : '点击「开始投屏」查看设备画面；需要时再点「停止投屏」。'}
                </span>
              </div>
            )}

            <p className="hint">
              {mirroring
                ? '投屏中，每 1.5 秒刷新；开启「允许点击操作」后，点击画面会换算成设备像素并发送 tap。'
                : '未投屏时不会请求设备画面，也不会发送 tap。'}
            </p>
          </>
        )}
        {!endId && !loading && groups.archived.length > 0 && (
          <div className="device-archived">
            <div className="section-head">
              <h3>已归档</h3>
            </div>
            {groups.archived.map((end) => (
              <div className="device-archived-row" key={end.id}>
                <span className="badge subtle">端：{end.name}</span>
                <span className="hint device-root" title={end.roots.join('\n')}>
                  {end.roots.length} 个目录
                </span>
                <span className="mem-spacer" />
                <span className="hint">已归档</span>
                <button className="btn" disabled={busy} onClick={() => void restoreEnd(end)}>
                  恢复
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void openImpact('delete', end)}
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
        {error && <p className="mem-error">{error}</p>}
        {notice && <p className="hint">{notice}</p>}
      </div>
    </div>
    {pending && (
      <div
        className="modal-scrim"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeImpact();
        }}
      >
        <div className="modal end-impact-modal" role="dialog" aria-modal="true">
          <div className="modal-head">
            <span>
              {pending.kind === 'archive'
                ? archiveConfirmLabel(pending.end.name)
                : deleteConfirmLabel(pending.end.name)}
            </span>
            <button className="btn ghost" title="关闭" onClick={closeImpact}>
              <Icon name="x" size={15} />
            </button>
          </div>
          {impactBusy && <p className="hint">正在计算影响…</p>}
          {impact && (
            <ul className="end-impact-list">
              {impactLines(impact).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <p className="hint">
            {pending.kind === 'archive'
              ? '归档后该端停止注入能力，可随时恢复；端目录、能力绑定与会话主端关联保留。'
              : '移除端会删除端目录与能力绑定，会话保留在工作区。'}
          </p>
          <div className="perm-actions">
            <button className="btn danger" disabled={busy || !impact} onClick={() => void confirmPending()}>
              {pending.kind === 'archive' ? '归档' : '移除'}
            </button>
            <button className="btn" onClick={closeImpact}>
              取消
            </button>
          </div>
        </div>
      </div>
    )}
    {rootPicker && (
      <DirectoryPickerDialog
        mode="end-root"
        workspacePaths={[]}
        busy={busy}
        error={error}
        onClose={() => setRootPicker(false)}
        onPick={(picked) => {
          setRootPicker(false);
          void addRoot(picked);
        }}
      />
    )}
    </div>
  );
}
