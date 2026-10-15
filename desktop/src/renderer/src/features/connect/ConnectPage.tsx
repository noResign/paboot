import { useEffect, useState } from 'react';
import { connectionApi } from '../../ipc/client';
import { useConnection } from '../../store/connection';
import { isInsecure } from '../../../../shared/net';
import { parseAddress } from './address';
import { BrandMark } from '../../ui/BrandMark';
import type {
  DiscoveredDaemon,
  LocalTokenHint,
  PortConflict,
  RecentConnection,
} from '../../../../shared/ipc';

/** Connection gate. Discovery of a same-machine daemon is the primary path. */
export function ConnectPage() {
  const view = useConnection((s) => s.views.find((item) => item.id === s.activeId) ?? null);
  const probe = useConnection((s) => s.probe);
  const probing = useConnection((s) => s.probing);
  const connecting = useConnection((s) => s.connecting);
  const error = useConnection((s) => s.error);
  const errorCode = useConnection((s) => s.errorCode);
  const connect = useConnection((s) => s.connect);
  const disconnectAll = useConnection((s) => s.disconnectAll);
  const probeNow = useConnection((s) => s.probeNow);
  const views = useConnection((s) => s.views);
  const returnToId = useConnection((s) => s.returnToId);
  const cancelAddHost = useConnection((s) => s.cancelAddHost);

  const [address, setAddress] = useState('');
  // Starting a daemon is a deliberate, multi-step act: a directory that becomes
  // the agent's writable root, and whether to open it to the phone.
  const [spawnOpen, setSpawnOpen] = useState(false);
  /** A systemd unit owns the daemon's config, so the form has nothing to ask. */
  const [spawnSystemd, setSpawnSystemd] = useState(false);
  const [spawnDir, setSpawnDir] = useState('');
  const [spawnPhone, setSpawnPhone] = useState(false);
  const [spawnBusy, setSpawnBusy] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [spawnLogPath, setSpawnLogPath] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [recent, setRecent] = useState<RecentConnection[]>([]);

  // Discovery is a snapshot taken once, at boot (`App` calls `boot()`). It knows
  // nothing about a daemon started or stopped afterwards — including one this
  // page launched itself. Re-probe on every mount so the「本机 daemon」block shows
  // live state instead of a stale「没找到」while a daemon is in fact running.
  useEffect(() => {
    void probeNow();
  }, [probeNow]);

  // Addresses only, and this page is remounted on every disconnect, so the list
  // is always current without a subscription.
  useEffect(() => {
    void connectionApi.recent().then(setRecent);
  }, []);

  // Whether「启动」would go through systemd rather than spawn a daemon of ours:
  // the unit owns workspace/port then, so the form changes shape (and its values
  // are ignored). Only asked when the form is actually opened.
  useEffect(() => {
    if (!spawnOpen) return;
    let live = true;
    void window.paboot.daemonStatus().then((status) => {
      if (live) setSpawnSystemd(status.systemd);
    });
    return () => {
      live = false;
    };
  }, [spawnOpen]);

  // A restored connection whose token could not be recovered still knows where
  // it was pointing, and a disconnected one still has its recent targets. The
  // address is never the part worth making the user retype — the token is.
  useEffect(() => {
    const known = view?.baseUrl ?? recent[0]?.baseUrl ?? null;
    if (known) setAddress((current) => current || known);
  }, [view?.baseUrl, recent]);

  // A local daemon whose token lives in an env var can't be auto-read; hand the
  // user the address and ask for the token instead of failing generically.
  useEffect(() => {
    if (errorCode === 'token_required' && probe?.found) {
      setAddress(probe.found.listen);
    }
  }, [errorCode, probe]);

  const found = probe?.found ?? null;
  const conflict = probe?.portConflict ?? null;

  /**
   * Start a daemon this app owns and connect to it. The token comes back from
   * main, so nothing has to be typed or re-read from disk.
   */
  async function spawnLocal(): Promise<void> {
    const workspace = spawnDir.trim();
    // With a systemd unit installed, main starts the unit and the unit owns the
    // workspace/port — the form's values are not used, so they must not block.
    if (!workspace && !spawnSystemd) {
      setSpawnError('请填写工作目录');
      return;
    }
    setSpawnBusy(true);
    setSpawnError(null);
    // `port: 0` = pick the first free one in the daemon's usual range: the user
    // very often already has something on 4780.
    const res = await window.paboot.daemonStart({
      workspace,
      port: 0,
      host: spawnPhone ? '0.0.0.0' : '127.0.0.1',
    });
    setSpawnBusy(false);
    if (!res.ok) {
      setSpawnError(res.message);
      // "It didn't start" is always diagnosable — point at the log rather than
      // making the user guess.
      const status = await window.paboot.daemonStatus();
      setSpawnLogPath(status.logPath);
      return;
    }
    setSpawnOpen(false);
    // The daemon we just started has to be discoverable the next time this page
    // mounts — the boot snapshot predates it.
    void probeNow();
    // Connect to the port it actually bound, not the one we asked for.
    const bound = res.listen ? parseAddress(res.listen) : null;
    if (!bound) {
      setSpawnError(`daemon 起来了但没报告地址（${res.listen ?? '未知'}）`);
      return;
    }
    await connect({ ...bound, token: res.token, name: '本机 daemon（本应用启动）' });
  }

  async function connectRemote(): Promise<void> {
    const parsed = parseAddress(address);
    if (!parsed) return;
    await connect({ ...parsed, token: token.trim() || undefined });
  }

  /**
   * One click on the local daemon: connect straight away. Its token lives in
   * `<data-dir>/token`, and main auto-reads it for a target that matches a fresh
   * probe — so a daemon on this machine never asks the user to retype one. If it
   * still does (an env-provided token, say), the address stays in the form above
   * for pasting.
   */
  async function connectLocal(daemon: DiscoveredDaemon): Promise<void> {
    const parsed = parseAddress(daemon.listen);
    if (!parsed) return;
    setAddress(daemon.listen);
    setToken('');
    await connect({ ...parsed, tls: daemon.tls, name: daemon.hostname ?? undefined });
  }

  const parsedAddress = parseAddress(address);
  const insecureWarning = parsedAddress ? isInsecure(parsedAddress.host, parsedAddress.tls) : false;
  //「添加电脑」can be backed out of: the host it was opened from is still live.
  const returnView = views.find((item) => item.id === returnToId && item.connected) ?? null;

  return (
    <div className="gate">
      <div className="gate-card">
        {returnView && (
          <button className="btn ghost" style={{ marginBottom: 12 }} onClick={cancelAddHost} title="返回上一台主机">
            ← 返回 {returnView.name ?? returnView.baseUrl ?? '上一台主机'}
          </button>
        )}
        <div className="gate-brand">
          <BrandMark />
          paboot
        </div>
        <div className="gate-slogan">一个客户端，操纵你所有的 agent</div>

        <div className="section-label" style={{ textAlign: 'center' }}>
          ── 连接 daemon ──
        </div>

        {/* A real form so Enter submits: filling the address and reaching for the
            mouse every time is a pointless interruption. */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!connecting && parsedAddress) void connectRemote();
          }}
        >
        <div className="field">
          <label htmlFor="addr">服务器地址</label>
          <input
            id="addr"
            className="mono"
            placeholder="192.168.1.9:4780"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoComplete="off"
          />
        </div>
        {recent.length > 0 && (
          <div className="section-label recent-label">最近连接</div>
        )}
        {recent.length > 0 && (
          <div className="recent">
            {recent.map((entry) => (
              <button
                key={entry.baseUrl}
                type="button"
                className="recent-item"
                title={entry.baseUrl}
                onClick={() => setAddress(entry.baseUrl)}
              >
                <span className="recent-name">{entry.name ?? entry.baseUrl}</span>
                {entry.name && <span className="recent-url mono">{entry.baseUrl}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="field">
          <label htmlFor="token">Token</label>
          <input
            id="token"
            type="password"
            className="mono"
            placeholder="粘贴 daemon 的访问 token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </div>

        <button type="submit" className="btn primary full" disabled={connecting || !parsedAddress}>
          {connecting ? '连接中…' : '连接'}
        </button>
        </form>

        <div className="section-label">本机 daemon</div>
        <LocalDaemonBlock
          probing={probing}
          found={found}
          conflict={conflict}
          tried={probe?.tried ?? []}
          tokenHint={probe?.localToken ?? null}
          onPick={(daemon) => void connectLocal(daemon)}
          onChooseLocal={() => setAddress(`127.0.0.1:${4780}`)}
          onStart={() => setSpawnOpen(true)}
        />

        {spawnOpen && (
          <div className="local-block" style={{ marginTop: 10 }}>
            <div className="local-title">
              {spawnSystemd ? '启动 systemd 托管的 daemon' : '启动一个本机 daemon'}
            </div>
            {spawnSystemd ? (
              <div className="hint" style={{ marginTop: 0 }}>
                这台机器上装了 systemd 单元 <span className="mono">paboot.service</span>，
                「启动」会执行 <span className="mono">systemctl --user start paboot</span>。
                工作目录、端口、是否开放给手机都由<b>那个单元</b>决定，下面不适用；要改请编辑单元后
                <span className="mono"> systemctl --user daemon-reload</span>。
              </div>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="spawn-dir">工作目录</label>
                  <input
                    id="spawn-dir"
                    className="mono"
                    placeholder="~/Projects"
                    value={spawnDir}
                    onChange={(event) => setSpawnDir(event.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="hint" style={{ marginTop: 0 }}>
                  这个目录会成为<b>默认工作区</b>，且<b>之后不可删除</b>；agent 的写入被限制在它里面。
                  路径支持 <span className="mono">~</span>（展开成运行 daemon 的用户主目录），目录不存在会自动创建。
                  数据与 token 存在 <span className="mono">~/.paboot</span>，和你手动启动的 daemon 是同一份
                  ——手机连任意一个，看到的会话与工作区都一样。
                  端口会自动在 <span className="mono">4780–4789</span> 里挑第一个空闲的。
                </div>
                <label className="switch" style={{ marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={spawnPhone}
                    onChange={(event) => setSpawnPhone(event.target.checked)}
                  />
                  <span>开放给手机（绑 0.0.0.0，同一局域网可连）—— 不勾就只绑本机回环</span>
                </label>
              </>
            )}
            {spawnError && (
              <div className="error-text">
                {spawnError}
                {spawnLogPath && (
                  <>
                    <br />
                    日志：<span className="mono">{spawnLogPath}</span>
                  </>
                )}
              </div>
            )}
            <div className="settings-actions">
              <button className="btn primary" disabled={spawnBusy} onClick={() => void spawnLocal()}>
                {spawnBusy ? '启动中…' : '启动并连接'}
              </button>
              <button className="btn" onClick={() => setSpawnOpen(false)}>
                取消
              </button>
            </div>
          </div>
        )}

        {!probing && !found && (
          <div className="hint" style={{ marginTop: 8 }}>
            本机没有 daemon 只影响「在这台电脑上跑 agent」。连别的电脑上的 daemon 用上面的地址直接连，
            <b>不需要本机也起一个</b>。
          </div>
        )}

        {insecureWarning && (
          <div className="error-text">
            ⚠️ 该地址不是本机且使用明文 HTTP——token 会在网络中明文传输，而这个 token
            等同于那台电脑上的远程 shell 权限。
          </div>
        )}
        {error && !insecureWarning && <div className="error-text">{error}</div>}
        {errorCode === 'token_required' && (
          <div className="hint">
            这个 daemon 的 token 来自环境变量或启动参数，客户端读不到，请手动粘贴。
          </div>
        )}

        <div className="hint">
          安全提示：不要把这个端口暴露到公网。从客户端驱动一个带 shell 权限的 agent
          等同于远程代码执行。
        </div>

        {view?.connected && (
          <button className="btn full" style={{ marginTop: 12 }} onClick={() => void disconnectAll()}>
            当前已连接 {view.name ?? view.baseUrl}，断开重连
          </button>
        )}
      </div>
    </div>
  );
}

interface LocalBlockProps {
  probing: boolean;
  found: DiscoveredDaemon | null;
  conflict: PortConflict | null;
  tried: string[];
  tokenHint: LocalTokenHint | null;
  /** Click the found daemon: connect to it right away (no token to type). */
  onPick(found: DiscoveredDaemon): void;
  onChooseLocal(): void;
  onStart(): void;
}

function LocalDaemonBlock(props: LocalBlockProps) {
  const { probing, found, conflict, tried, tokenHint, onPick, onChooseLocal, onStart } = props;

  if (probing && !found) {
    return (
      <div className="local-block">
        <div className="local-title">
          <span className="dot" /> 正在查找本机 daemon…
        </div>
      </div>
    );
  }

  if (found) {
    return (
      <button className="local-block found local-pick" onClick={() => onPick(found)} title="直接连接这台 daemon">
        <div className="local-title">
          <span className="dot ok" /> 本机 daemon · v{found.version}
        </div>
        <div className="local-meta mono">
          {found.listen}
          {found.workspace ? ` · ${found.workspace}` : ''}
        </div>
        <div className="local-meta">
          来源：{SOURCE_LABEL[found.source]}
          {found.source !== 'managed' && '（本应用没启动它——但它是本机唯一那台，仍可在设置页停/启）'}
        </div>
        {tokenHint && <div className="hint">已从 {tokenHint.source} 读到 token，点一下就能连上</div>}
        <div className="hint">点这里直接连接本机 daemon，不用再输 token</div>
      </button>
    );
  }

  return (
    <div className="local-block">
      <div className="local-title">
        <span className="dot warn" /> 没找到本机 daemon
      </div>
      <div className="local-meta">
        探测不出来只说明候选表里没有——不代表它没在跑。已试过：
      </div>
      <ul className="tried mono">
        {tried.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      {conflict && (
        <div className="local-meta" style={{ color: 'var(--warning)' }}>
          ⚠️ 端口 {conflict.port} 有响应但不是 paboot（HTTP {conflict.status ?? '—'}）。
        </div>
      )}
      <div className="choices">
        <button className="choice" onClick={onChooseLocal}>
          它跑在别的地址 → 填地址连接
        </button>
        <button className="choice" onClick={onStart}>
            确实没在跑 → 启动一个本机 daemon
          </button>
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  saved: '已保存的连接',
  managed: '本应用托管',
  default: '默认数据目录',
  systemd: 'systemd 服务',
  'port-scan': '端口探测',
};
