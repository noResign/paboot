import { useEffect, useState } from 'react';
import { useConnection } from '../../store/connection';
import { useAppearance, ZOOM_MAX, ZOOM_MIN, RAIL_MIN, RAIL_MAX, type ThemePreference } from '../../store/appearance';
import { WorkspaceSection } from '../workspaces/WorkspaceSection';
import { PreferencesSection } from './PreferencesSection';
import { SKINS } from '../../ui/skins';
import { modLabel } from '../../shortcuts/shortcuts';
import { IS_MAC } from '../../ui/platform';
import type { AppInfo, AppPrefs, ManagedDaemonStatus } from '../../../../shared/ipc';

const THEME_LABEL: Record<ThemePreference, string> = { light: '浅色', dark: '深色', system: '跟随系统' };

const SOURCE_LABEL: Record<string, string> = {
  saved: '已保存的连接',
  managed: '本应用托管',
  default: '默认数据目录',
  systemd: 'systemd 服务',
  'port-scan': '端口探测',
};

/** Who started the daemon holding `~/.paboot` — labelling only, not a permission. */
const PROVENANCE_LABEL: Record<ManagedDaemonStatus['provenance'] & string, string> = {
  app: '本应用启动',
  systemd: 'systemd 托管',
  manual: '手动启动',
};

/** 小节导航的顺序与命名沿用 `docs/local/pages/settings.md` §6.7。 */
export type SettingsSection =
  | 'connection'
  | 'daemon'
  | 'workspaces'
  | 'preferences'
  | 'notifications'
  | 'appearance'
  | 'about';

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'connection', label: '连接' },
  { id: 'daemon', label: '本机 daemon' },
  { id: 'workspaces', label: '工作区' },
  { id: 'preferences', label: '默认偏好' },
  { id: 'notifications', label: '通知' },
  { id: 'appearance', label: '外观' },
  { id: 'about', label: '关于' },
];

/**
 * Desktop settings is 左栏小节导航 + 右栏内容, not one long column (§6.7) —
 * the phone uses tabs; a desktop page has the height for a section rail.
 */
