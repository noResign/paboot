# paboot daemon 技术方案

> 面向维护者和后续接入客户端的开发者，代码在 `daemon/`

| 文件 | 章节 |
|---|---|
| 本文 | 概述 · 总体架构 · 核心模块 · 目录结构 · 安装使用 · 构建 / 运行 · 已知限制 |
| [runtimes.md](runtimes.md) | 运行时接入（两条路径） |
| [protocol.md](protocol.md) | 数据模型 · HTTP/SSE 协议 · 会话与跨端续接 · 运行信息文件 |
| [permissions.md](permissions.md) | 权限审批 · 安全模型 |
| [configuration.md](configuration.md) | 配置参数参考 |

## 概述

`daemon` 是一个跑在 macOS/Linux 本机的守护进程：它 `spawn` 本机已安装的编码
agent CLI（已接入 Claude Code、Codex 与 DeepSeek Harness），以无头方式执行，把输出解析成统一的
流式事件，通过 HTTP/SSE 推给客户端（Android / iOS / 桌面），并支持会话续接、断线重连、
取消、工具审批、多 agent 并发。

核心定位：**「一个客户端，操纵你所有的 agent」**。

**关键心智模型**：客户端只是入口，任务在电脑上执行。**客户端断连不影响任务，多客户端一体化设计**——daemon 继续跑，重连后能续上，多客户端内容一致，随时切换客户端进行会话。

## 总体架构

```
客户端 (Android / iOS / 桌面)
   │  HTTP(S) + Bearer token
   │  POST /api/chat              (发指令，返回 SSE)
   │  GET  /api/runs/:id/stream   (重连：回放 + 续直播)
   ▼
┌────────────────────────────────────────────────────────┐
│ daemon (Node 24 + Express + node:sqlite，零原生依赖)      │
│  ├─ auth.ts           Bearer token（常量时间比较）        │
│  ├─ db.ts             SQLite（会话/消息/运行/事件/审计）   │
│  ├─ permissions.ts    工具审批 + auto-allow + 超时拒绝    │
│  ├─ run-notifier.ts   runId → 多个 SSE 订阅者（fan-out）  │
│  └─ runtimes/   engine(claude) / session(codex|deepseek) →事件│
└────────────────────────────────────────────────────────┘
   │ spawn(cli, [...], { cwd: session.cwd })
   ▼
本机编码 agent（Claude Code 无头 -p；Codex app-server；DeepSeek Harness dsh acp）
```

数据流：

```
用户发消息 → POST /api/chat
  → 解析会话 → 创建 run → spawn agent（cwd = workspace）
  → agent stdout → createParser → NormalizedEvent → 持久化(events) + SSE 推送 + fan-out
  → agent exit → 发 terminal status → res.end()
```

## 核心模块

| 文件 | 职责 |
|---|---|
| `index.ts` | 入口：加载 .env → 解析 CLI → loadConfig → 建 Db/registry → 探测运行时 → startServer |
| `cli.ts` | `util.parseArgs` 解析 `paboot` 命令行，`--help`/`--version` |
| `config.ts` | env + CLI 合并（CLI 优先）；token 持久化；workspace/超时等默认值 |
| `context.ts` | `AppContext`：把 config / db / registry / notifier 等依赖打包递给各路由 |
| `server.ts` | Express 组合根：CORS → JSON → 鉴权门 → 各路由注册 |
| `routes/*.ts` | HTTP/SSE 边界，按域拆分（完整清单见 [protocol.md](protocol.md) 的端点表） |
| `runtimes/engine.ts` | 通用 spawn 生命周期（argv 路径，见 [runtimes.md](runtimes.md)） |
| `runtimes/codex/` | Codex 的 JSON-RPC 会话驱动：`detect` / `rpc` / `map` / `session`（见 [runtimes.md](runtimes.md)） |
| `runtimes/deepseek/` | DeepSeek Harness 的 ACP 会话驱动：`detect` / `models` / `rpc` / `map` / `session`（见 [runtimes.md](runtimes.md)） |
| `runtimes/stdio-rpc.ts` | Codex / DeepSeek 共用的换行分隔 JSON-RPC peer 传输（含服务端反向请求） |
| `permission-mode.ts` | 产品权限模式 ↔ Claude `--permission-mode` 的映射（见 [configuration.md](configuration.md) 的「权限模式」） |
| `permissions.ts` | `PermissionManager`：pending 请求 + 超时默认拒绝 + 同 Session allow-all 结算 |
| `run-notifier.ts` | `RunNotifier`：runId → 该 run 的多个 SSE 订阅者（emitter + listeners） |
| `session-runs.ts` | 「在跑的 run 按 session 索引」的查询：会话列表的运行标记、`/api/chat` 的同会话守卫 |
| `session-title.ts` | 从首条 prompt 生成会话标题 |
| `runtime-info.ts` | 写/刷/删 `<data-dir>/daemon_runtime.json`（见 [protocol.md](protocol.md) 的「运行信息文件」） |
| `data-dir-lock.ts` | 单实例锁 `<data-dir>/paboot.lock`（`O_EXCL` 创建 + pid 探活）：同一数据目录只允许一个 daemon |
| `command-safety.ts` | Bash 只读命令白名单（只读自动放行，其余询问） |
| `tool-grants.ts` | grant key 映射：MCP 工具 → server 级 `mcp__<server>__*`，其余用 toolName |
| `workspace.ts` / `workspace-service.ts` | Workspace 路径校验/包含关系；目录选择器复用 |
| `permission-hook.ts` | PreToolUse hook 脚本（被 claude 调用，转发审批到 daemon） |
| `schedule.ts` | cron 校验/求值、结构化预设 → cron、人类可读 label（`cron-parser`） |
| `scheduler.ts` | 进程内调度器：启动对账、30s tick、到期触发、忙跳过、会话失效删除、工作区失效停用 |
| `run-service.ts` | 可复用的 run 启动服务（chat / scheduler / command 共用生命周期与终态） |
| `tool-server.ts` | 通用 MCP 工具 server 的规格与各 runtime 的注入参数（Claude JSON / Codex `-c` / DeepSeek ACP `mcpServers`） |
| `mcp-server.ts` | stdio MCP server（`schedule_task` 等），被各 runtime 以 `paboot_tasks` 启动 |
| `runtimes/command.ts` | 命令任务 runtime：`/bin/sh -c`，复用 run/checkpoint/cancel 管线 |
| `routes/scheduled-tasks.ts` / `routes/mcp-tasks.ts` | 定时任务公开 API / agent 内部 API |
| `dto.ts` | run DTO 的共享映射（会话与定时任务详情共用） |
| `changes.ts` | `git status` / diff 的解析与缓存（文件 Tab 的改动视图） |
| `file-browser.ts` | 目录懒加载、文本读取与二进制检测、原始字节流 |
| `sse.ts` | SSE 帧写入 + `isTerminalEvent` 判断（chat 与 stream 复用） |
| `db.ts` | `node:sqlite` 持久化（内置，零原生依赖） |
| `types/api.ts` | 传输契约：`NormalizedEvent` 事件 union + DTO |
| `auth.ts` / `cors.ts` / `log.ts` / `network.ts` / `version.ts` | 小工具：鉴权、CORS、日志、监听地址翻译、版本号 |

