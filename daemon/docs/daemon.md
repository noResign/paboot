# paboot daemon 技术方案

> 面向维护者和后续接入客户端的开发者，代码在 `daemon/`

| 文件 | 章节 |
|---|---|
| 本文 | 概述 · 总体架构 · 核心模块 · 目录结构 · 安装使用 · 构建 / 运行 · 已知限制 |
| [runtimes.md](runtimes.md) | 运行时接入（两条路径） |
| [protocol.md](protocol.md) | 数据模型 · HTTP/SSE 协议 · 会话与跨端续接 · 运行信息文件 |
| [permissions.md](permissions.md) | 权限审批 · 安全模型 |
| [configuration.md](configuration.md) | 配置参数参考 |
| [docker.md](docker.md) | Docker 部署（镜像只含 daemon；默认工作区隔离，可选挂宿主机项目） |

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
│ daemon (Node >=24.9 + Express + node:sqlite，零原生依赖)  │
│  ├─ auth.ts           Bearer token（常量时间比较 + 失败冷却）│
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

| 目录 / 文件 | 职责 |
|---|---|
| `index.ts` | 入口：加载 .env → 解析 CLI → loadConfig → 建 Db/registry → 探测运行时 → startServer |
| `version.ts` | 版本号（package.json 唯一来源）；**必须留在 src 根**，见下方说明 |
| `permission-hook.ts` | 独立可执行入口：PreToolUse hook（被按路径 spawn） |
| `app/` | 组合根与进程生命周期：`cli`（参数解析）、`config`（env+CLI 合并、token）、`context`（`AppContext`）、`data-dir-lock`、`runtime-info`、`server`（Express 组合根） |
| `http/` | HTTP/SSE 传输原语：`auth`（Bearer 鉴权 + 按来源失败冷却）、`cors`、`sse`（帧写入 + 终态判断） |
| `platform/` | 无领域依赖的共享原语：`log`、`network`（监听地址翻译）、`paths` |
| `db/` | 持久化：`db.ts`（`node:sqlite`）、`dto.ts`（run DTO 映射）、`model-selection.ts`、`server-id.ts` |
| `workspaces/` | 工作区领域：`workspace` / `workspace-service`（路径校验、目录选择）、`changes`（git 改动/diff）、`checkpoints`（run 前后快照）、`file-browser`（目录懒加载与文件读取） |
| `runs/` | run / session 领域：`run-service`（chat/scheduler/command 共用生命周期）、`run-notifier`（SSE fan-out）、`session-runs`（在跑 run 按 session 索引）、`session-title` |
| `permissions/` | 权限领域：`permissions`（`PermissionManager`）、`permission-mode`（产品模式 ↔ CLI 模式）、`tool-grants`（grant key 映射）、`command-safety`（Bash 只读白名单） |
| `scheduling/` | 定时任务领域：`scheduler`（30s tick + 启动对账）、`schedule`（cron 校验/求值）、`task-config`（AI 配置会话 prompt） |
| `mcp/` | MCP 模块：`injection.ts`（各 runtime 注入参数）、`context.ts` / `types.ts`、`servers/paboot_tasks/`（stdio server + 工具定义）；后续 MCP server 按真实名称建同名目录 |
| `routes/*.ts` | HTTP/SSE 边界，按域拆分（完整清单见 [protocol.md](protocol.md) 的端点表） |
| `runtimes/` | runtime 插件层：`engine`（argv 通用生命周期）、`registry`、`drivers`（driver 装配点）、`active-runs`、`stdio-rpc`、`claude/`、`codex/`、`deepseek/`、`command` |
| `types/api.ts` | 传输契约：`NormalizedEvent` 事件 union + DTO |

## 目录结构