export function SettingsPage({
  onBack,
  section,
  onSectionChange,
}: {
  onBack(): void;
  section: SettingsSection;
  onSectionChange(next: SettingsSection): void;
}) {
  const view = useConnection((state) => state.views.find((item) => item.id === state.activeId) ?? null);
  const probe = useConnection((state) => state.probe);
  const probing = useConnection((state) => state.probing);
  const probeNow = useConnection((state) => state.probeNow);
  const refreshViews = useConnection((state) => state.refreshViews);
  const disconnectAll = useConnection((state) => state.disconnectAll);

  const theme = useAppearance((state) => state.theme);
  const skin = useAppearance((state) => state.skin);
  const zoom = useAppearance((state) => state.zoom);
  const railWidth = useAppearance((state) => state.railWidth);
  const setTheme = useAppearance((state) => state.setTheme);
  const setSkin = useAppearance((state) => state.setSkin);
  const setZoom = useAppearance((state) => state.setZoom);
  const setRailWidth = useAppearance((state) => state.setRailWidth);

  const [info, setInfo] = useState<AppInfo | null>(null);
  const [prefs, setPrefs] = useState<AppPrefs | null>(null);
  const [daemon, setDaemon] = useState<ManagedDaemonStatus | null>(null);
  const [daemonLogs, setDaemonLogs] = useState<string[]>([]);
  const [daemonBusy, setDaemonBusy] = useState(false);
  /** Why the last start/stop attempt failed — a dead-looking button otherwise. */
  const [daemonError, setDaemonError] = useState<string | null>(null);
  /** Working directory for「启动」— becomes the daemon's default workspace. */
  const [startDir, setStartDir] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenConfirm, setTokenConfirm] = useState(false);
  const [tokenResult, setTokenResult] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  useEffect(() => {
    void window.paboot.appInfo().then(setInfo);
    void window.paboot.prefsGet().then(setPrefs);
  }, []);

  async function updatePrefs(patch: Partial<AppPrefs>): Promise<void> {
    setPrefs(await window.paboot.prefsSet(patch));
  }

  async function refreshManaged(): Promise<void> {
    setDaemon(await window.paboot.daemonStatus());
    setDaemonLogs(await window.paboot.daemonLogs(200));
    // Starting/stopping the local daemon flips our own connection with it, so the
    // shell has to re-read whether it still has a host to show.
    void refreshViews();
  }

  // Only while this section is on screen — the log tail is not worth polling
  // from a page the user is not looking at.
  useEffect(() => {
    if (section === 'daemon') void refreshManaged();
  }, [section]);

  async function stopManaged(): Promise<void> {
    setDaemonBusy(true);
    setDaemonError(null);
    const res = await window.paboot.daemonStop();
    setDaemonBusy(false);
    if (!res.ok) setDaemonError(res.message);
    await refreshManaged();
  }

  /**
   * Start a daemon of our own from here — same as the connect page's flow, and
   * deliberately not `systemctl start`: one the app starts is the app's, so it is
   * fully manageable (restart, 改 token) afterwards.
   */
  async function startManaged(): Promise<void> {
    setDaemonBusy(true);
    setDaemonError(null);
    const res = await window.paboot.daemonStart({ workspace: startDir.trim(), port: 0 });
    setDaemonBusy(false);
    if (!res.ok) setDaemonError(res.message);
    await refreshManaged();
  }

  /**
   * Replace the managed daemon's token. When the daemon is running this restarts
   * it, so the first click only warns about the disruption and the second commits.
   */
  async function changeToken(): Promise<void> {
    // Only warn about the disruption when we will actually restart it.
    if (daemon?.running && daemon.restartable && !tokenConfirm) {
      setTokenConfirm(true);
      return;
    }
    setTokenBusy(true);
    setTokenConfirm(false);
    setTokenError(null);
    const res = await window.paboot.daemonSetToken(tokenInput.trim() || undefined);
    setTokenBusy(false);
    if (!res.ok) {
      setTokenError(res.message);
      return;
    }
    setTokenResult(res.token);
    setTokenInput('');
    await refreshManaged();
  }

  const found = probe?.found ?? null;

  return (
    <div className="settings">
      <div className="settings-head">
        <button className="btn ghost" onClick={onBack} title="返回（Esc）">
          ← 返回
        </button>
        <span className="title">设置</span>
      </div>

      <div className="settings-split">
        <nav className="snav">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              className={`snav-item${item.id === section ? ' active' : ''}`}
              onClick={() => onSectionChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="pane">
          <div className="scard">
            {section === 'connection' && (
              <section className="settings-section">
                <h3>连接</h3>
                <dl className="kv">
                  <dt>服务器</dt>
                  <dd className="mono">{view?.baseUrl ?? '未连接'}</dd>
                  <dt>名称</dt>
                  <dd>{view?.name ?? '—'}</dd>
                  <dt>Token</dt>
                  <dd>
                    {view?.hasToken ? '已持有' : '无'}
                    {view?.tokenSource && ` · 来自 ${view.tokenSource}`}
                    {view?.tokenEphemeral && ' · 仅本次会话（系统无 keyring，不会记住）'}
                  </dd>
                </dl>
                <div className="settings-actions">
                  <button className="btn" disabled={probing} onClick={() => void probeNow()}>
                    {probing ? '探测中…' : '重新探测本机 daemon'}
                  </button>
                  <button className="btn danger" onClick={() => void disconnectAll()}>
                    断开全部连接
                  </button>
                </div>
              </section>
            )}

            {section === 'daemon' && (
              <section className="settings-section">
                <h3>本机 daemon</h3>
                {found ? (
                  <>
                    <dl className="kv">
                      <dt>状态</dt>
                      <dd>● 运行中 · v{found.version}</dd>
                      <dt>PID</dt>
                      <dd className="mono">{daemon?.pid ?? '—'}</dd>
                      <dt>归属</dt>
                      <dd>{daemon?.provenance ? PROVENANCE_LABEL[daemon.provenance] : '—'}</dd>
                      <dt>局域网地址</dt>
                      <dd className="mono">
                        {/* The dial address is always loopback — useless to the phone, so
                            it is never shown. What matters is whether the LAN can reach it. */}
                        {!daemon
                          ? '—'
                          : daemon.lanAddresses.length
                            ? daemon.lanAddresses.join('　')
                            : daemon.bindHost === null
                              ? '未知（这台 daemon 没报告绑定地址）'
                              : '仅本机（未开放给局域网）'}
                      </dd>
                      <dt>主机</dt>
                      <dd>{found.hostname ?? '—'}</dd>
                      <dt>数据目录</dt>
                      <dd className="mono">{found.dataDir ?? '—'}</dd>
                      <dt>token 来源</dt>
                      <dd>{found.tokenSource ?? '未知'}</dd>
                      <dt>发现方式</dt>
                      <dd>{SOURCE_LABEL[found.source] ?? found.source}</dd>
                    </dl>
                  </>
                ) : (
                  <div className="hint" style={{ marginTop: 0 }}>
                    候选表里没有找到本机 daemon（不代表它没在跑）。已试过：
                    <ul className="tried mono">
                      {(probe?.tried ?? []).map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="hint">
                  本机只有一台 daemon（数据目录固定，由它自己的锁保证独占），所以不论谁启动的，
                  都能在下面停止/重启。
                  {daemon?.provenance === 'systemd' &&
                    ' 它由 systemd 托管，启停会走 systemctl --user，停止后要重新起来得用 systemctl --user start paboot。'}
                </div>
              </section>
            )}

            {section === 'daemon' && (
              <section className="settings-section">
                <div className="section-head">
                  <h3>本机 daemon 的启停</h3>
                  <button className="btn tiny" onClick={() => void refreshManaged()}>
                    刷新
                  </button>
                  {daemon?.running && (
                    <button className="btn tiny danger" disabled={daemonBusy} onClick={() => void stopManaged()}>
                      {daemonBusy ? '停止中…' : '停止'}
                    </button>
                  )}
                </div>
                <dl className="kv">
                  <dt>状态</dt>
                  <dd>
                    {daemon?.running
                      ? `● 运行中（pid ${daemon.pid ?? '?'}）${
                          daemon.provenance ? ` · ${PROVENANCE_LABEL[daemon.provenance]}` : ''
                        }`
                      : '○ 未运行'}
                    {daemonError && <div className="error-text">{daemonError}</div>}
                  </dd>
                  <dt>日志</dt>
                  <dd className="mono">{daemon?.logPath ?? '—'}</dd>
                </dl>
                <div className="field">
                  <label htmlFor="daemon-token">访问 token</label>
                  <input
                    id="daemon-token"
                    className="mono"
                    placeholder="留空 = 随机生成；也可粘贴自定义值"
                    value={tokenInput}
                    onChange={(event) => {
                      setTokenInput(event.target.value);
                      setTokenConfirm(false);
                    }}
                    autoComplete="off"
                  />
                  <div className="settings-actions">
                    <button className="btn primary" disabled={tokenBusy} onClick={() => void changeToken()}>
                      {tokenBusy
                        ? '处理中…'
                        : tokenConfirm
                          ? '确认：会重启 daemon、断开手机'
                          : daemon?.running && daemon.restartable
                            ? '保存并重启'
                            : '保存'}
                    </button>
                  </div>
                  {tokenError && <div className="error-text">{tokenError}</div>}
                  {tokenResult && (
                    <div className="hint">
                      新 token：<span className="mono">{tokenResult}</span>
                      <br />
                      手机与其它连接已失效，请用这个 token 重新连接。
                    </div>
                  )}
                  <div className="hint">
                    daemon 只在启动时读 token，所以保存后会重启它——<b>正在跑的任务会被中断</b>。
                    改 token 等于换掉远程 shell 的钥匙。
                    {daemon?.provenance === 'systemd' ? '这台由 systemd 托管，重启会走 systemctl --user。' : ''}
                    {daemon && !daemon.restartable
                      ? '这台本应用没法替你重启（不是它启动的，或已经不知道它当初的启动命令），所以只写文件——需要你手动重启，新 token 才生效。'
                      : ''}
                  </div>
                </div>
                {!daemon?.running && (
                  <div className="field">
                    <label htmlFor="daemon-workspace">工作目录（启动时用）</label>
                    <input
                      id="daemon-workspace"
                      className="mono"
                      placeholder="~/Projects"
                      value={startDir}
                      onChange={(event) => setStartDir(event.target.value)}
                      autoComplete="off"
                    />
                    <div className="settings-actions">
                      <button className="btn primary" disabled={daemonBusy} onClick={() => void startManaged()}>
                        {daemonBusy ? '启动中…' : '启动'}
                      </button>
                    </div>
                    <div className="hint">
                      这个目录会成为<b>默认工作区</b>（之后不可删除），agent 的写入被限制在它里面；支持
                      <span className="mono"> ~</span>，目录不存在会自动创建。端口在 4780–4789 里自动挑空闲的，
                      绑 <span className="mono">127.0.0.1</span>；要开放给手机请到<b>连接页</b>启动。
                      {daemon?.systemd &&
                        ' 这台机器装了 systemd 单元 paboot.service——从这里启动的归本应用管（可重启/改 token），不会去动那个单元。'}
                    </div>
                  </div>
                )}
                <div className="field">
                  <label>退出应用时，本机 daemon</label>
                  <div className="mode-picker">
                    {(
                      [
                        { value: 'ask', title: '每次询问', desc: '退出时弹一次确认' },
                        { value: 'stop', title: '一并停止', desc: '不留后台进程（含 systemd 托管的）' },
                        { value: 'keep', title: '保留', desc: '手机与其它电脑仍可连接' },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.value}
                        className={`mode-option${option.value === prefs?.daemonOnQuit ? ' active' : ''}`}
                        disabled={!prefs}
                        onClick={() => void updatePrefs({ daemonOnQuit: option.value })}
                      >
                        <b>{option.title}</b>
                        <span>{option.desc}</span>
                      </button>
                    ))}
                  </div>
                  <div className="hint">
                    只管<b>本应用启动的</b> daemon；附着来的（systemd、手动起的）一律不碰。
                  </div>
                </div>
                {daemonLogs.length > 0 && (
                  <pre className="fcode daemon-log" title="最近 200 行">
                    {daemonLogs.slice(-40).join('\n')}
                  </pre>
                )}
              </section>
            )}

            {section === 'workspaces' && <WorkspaceSection />}

            {section === 'preferences' && <PreferencesSection />}

            {section === 'notifications' && (
              <section className="settings-section">
                <h3>通知</h3>
                <div className="field">
                  <label>桌面通知</label>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={prefs?.desktopNotifications ?? true}
                      disabled={!prefs}
                      onChange={(event) => void updatePrefs({ desktopNotifications: event.target.checked })}
                    />
                    <span>
                      任务需要审批、或运行结束时弹系统通知（仅当你没在看那个会话时）。
                      审批已决会撤掉对应通知；通知不带「允许/拒绝」按钮，点一下进入会话。
                    </span>
                  </label>
                </div>
                <div className="field">
                  <label>关闭窗口时</label>
                  <div className="mode-picker">
                    {(
                      [
                        { value: 'tray', title: '最小化到托盘', desc: '应用继续常驻，任务照跑，通知还能弹' },
                        { value: 'quit', title: '退出应用', desc: '窗口关掉即退出（任务在 daemon 上，不受影响）' },
                        { value: 'ask', title: '每次询问', desc: '关闭时弹一次选择，可勾选记住' },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.value}
                        className={`mode-option${option.value === prefs?.closeBehavior ? ' active' : ''}`}
                        disabled={!prefs}
                        onClick={() => void updatePrefs({ closeBehavior: option.value })}
                      >
                        <b>{option.title}</b>
                        <span>{option.desc}</span>
                      </button>
                    ))}
                  </div>
                  <div className="hint">
                    「关闭窗口」不等于「退出应用」：任务在 daemon 上执行，关掉窗口不会中断它们。
                  </div>
                </div>
              </section>
            )}

            {section === 'appearance' && (
              <section className="settings-section">
                <h3>外观</h3>
                <div className="field">
                  <label>主题</label>
                  <div className="mode-picker">
                    {(['light', 'dark', 'system'] as ThemePreference[]).map((option) => (
                      <button
                        key={option}
                        className={`mode-option${option === theme ? ' active' : ''}`}
                        onClick={() => setTheme(option)}
                      >
                        <b>{THEME_LABEL[option]}</b>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label>皮肤</label>
                  <div className="mode-picker">
                    {SKINS.map((option) => (
                      <button
                        key={option.id}
                        className={`mode-option${option.id === skin ? ' active' : ''}`}
                        onClick={() => setSkin(option.id)}
                      >
                        <b>{option.label}</b>
                      </button>
                    ))}
                  </div>
                  <div className="hint">
                    皮肤在光/暗之外再叠一层动效（背景、鼠标波纹）。系统开启「减少动态效果」时会自动关闭，
                    窗口切到后台也会暂停。
                  </div>
                </div>
                <div className="field">
                  <label>界面缩放（{zoom}%，{modLabel(IS_MAC)}+/−/0）</label>
                  <input
                    type="range"
                    min={ZOOM_MIN}
                    max={ZOOM_MAX}
                    step={5}
                    value={zoom}
                    onChange={(event) => setZoom(Number(event.target.value))}
                  />
                </div>
                <div className="field">
                  <label>左栏宽度（{railWidth}px）</label>
                  <input
                    type="range"
                    min={RAIL_MIN}
                    max={RAIL_MAX}
                    step={10}
                    value={railWidth}
                    onChange={(event) => setRailWidth(Number(event.target.value))}
                  />
                </div>
                <div className="hint">这些偏好存在本机（localStorage），不随会话走。</div>
              </section>
            )}

            {section === 'about' && (
              <section className="settings-section">
                <h3>关于</h3>
                <dl className="kv">
                  <dt>paboot Desktop</dt>
                  <dd>{info?.appVersion ?? '—'}</dd>
                  <dt>daemon</dt>
                  <dd>
                    v{found?.version ?? '—'}
                    <span className="hint">（来自 /api/health）</span>
                  </dd>
                  <dt>Electron</dt>
                  <dd>{info?.electron ?? '—'}</dd>
                  <dt>Chromium</dt>
                  <dd>{info?.chrome ?? '—'}</dd>
                  <dt>Node</dt>
                  <dd>{info?.node ?? '—'}</dd>
                </dl>
                <div className="hint">
                  桌面端不做客户端更新，升级请手动下载安装包重装。
                  <br />
                  退出应用时的 daemon 去留确认要等 M4——只有本应用 spawn 的 daemon 才需要问，
                  而当前只做附着，附着的 daemon 不问也不停。
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
