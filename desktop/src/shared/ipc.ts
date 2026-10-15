/**
 * The IPC surface between main and renderer. Deliberately tiny: one generic
 * daemon proxy plus a handful of connection/supervisor channels — not one
 * channel per endpoint. Type safety lives in renderer/src/ipc/client.ts.
 */
import type { SseFrame } from './contract';

export const IPC = {
  boot: 'app:boot',
  request: 'daemon:request',
  connGet: 'daemon:conn:get',
  connList: 'daemon:conn:list',
  connRemove: 'daemon:conn:remove',
  connSet: 'daemon:conn:set',
  connClear: 'daemon:conn:clear',
  connProbe: 'daemon:conn:probe',
  recentList: 'app:recent:list',
  appInfo: 'app:info',
  prefsGet: 'app:prefs:get',
  prefsSet: 'app:prefs:set',
  trayState: 'app:tray:state',
  notify: 'app:notify',
  notifyClose: 'app:notify:close',
  selectSession: 'app:select-session',
  setActiveSession: 'app:set-active-session',
  toggleDevTools: 'app:toggle-devtools',
  daemonStatus: 'daemon:status',
  daemonStart: 'daemon:start',
  daemonStop: 'daemon:stop',
  daemonLogs: 'daemon:logs',
  daemonSetToken: 'daemon:set-token',
  openSessionWindow: 'app:open-session-window',
  focusSession: 'app:focus-session',
  streamStart: 'stream:start',
  streamCancel: 'stream:cancel',
  streamEvent: 'stream:event',
} as const;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A request the renderer asks main to replay against the daemon. */
export interface DaemonRequest {
  method: HttpMethod;
  /**
   * Which daemon to talk to. Main keeps several connections alive (§4), so a
   * request without one is ambiguous — the renderer always fills it in from the
   * connection it is currently scoped to.
   */
  connectionId: string;
  /** Must be a relative `/api/...` path; main rejects anything else. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

export interface DaemonResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
}

/** Where a discovered daemon came from, in candidate-table priority order. */
export type DaemonSource = 'saved' | 'managed' | 'default' | 'systemd' | 'port-scan';

export interface DiscoveredDaemon {
  source: DaemonSource;
  /** Connectable `host:port` — a wildcard bind is already collapsed to loopback. */
  listen: string;
  tls: boolean;
  version: string;
  workspace: string | null;
  serverId: string | null;
  dataDir: string | null;
  hostname: string | null;
  /** Only `'file'` permits auto-reading `<dataDir>/token`. */
  tokenSource: 'env' | 'flag' | 'file' | null;
}

export interface PortConflict {
  port: number;
  status: number | null;
  body: string;
}

export interface ProbeResult {
  found: DiscoveredDaemon | null;
  /** Human-readable record of what was tried, shown in the empty state. */
  tried: string[];
  /** A port answered but was not paboot. */
  portConflict: PortConflict | null;
  /**
   * Where the token *could* be read from, so the UI can say "read the token
   * from <source>" instead of silently filling it in. Main reads it only after
   * an explicit connect to the matching coordinate.
   */
  localToken: LocalTokenHint | null;
}

export interface LocalTokenHint {
  path: string;
  /** `token-file` → `<dataDir>/token`; `env-file` → an `PABOOT_TOKEN=` line. */
  kind: 'token-file' | 'env-file';
  /** Human-readable provenance, e.g. `~/.config/paboot.env`. */
  source: string;
}

export interface ConnectionView {
  /** `http(s)://host:port` — also the key every renderer store is scoped by. */
  id: string;
  baseUrl: string | null;
  /**
   * The daemon's own identity (`GET /api/health` → `serverId`), learned once a
   * connection or probe has reached it. Null until then — and null forever
   * against a daemon too old to send it.
   *
   * This is the *host* level of the id chain (host → workspace → session → run).
   * It is what distinguishes two addresses of one daemon from two daemons, so it
   * is kept alongside the address today while the address is still the key.
   */
  serverId: string | null;
  /**
   * A usable client exists. Deliberately separate from `baseUrl`: a restored
   * loopback target has an address but no token (loopback tokens are never
   * persisted), and showing the app shell in that state means every request
   * fails with "not connected" instead of asking for the token.
   */
  connected: boolean;
  name: string | null;
  host: string | null;
  port: number | null;
  tls: boolean;
  hasToken: boolean;
  /** Token held only in memory (safeStorage unavailable) — not remembered. */
  tokenEphemeral: boolean;
  /** Where the token came from when it was auto-read, so the UI can say so. */
  tokenSource: string | null;
  /** Why this host is not usable, when it isn't — shown in the switcher. */
  error?: string | null;
}

export interface ConnectInput {
  host: string;
  port: number;
  tls?: boolean;
  name?: string;
  /**
   * Omit to let main supply the token: it will read `<dataDir>/token` only when
   * the target matches a freshly discovered daemon with `tokenSource === 'file'`.
   * This keeps "read an arbitrary file" out of the renderer's reach.
   */
  token?: string;
}

export type ConnectResult =
  | { ok: true; view: ConnectionView }
  | { ok: false; code: string; message: string };

/**
 * The local daemon — whatever holds `~/.paboot`, which the fixed data dir and the
 * daemon's own lock guarantee is at most one. Starting and stopping are open to
 * it whoever started it; `provenance` only decides labelling and the quit default.
 */
export interface ManagedDaemonStatus {
  running: boolean;
  /** pid of the running daemon, whoever started it; null when nothing is up. */
  pid: number | null;
  /** Who started it: us (this run or an earlier one), systemd, or by hand. */
  provenance: 'app' | 'systemd' | 'manual' | null;
  /** A systemd unit is installed, so「启动」goes through `systemctl` and owns its own config. */
  systemd: boolean;
  /**
   * This app can bring the daemon back after stopping it: it owns the unit, or it
   * knows the command it was launched with. False for one an earlier app run left
   * behind — then 「改 token」 writes the file without restarting it rather than
   * stopping something it cannot restart.
   */
  restartable: boolean;
  /** Where its stdout/stderr (and our own narration) land — the thing to read when it fails. */
  logPath: string;
}

export interface ManagedDaemonStartInput {
  /** The agent's writable root. Must come from a directory picker, never guessed (§2). */
  workspace: string;
  port: number;
  /** Loopback unless the user explicitly opens it to the phone. */
  host?: string;
}

export type ManagedDaemonStartResult =
  | { ok: true; pid: number; listen: string | null; token: string }
  | { ok: false; code: string; message: string };

/**
 * Outcome of stopping the local daemon. A failure has to come back as one: the
 * only other symptom would be a status line that still says「运行中」, which reads
 * as a dead button.
 */
export type ManagedDaemonStopResult = { ok: true } | { ok: false; message: string };

/**
 * Outcome of「改 token」. `restarted` says whether the daemon was relaunched so
 * the new token is already live — when false it will be picked up on next start.
 */
export type ManagedDaemonTokenResult =
  | { ok: true; token: string; restarted: boolean; listen: string | null }
  | { ok: false; code: string; message: string };

export interface BootstrapResult {
  /** Every connection main restored, each with its own status. */
  connections: ConnectionView[];
  /** Which one the previous session was scoped to, if it is still in the list. */
  activeId: string | null;
  /** Informational: is there a local daemon? Never used to connect on its own. */
  probe: ProbeResult;
}

/**
 * The id is chosen by the **renderer**, not by main. Main starts pushing events
 * the moment the stream is open — and a short run finishes before `streamStart`
 * could ever return — so if main picked the id, every event emitted before the
 * renderer learned it would be dropped (a one-word reply would vanish whole).
 * With the caller supplying it, the renderer can register the mapping first.
 */
export interface ChatStreamSpec {
  kind: 'chat';
  streamId: string;
  /** Which connection this run belongs to — main holds several at once (§4). */
  connectionId: string;
  /** null = a new session, created by this very request. */
  sessionId: string | null;
  prompt: string;
  runtime?: string;
  workspaceId?: string;
  permissionMode?: string;
  claudeSessionId?: string;
  /**
   * Idempotency key for `POST /api/chat`. A retry carrying the same value makes
   * the daemon re-attach to the run it already started instead of starting a
   * second one — which is what lets main resend a request whose response was
   * lost before the run id arrived. Generated by the renderer, where one send
   * maps to one run.
   */
  commandId: string;
}

/** Re-attach to a run that already exists, replaying from `after`. */
export interface AttachStreamSpec {
  kind: 'attach';
  streamId: string;
  connectionId: string;
  runId: string;
  after: number | null;
}

export type StreamSpec = ChatStreamSpec | AttachStreamSpec;

export type StreamPhase = 'connecting' | 'live' | 'reconnecting';

export type StreamOutcome = 'finished' | 'settled' | 'giveup' | 'cancelled';

/**
 * What main pushes to the renderer while a stream lives. Frames arrive batched
 * (contiguous deltas are coalesced), never one IPC message per token.
 */
export type StreamEvent =
  | { streamId: string; kind: 'frames'; frames: SseFrame[] }
  | { streamId: string; kind: 'phase'; phase: StreamPhase; attempt: number }
  | {
      streamId: string;
      kind: 'done';
      outcome: StreamOutcome;
      httpCode: number | null;
      apiCode: string | null;
      message: string | null;
    };

export type StartStreamResult =
  | { ok: true; streamId: string }
  | { ok: false; httpCode: number | null; apiCode: string | null; message: string };

/**
 * A daemon this client has connected to before, most recent first.
 *
 * Address only — never a token. The connect form fills the address from one of
 * these so switching machines is a paste, not a retype.
 */
export interface RecentConnection {
  baseUrl: string;
  name: string | null;
  lastUsedAt: number;
}

/** Process/app versions, for the About section. */
export interface AppInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
}