```
daemon/
├─ src/
│  ├─ index.ts            入口（.env → CLI → config → server），bin 指向 dist/index.js
│  ├─ permission-hook.ts  PreToolUse hook（→ dist/permission-hook.js）
│  ├─ version.ts          版本号（package.json 唯一来源）；路径敏感，必须留在 src 根
│  ├─ app/                组合根 + 进程生命周期（唯一允许认识所有模块的层）
│  │  ├─ cli.ts / config.ts / context.ts
│  │  ├─ data-dir-lock.ts / runtime-info.ts
│  │  └─ server.ts        Express 组合根
│  ├─ http/               auth / cors / sse
│  ├─ platform/           log / network / paths（无领域依赖）
│  ├─ db/                 db / dto / model-selection / server-id
│  ├─ workspaces/         workspace / workspace-service / changes / checkpoints / file-browser
│  ├─ runs/               run-service / run-notifier / session-runs / session-title
│  ├─ permissions/        permissions / permission-mode / tool-grants / command-safety
│  ├─ scheduling/         scheduler / schedule / task-config
│  ├─ mcp/                MCP 模块
│  │  ├─ injection.ts     各 runtime 的 MCP 注入参数（Claude / Codex / DeepSeek）
│  │  ├─ context.ts / types.ts
│  │  └─ servers/paboot_tasks/
│  │     ├─ server.ts     stdio MCP server（→ dist/mcp/servers/paboot_tasks/server.js）
│  │     └─ tools/        schedule-task / list-scheduled-tasks / cancel-scheduled-task / list-sessions
│  ├─ routes/             HTTP/SSE 边界（按域拆）
│  ├─ runtimes/           engine / registry / drivers / active-runs / stdio-rpc + claude/ · codex/ · deepseek/ · command
│  └─ types/api.ts        传输契约
├─ tests/                Vitest 单测（含 architecture.test.ts 分层守卫）
├─ docs/                 daemon.md（索引）+ protocol / permissions / runtimes / scheduled-tasks / configuration
├─ .env.example          配置模板
├─ package.json / tsconfig.json / vitest.config.ts
└─ dist/                 构建产物（`paboot` bin 指向 dist/index.js）
```

> `version.ts` 留在 src 根：`createRequire('../package.json')` 在 tsc 产物（`dist/version.js`）
> 和桌面端 esbuild 单文件产物（`dist/index.js`）两种形态下都能解析到与 `dist/` 同级的
> `package.json`；移入子目录会破坏其中一种。

### 分层与依赖规则

- `app/` 是唯一组合根，可以认识所有模块；其他层对 `app/` 只允许 `import type`。
- `db/` 不依赖 `routes/`、`runtimes/` 和业务领域。
- `runtimes/`、业务领域不依赖 `routes/`。
- `types/`、`platform/` 是叶子；`http/` 只依赖 `http/`、`platform/`、`types/`。
- `index.ts`、`permission-hook.ts` 只做进程装配，不承载业务逻辑。
- `tests/architecture.test.ts` 会扫描 import 并强制以上规则。

### 扩展落点

- **新业务领域**：`src/<domain>/` + `src/routes/<domain>.ts`；需要持久化时在 `db/` 增加方法。
- **新 runtime**：`src/runtimes/<id>/` + `runtimes/registry.ts` 注册 + `runtimes/drivers.ts` 装配；
  路由/引擎/持久化不动。
- **新可执行进程**：`src/<name>.ts`（与 `index.ts` 同级），同步更新 `ctx` 路径与桌面端
  `bundle-daemon.mjs` 的 entries 列表。
- **新 MCP 工具**：在 `mcp/servers/<server-name>/tools/` 加一个文件，并在同目录 `tools/index.ts`
  注册；`server.ts` / `injection.ts` 不动。
- **新 MCP server**：`src/mcp/servers/<server-name>/server.ts` + `tools/`，在 `mcp/injection.ts`
  注册启动 spec；同步 `ctx` 中的 server 路径（当前只有 `paboot_tasks`）与桌面打包 entries。
- **新共享原语**：`src/platform/`（必须保持无领域依赖）。

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