## 目录结构

```
daemon/
├─ src/
│  ├─ index.ts           入口（.env → CLI → config → server）
│  ├─ server.ts          Express 组合根
│  ├─ context.ts         AppContext（路由依赖容器）
│  ├─ config.ts / cli.ts / permission-mode.ts / version.ts
│  ├─ log.ts / network.ts / cors.ts / auth.ts / sse.ts / workspace.ts / workspace-service.ts
│  ├─ db.ts              SQLite 持久化
│  ├─ permissions.ts     权限注册表
│  ├─ run-notifier.ts    runId → 多 SSE 订阅者
│  ├─ session-runs.ts    在跑的 run 按 session 索引
│  ├─ session-title.ts   从首条 prompt 生成会话标题
│  ├─ runtime-info.ts    写/刷/删 daemon_runtime.json（见 [protocol.md](protocol.md) 的「运行信息文件」）
│  ├─ command-safety.ts  只读命令白名单
│  ├─ tool-grants.ts     grant key 映射（MCP → server 级通配）
│  ├─ permission-hook.ts PreToolUse hook 脚本（→ dist/permission-hook.js）
│  ├─ mcp-server.ts      stdio MCP 工具 server（→ dist/mcp-server.js）
│  ├─ schedule.ts        cron 求值 / 预设转换
│  ├─ scheduler.ts       定时任务调度器（30s tick + 启动对账）
│  ├─ run-service.ts     chat / scheduler / command 共用的 run 启动服务
│  ├─ tool-server.ts     通用 MCP server 规格与 runtime 注入
│  ├─ changes.ts         git 改动与 diff
│  ├─ file-browser.ts    目录懒加载与文件读取
│  ├─ types/api.ts       传输契约
│  ├─ routes/            HTTP/SSE 边界（按域拆）
│  └─ runtimes/          types / registry / engine / active-runs / stdio-rpc + claude/ · codex/ · deepseek/
├─ tests/                Vitest 单测（runtimes / routes / 权限 / workspace / 文件 等）
├─ docs/                 daemon.md（索引）+ protocol / permissions / runtimes / scheduled-tasks / configuration
├─ .env.example          配置模板
├─ package.json / tsconfig.json / vitest.config.ts
└─ dist/                 构建产物（`paboot` bin 指向 dist/index.js）
```

## 安装使用（本机已装并配置 Claude Code / Codex / DeepSeek Harness 至少一种）：

```bash
npx @noresign/paboot --help             # 免安装试用
npm install -g @noresign/paboot         # 装成全局命令（命令名仍是 paboot）
paboot --workspace /path/to/project --token <strong-token>
```

`.env` 配置（运行目录下自动加载）：

```bash
cp .env.example .env && vim .env
paboot
```

## 本地构建 / 运行

```bash
cd daemon
pnpm install
pnpm dev        # tsx watch src/index.ts
```

## 已知限制 / 后续

- 只读 Bash 白名单是内置默认，可考虑做成配置文件（`.paboot/policy.json`）可增减。
- 权限模式与「允许全部」均为 **Session 级**；切换 Workspace 或新建 Session 不会继承旧 Session 的 grant。
- 权限审批依赖 Claude Code 的 PreToolUse hook 格式，需随 CLI 版本演进同步探测/适配。
- **`workspace` 不是沙箱**（见 [permissions.md](permissions.md) 的「安全模型」）——文件级隔离需 OS 层沙箱。
- Android 已实现 M1、桌面端（Electron）已接入；iOS 预留。传输契约（`types/api.ts`）是跨端唯一真源，各端据此接入。
