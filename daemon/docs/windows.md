# Windows 兼容

> daemon 在 macOS / Linux / Windows 上跑同一套代码；本文只记 Windows 上与 POSIX
> 不同的行为与前提。

## 前提

| 项 | 要求 |
|---|---|
| Node | >= 24.9（`node:sqlite`） |
| Git for Windows | **建议安装**。命令类定时任务需要一个 POSIX shell；Claude Code 的 Bash 工具本身也依赖它 |
| Windows | 10 / 11；无原生模块，不需要 Visual Studio Build Tools |

## 平台差异

### 可执行文件解析

Windows 上 npm 安装的 CLI 是 `claude.cmd` / `codex.cmd` / `dsh.cmd`。
`platform/executable.ts` 统一走 `cross-spawn`：按 `PATH` + `PATHEXT` 解析，
`.cmd`/`.bat` 通过 `cmd.exe` 执行并做参数转义。原生安装的 `.exe` 不受影响。

所有 spawn 都带 `windowsHide: true`，避免从桌面端启动时弹控制台窗口。

### 命令任务的 shell

`platform/shell.ts` 的解析顺序：

1. 非 Windows：`/bin/sh`
2. Windows + Git Bash：`CLAUDE_CODE_GIT_BASH_PATH` →
   `%ProgramFiles%\Git\bin\bash.exe` → `%ProgramFiles(x86)%\...` →
   `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`
3. 都没有：`%ComSpec%`（`cmd.exe`）兜底 —— POSIX 语法（管道、`$VAR` 等）不保证可用

刻意不用 `where bash`：装了 WSL 时它可能命中 `System32\bash.exe`，那是 Linux shell，
会把 Windows 工作区路径当成外部路径。

### 取消与进程树

- POSIX：命令任务以独立进程组启动，`kill(-pid)` 整组终止；
- Windows：无进程组/信号，统一 `taskkill /PID <pid> /T /F`，连同 agent 的子进程一起结束。

### 优雅停机

Windows 没有 SIGTERM。桌面端停止本机 daemon 时先调用
`POST /api/system/shutdown`（operator token + 仅 loopback），让 daemon 走正常的
`shutdown()`（停调度器、关 DB、删 runtime 文件、释放 lock）；请求失败才 `taskkill /T /F`。
硬杀也可恢复：下次启动会接管 stale lock、清理过期 runtime 文件，并把遗留 run 标记为
interrupted。

控制台里 Ctrl+C（`SIGINT`）与 Ctrl+Break（`SIGBREAK`）都会走同一停机路径。

### 权限 hook

Claude Code 的 PreToolUse hook 命令里的可执行文件与脚本路径现在都加双引号，
安装目录或用户名带空格时不会断。

## 已知限制

- `POST /api/deploy` 在 Windows 上返回 `501`：它依赖 `systemctl` 与 shell 脚本。
- 没装 Git for Windows 时，命令任务回退到 `cmd.exe`，只能跑 Windows 原生命令。
- 工作区/Session 路径按 Windows 文件系统语义做大小写不敏感比较。

## 验证清单

- [ ] `pnpm typecheck && pnpm test && pnpm build`
- [ ] 原生安装与 npm 安装的 CLI 都能被探测到
- [ ] 命令类定时任务在安装目录/工作区含空格时正常执行、取消后无残留进程
- [ ] 权限审批在用户名含空格的机器上正常弹出
- [ ] 桌面端停止本机 daemon 后 `daemon_runtime.json` 与 `paboot.lock` 均被清理
- [ ] 局域网手机连接时放行 Windows 防火墙的「专用网络」