/**
 * Preferences the **main** process needs before any renderer exists (window
 * close behaviour, notifications). Appearance stays in the renderer's
 * localStorage; these do not, because main cannot read localStorage.
 */
export interface AppPrefs {
  /** `ask` prompts on the first close and remembers the answer if asked to. */
  closeBehavior: 'tray' | 'quit' | 'ask';
  /**
   * What happens to a daemon **we** started when the app quits (§7.5). `ask` shows
   * the dialog once; 「记住」 turns it into one of the other two. Daemons we merely
   * attached to are never touched.
   */
  daemonOnQuit: 'ask' | 'stop' | 'keep';
  desktopNotifications: boolean;
}

export interface RunningSessionRef {
  id: string;
  title: string;
}

export interface TrayState {
  runningCount: number;
  sessions: RunningSessionRef[];
}

export interface NotifyInput {
  /** Derived from the thing being notified about — see notify/notifications.ts. */
  id: string;
  title: string;
  body: string;
  /** Clicking the notification opens this session. */
  sessionId: string | null;
}

export interface StreamCancelInput {
  streamId: string;
  /** true → also `POST /api/runs/:id/cancel`. false → just detach. */
  abortRun: boolean;
}

/**
 * The bridge preload exposes on `window.paboot`. Declared here (not derived
 * from preload) so the renderer's tsconfig never has to resolve `electron`.
 */
