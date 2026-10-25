> English | [中文](README.md)

<div align="center">

<h1>paboot</h1>

<h4>One client for all your agents</h4>


[📚 **Docs**](docs/ui/README.md) • [📱 **Android client**](android/README.md) • [🖥️ **Desktop**](desktop/README.md) • [⚙️ **daemon**](daemon/README.md) • [🍎 **iOS**](ios/README.md)

[![npm](https://img.shields.io/npm/v/@noresign/paboot?color=0E9F86)](https://www.npmjs.com/package/@noresign/paboot) [![license](https://img.shields.io/badge/license-Apache--2.0-0E9F86)](LICENSE)

</div>

**Built as one system across clients — switch form factor whenever you like, and drive every agent on your computer (Claude Code, Codex and DeepSeek Harness today).**
**Your data always stays on your computer**: phone and desktop drive the same sessions, and a dropped connection neither stops a run nor loses your place.

- **One client for all your agents** — Claude Code, Codex and DeepSeek Harness today. Adding a new
  agent does not touch the clients.
- **Three clients, one system, each native** — Android, iOS and desktop share one protocol and one
  design system, operate on the same sessions, and are each implemented natively.
- **Your data stays on your machine** — agents use your environment, tools, configs and skills;
  everything stays on your computer, and paboot itself needs no account and collects no data.
- **Disconnects do not stop runs** — a run is decoupled from its connection: locking the phone,
  switching apps or losing the network does not stop the work, and you pick it up where you left off.
- **Approval stays in your hands** — per-session `ask` / `acceptEdits` / `bypass`; deny by default,
  with Bash, file writes and MCP calls arriving on your phone as approval cards, auto-denied on
  timeout, and read-only commands auto-allowed.
- **Many runs at once, notified when done** — several sessions and runs in parallel without
  blocking each other; when you are not in that conversation, approvals and finished runs trigger
  a system notification.
- **See and roll back every change** — Git changes, per-file diffs, the directory tree and
  text / image / video previews without leaving the conversation; every run keeps a checkpoint
  snapshot, and desktop can roll back to any of them.

## Quick start

### 0. Prerequisites

paboot drives Claude Code, Codex and DeepSeek Harness today — install and configure at least one of them:

> [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
>
> [Claude Code](https://code.claude.com/docs) and run `claude auth login`
>
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): `npm install -g @deepseek-ai/dsh`;
> provide model credentials through the `DEEPSEEK_API_KEY` environment variable, or fill them in
> under **Settings → Models** in `dsh web`.

### 1. Server

```bash
npm install -g @noresign/paboot      # the global command is `paboot`

paboot  # the working directory defaults to where you launch it
```

- The token is persisted at `~/.paboot/token` (delete the file to rotate); pass
  `--token` to set your own
- Full flags, configuration, and the HTTP/SSE API live in
  [daemon/README.md](daemon/README.md)

### 2. Clients

**Installers are available on the [releases](https://github.com/noResign/paboot/releases) page**

**(1) android**

Open `android/` in Android Studio, pick a flavor and Run. The command-line equivalent:

```bash
cd android
./gradlew :app:assembleAlphaDebug
```

Two channels: `alphaDebug` (alpha) and `prodDebug` (prod); release signing needs
`android/keystore.properties`. Module layout and signing notes live in
[android/README.md](android/README.md).

**(2) ios**

Requires macOS + Xcode 15+ (iOS 17 SDK). Open `ios/paboot.xcodeproj` in Xcode and Run; the
command-line equivalent:

```bash
cd ios
xcodebuild -project paboot.xcodeproj -scheme paboot \
  -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
```

Module layout and the pure-logic tests (`ios/PabootCore`) live in [ios/README.md](ios/README.md).

**(3) desktop**

The desktop build runs the daemon's tsc to generate the protocol types, so install both sides'
dependencies first:

```bash
cd daemon && pnpm install && cd ..
cd desktop && pnpm install    # downloads the Electron binary (~100MB)
```

Day-to-day development and packaging:

```bash
cd desktop
pnpm dev             # main process + renderer (HMR)
pnpm dist            # package the current platform into release/
pnpm dist:linux      # or dist:mac / dist:windows
```

Commands and build details live in [desktop/README.md](desktop/README.md).


### 3. Connecting from outside your LAN (optional)

By default the daemon only listens on your LAN. To reach it from the internet, two
common approaches:

**(1) SSH relay** — for personal use. You need one machine with a public IP. On the
**computer running the daemon**:

```bash
ssh -N -R 0.0.0.0:4788:localhost:4780 user@your-server
```

Then point your phone at `http://your-server:4788` — 4788 is the port on the server; pick
any you like. Note that **SSH only encrypts the "computer → server" leg; the hop from the
phone to the server is still plain HTTP**, so the token travels in the clear there — which
is why this route is only for your own temporary use.



- The command binds `0.0.0.0`, but the server ignores that and binds to **loopback** by
  default, so the phone still cannot reach it. Set `GatewayPorts clientspecified` in the
  server's `/etc/ssh/sshd_config`
- The tunnel does not reconnect by itself; use `autossh -M 0 -N -R ...` or run it under systemd

**(2) Mesh / VPN tools** — put the computer and the phone on the same virtual network, then
connect to the address the daemon printed (or its virtual IP) exactly as if you were on the
same LAN. Nothing to change on the daemon side:

- **Tailscale / ZeroTier** — sign in and go; mobile apps included, with a relay fallback when NAT traversal fails
- **WireGuard** — roll your own; cleanest, but you maintain the keys and routes

The whole path is encrypted end to end, so there is no certificate or port exposure to
worry about.

> ⚠️ Any of the above means the daemon is exposed beyond your own machine,
> and it drives an agent with shell access — anyone who connects can drive it to operate
> your computer. Do not leak your IP or token, and make sure the token is strongly random.

## Mobile UI

| Sessions | Chat (Markdown rendering) | Approval | New session |
|---|---|---|---|
| <img src="docs/media/session_dir.jpg" width="170" alt="Sessions"> | <img src="docs/media/session.jpg" width="170" alt="Chat"> | <img src="docs/media/permission_dialog.jpg" width="170" alt="Approval"> | <img src="docs/media/create_session.jpg" width="170" alt="New session"> |

| Files / diff (multiple Git dirs) | All files | Workspaces | Settings |
|---|---|---|---|
| <img src="docs/media/file_git.jpg" width="170" alt="Files / diff"> | <img src="docs/media/file_full.jpg" width="170" alt="All files"> | <img src="docs/media/workspace_manage.jpg" width="170" alt="Workspaces"> | <img src="docs/media/setting.jpg" width="170" alt="Settings"> |

## License

Apache-2.0 — see [LICENSE](LICENSE).
