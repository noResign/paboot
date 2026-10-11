> English | [中文](README.md)

<div align="center">

<h1>paboot</h1>

<h4>One client for all your agents</h4>

<h5>Phone and desktop, picking up the same session</h5>

[📚 **Docs**](docs/ui/README.md) • [📱 **Android client**](android/README.md) • [🖥️ **Desktop**](desktop/README.md) • [⚙️ **daemon**](daemon/README.md) • [🍎 **iOS**](ios/README.md) • [🔒 **Security model**](#security-model-)

[![npm](https://img.shields.io/npm/v/@noresign/paboot?color=0E9F86)](https://www.npmjs.com/package/@noresign/paboot) [![license](https://img.shields.io/badge/license-Apache--2.0-0E9F86)](LICENSE)

</div>

**Built as one system across clients — switch between them whenever you like, and drive every agent on your computer (Claude Code and Codex today; more to come).**

The client is just the entry point; **the work always runs on your computer** — losing the connection does not stop a run, and reconnecting picks up where you left off. The same session carries over between phone and desktop.

Today it is still a developer tool; from here it grows from "one client driving many agents" toward customization for specific roles, and eventually your own personal agent.

## Quick start

### 1. Install the daemon

Requirements: **Node `~24`**, plus an agent CLI installed and logged in on this machine — Claude Code (`claude auth login`) or Codex; whichever you have is the one you can use.

```bash
npm install -g @noresign/paboot      # the global command is `paboot`

paboot  # the working directory defaults to where you launch it
```

- The token is persisted at `~/.paboot/token` (delete the file to rotate); pass
  `--token` to set your own
- Full flags, configuration, and the HTTP/SSE API live in
  [daemon/README.md](daemon/README.md)

### 2. Android client

**(1) Download the APK from the [releases](https://github.com/noResign/paboot/releases) page**

**(2) Build it yourself**

Open `android/` in Android Studio, pick a flavor
and Run. The command-line equivalent:

```bash
cd android
./gradlew :app:assembleAlphaDebug
```

Two channels: `alphaDebug` (alpha) and `prodDebug` (prod); release signing needs
`android/keystore.properties`. Module layout and signing notes live in
[android/README.md](android/README.md).

### 3. Steps

1. Open the app, enter the daemon address (the LAN address printed on start) and the token, connect
2. Create a session → pick a workspace directory → send a prompt
3. The agent works on your computer: watch the stream on your phone and answer approval
   cards when a tool call needs your confirmation
4. Enable background task alerts under Settings → Notifications and grant notification
   permission. Approvals and completed, failed or cancelled tasks trigger alerts when you
   are not viewing that conversation; tap an alert to open it
5. Walk away whenever you like — the run keeps going on your computer, and reconnecting
   picks it back up

### 4. Connecting from outside your LAN (optional)

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

## Features

Phone and desktop share one set of capabilities — the table below is written from the
phone's point of view; **system notifications are Android-only**.

| Capability | Notes |
|---|---|
| Streaming output on the phone | Text and thinking stream in live; tool calls render as expandable cards |
| Tool approval | Forward Bash / file writes / MCP calls according to the session mode; allow once, deny, or allow all. **Unanswered requests are denied on timeout** |
| Session permissions | Choose `ask` / `acceptEdits` / `bypass` per session; save and revoke persistent grants by tool name, or by server for MCP tools |
| Android notifications | Get alerts for approvals and completed, failed or cancelled tasks when you are not viewing that conversation; tap to open it, with no duplicate alerts while watching |
| Read-only allowlist | Read-only commands like `ls`, `cat`, `git status` are auto-approved, so they do not bother you |
| Reconnect-safe runs | Runs are decoupled from connections: losing signal, backgrounding the app or locking the phone does not stop the work on your computer |
| Concurrent sessions | Many sessions and runs in parallel, with no global lock |
| Two-way resume | Import a desktop Claude Code session into the phone, or resume a paboot session on the desktop with `claude --resume` |
| Workspaces & additional directories | Add / switch workspaces and manage additional directories from the phone; sessions in the same workspace share those directories |
| Directory shortcuts | Bookmark frequently browsed directories separately from the agent’s additional directories |
| Files & diffs | Browse uncommitted Git changes, per-file diffs, directory trees and text files from the phone; images / MP4s preview in place |

## Mobile UI

| Sessions | Chat (Markdown rendering) | Approval | New session |
|---|---|---|---|
| <img src="docs/media/session_dir.jpg" width="170" alt="Sessions"> | <img src="docs/media/session.jpg" width="170" alt="Chat"> | <img src="docs/media/permission_dialog.jpg" width="170" alt="Approval"> | <img src="docs/media/create_session.jpg" width="170" alt="New session"> |

| Files / diff (multiple Git dirs) | All files | Workspaces | Settings |
|---|---|---|---|
| <img src="docs/media/file_git.jpg" width="170" alt="Files / diff"> | <img src="docs/media/file_full.jpg" width="170" alt="All files"> | <img src="docs/media/workspace_manage.jpg" width="170" alt="Workspaces"> | <img src="docs/media/setting.jpg" width="170" alt="Settings"> |

## Security model ⚠️

**`workspace` is not a sandbox.** It only decides which directory the agent is spawned
from — it does not restrict which paths the agent can touch. `Read` / `Grep` are explicitly
allowed by default, with no client approval or automatic directory grants; explicit user
or administrator restrictions still apply. Writes follow the session mode, tool approvals
and Claude Code’s own rules. `acceptEdits` does not grant writes to every path. File-level
isolation requires an OS sandbox (bwrap / firejail / container).

What the daemon does enforce:

- **Auth**: every non-health `/api/*` route requires a bearer token (constant-time compare)
- **Permission modes**: `ask` by default; `bypass` must be explicitly enabled on the client
- **Deny by default**: unanswered approvals time out to deny; disconnecting the client does not immediately deny requests or end the run
- **Bash auto-approval**: commands without shell metacharacters that match the allowlist pass through; matching currently uses command prefixes and does not guarantee that every argument combination is read-only
- **Audit log**: writes (chat / cancel / permission_decision / session rename and delete / config and workspace changes …) are recorded in `audit_log`

On an untrusted network, put the devices on an encrypted virtual network first (Tailscale /
ZeroTier / WireGuard — see "Connecting from outside your LAN"), and keep the token secret.
For local-only use, `--host 127.0.0.1`.

## Status

- **Agents**: Claude Code and Codex (experimental)
- **daemon**: usable (sessions / approvals / workspaces / files)
- **Android**: implemented (connect, session list, chat, approvals, session permissions, system notifications, new session, settings, files, workspace management)
- **Desktop**: implemented (Electron client, see [desktop/README.md](desktop/README.md))
- **iOS**: reserved, not implemented

## License

Apache-2.0 — see [LICENSE](LICENSE).
