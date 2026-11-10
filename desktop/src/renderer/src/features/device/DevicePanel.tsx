import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { api } from '../../ipc/client';
import type { CapabilityDeviceDto, EndDto, EndSuggestionDto } from '../../../../shared/contract';
import { Icon } from '../../ui/Icon';

interface Props {
  workspaceId: string;
  workspaceName: string;
  onClose(): void;
}

interface Shot {
  png: string;
  width: number;
  height: number;
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

export function DevicePanel({ workspaceId, workspaceName, onClose }: Props) {
  const [ends, setEnds] = useState<EndDto[]>([]);
  const [suggestions, setSuggestions] = useState<EndSuggestionDto[]>([]);
  const [activeEnd, setActiveEnd] = useState<EndDto | null>(null);
  const [devices, setDevices] = useState<CapabilityDeviceDto[]>([]);
  const [serial, setSerial] = useState<string | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [clickEnabled, setClickEnabled] = useState(false);
  const [mirroring, setMirroring] = useState(false);
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
    const active = res.data.ends.find((end) => end.status === 'active') ?? null;
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
  }, [workspaceId]);

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
              在工作区里找到 Android 工程后添加；端只用于设备能力，不改变会话目录。
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
            {ends.length > 0 && <p className="hint">已有 {ends.length} 个端，但都未激活。</p>}
          </>
        ) : (
          <>
            <div className="device-toolbar">
              <div className="device-row">
                <span className="badge subtle">端：{activeEnd.name}</span>
                <span className="hint device-root" title={activeEnd.roots[0]}>
                  {activeEnd.roots.length > 0 ? activeEnd.roots[0] : '未绑定目录'}
                </span>
                <span className="mem-spacer" />
                <label>
                  <input
                    type="checkbox"
                    checked={clickEnabled}
                    onChange={(event) => setClickEnabled(event.target.checked)}
                  />
                  允许点击操作
                </label>
              </div>
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
        {error && <p className="mem-error">{error}</p>}
        {notice && <p className="hint">{notice}</p>}
      </div>
    </div>
    </div>
  );
}