export interface PabootBridge {
  /**
   * `process.platform`, read synchronously in the preload. The shell has to know
   * it *before* first paint: macOS hides the title bar and floats the traffic
   * lights over the content, so an async round trip would let the rail lay out
   * underneath them for a frame.
   */
  platform: string;
  boot(): Promise<BootstrapResult>;
  request(req: DaemonRequest): Promise<DaemonResponse>;
  connGet(): Promise<ConnectionView | null>;
  /** Every connection main holds, with per-host status — the rail's switcher. */
  connList(): Promise<ConnectionView[]>;
  /** Drop one connection (and its streams). Returns what is left. */
  connRemove(id: string): Promise<ConnectionView[]>;
  connSet(input: ConnectInput): Promise<ConnectResult>;
  daemonStatus(): Promise<ManagedDaemonStatus>;
  /** Start one we own. Every failure is a `{ ok: false, code }`, never a rejection. */
  daemonStart(input: ManagedDaemonStartInput): Promise<ManagedDaemonStartResult>;
  daemonStop(): Promise<ManagedDaemonStopResult>;
  /** Recent lines of the managed daemon's log. */
  daemonLogs(lines?: number): Promise<string[]>;
  /**
   * Replace the managed daemon's token. Omit `token` (or pass an empty string)
   * to generate a random one; a running daemon is restarted so it takes effect.
   */
  daemonSetToken(token?: string): Promise<ManagedDaemonTokenResult>;
  /** Drop one connection; `null` drops every one of them. Returns what is left. */
  connClear(id?: string): Promise<ConnectionView[]>;
  connProbe(): Promise<ProbeResult>;
  recentList(): Promise<RecentConnection[]>;
  appInfo(): Promise<AppInfo>;
  prefsGet(): Promise<AppPrefs>;
  prefsSet(patch: Partial<AppPrefs>): Promise<AppPrefs>;
  /** Push what the tray should show; main owns the tray, the renderer owns the data. */
  trayState(state: TrayState): Promise<void>;
  notify(input: NotifyInput): Promise<void>;
  notifyClose(id: string): Promise<void>;
  /** Tray / notification click asked for a session: focus the window and open it. */
  onSelectSession(listener: (sessionId: string) => void): () => void;
  /** Tell main which session this window shows — the notification rule needs it (§7.4). */
  setActiveSession(sessionId: string | null): Promise<void>;
  /** Open/close DevTools for this window. There is no app menu to reach it now. */
  toggleDevTools(): Promise<void>;
  /** Open a second window pinned to this session (§7.3). */
  openSessionWindow(sessionId: string): Promise<void>;
  /** The session this window was opened for, consumed once at boot. */
  focusSession(): Promise<string | null>;
  streamStart(spec: StreamSpec): Promise<StartStreamResult>;
  streamCancel(input: StreamCancelInput): Promise<void>;
  /** Subscribe to stream events; returns an unsubscribe function. */
  onStream(listener: (event: StreamEvent) => void): () => void;
}
