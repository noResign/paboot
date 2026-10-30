# daemon

paboot 的守护进程：`spawn` 本机已安装的编码 agent CLI（已接入 Claude Code、Codex 与 DeepSeek Harness），
以无头方式执行，把输出解析成统一的流式事件，通过 HTTP/SSE 推给客户端。

完整技术方案见 **[docs/daemon.md](docs/daemon.md)**（索引：总览 / [协议](docs/protocol.md) /
[权限](docs/permissions.md) / [运行时](docs/runtimes.md) / [配置](docs/configuration.md)）；
项目总览见 [paboot 仓库](https://github.com/noResign/paboot#readme)。

## 包安装

```bash
npm install -g @noresign/paboot # 安装

paboot # 运行
```

首次启动生成 token 并打印，同时打印本机局域网地址；token 持久化在 `<data-dir>/token`
（默认 `~/.paboot/token`），删掉即轮换。

## 源码构建与运行

- Node `~24`、pnpm 10
- 本机已装并登录 `claude` CLI（`claude auth login`）

```bash
pnpm install
pnpm build            # tsc → dist/index.js（含 permission-hook.js 与 mcp/servers/paboot_tasks/server.js）
pnpm dev --workspace ~/code/my-project (或者 node dist/index.js)

pnpm typecheck        # check
pnpm test             # Vitest
```

## 配置

优先级：**命令行 flag > shell 环境变量 > `.env` 文件 > 默认值**。

| flag | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--host` | `PABOOT_HOST` | `0.0.0.0` | 监听地址（`127.0.0.1` = 仅本机） |
| `--port` | `PABOOT_PORT` | `4780` | 端口 |
| `--workspace` | `PABOOT_WORKSPACE` | 当前目录 | 初始 Workspace 根目录 |
| `--token` | `PABOOT_TOKEN` | 自动生成 | Bearer 鉴权密钥 |
| `--permission-mode` | `PABOOT_PERMISSION_MODE` | `default`(=ask) | 新 Session 权限模式 seed |
| `--env-file` | `PABOOT_ENV_FILE` | `./.env` | `.env` 路径 |

其他常用变量：`PABOOT_PERMISSION_TIMEOUT_SECONDS`（审批超时，默认 120）、
`PABOOT_RUN_IDLE_TIMEOUT_SECONDS`（空闲看门狗，默认 900，0=禁用）、
`PABOOT_ALLOW_DEPLOY`（允许手机触发部署，默认关闭）。

完整清单见 [.env.example](.env.example) 与 [docs/configuration.md](docs/configuration.md)。

## 冒烟测试

```bash
TOKEN=$(cat ~/.paboot/token)
curl -s http://127.0.0.1:4780/api/health
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4780/api/agent
curl -N -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"prompt":"列出当前目录的文件并总结"}' http://127.0.0.1:4780/api/chat
```

## API 速览

非 `/api/health` 的所有路由都要 `Authorization: Bearer <token>`。

| 方法 & 路径 | 说明 |
|---|---|
| `GET /api/health` | 存活 + 版本（唯一免鉴权） |
| `POST /api/chat` | 发指令，返回 SSE 流；断线后 run 继续跑 |
| `GET /api/runs/:id/stream?after=` | 重连：回放 + 续直播 |
| `GET /api/runs/:id/events` | 一次性回放 run 事件 |
| `POST /api/runs/:id/cancel` | 取消运行 |
| `POST /api/permissions/:id/decision` | 审批决定（allow / deny / allow_all） |
| `GET/PATCH /api/sessions/:id/permissions` | Session 权限模式与已授权工具 |
| `GET/POST/PATCH/DELETE /api/workspaces` | 工作区管理 |
| `GET /api/fs/directories` | 目录选择器 |
| `GET /api/changes`、`/api/changes/diff` | Git 未提交改动与单文件 diff |
| `GET /api/files`、`/api/files/content` | 目录懒加载与文本文件内容 |
| `POST /api/deploy` | 触发发布（默认关闭） |

SSE 每帧为 `{ runId, seq, event }`，`event` 是 `NormalizedEvent`：

```text
status | text_delta | thinking_delta | thinking_start | tool_use
tool_result | usage | turn_end | error | permission_request | question
```

完整端点表、请求体与错误形状见 [docs/protocol.md](docs/protocol.md) 的「HTTP / SSE 协议」；跨端传输契约的唯一真源是
`src/types/api.ts`。

## 安全

从客户端驱动一个带 shell 权限的 agent 本质等于远程代码执行。所有非 `/api/health` 路由都要
Bearer token（同一来源连续 5 次认证失败会冷却 60 秒，再犯翻倍；可用 `PABOOT_AUTH_MAX_FAILURES` /
`PABOOT_AUTH_LOCKOUT_SECONDS` 调整，`0` 关闭）；默认权限模式为 `ask`，审批超时未处理默认拒绝，手机断线不立即取消任务或拒绝审批；**`workspace` 只是 spawn cwd，
不是沙箱**。跨网络访问请先用组网工具（Tailscale / ZeroTier / WireGuard）把设备放进加密内网；
内网穿透只适合自用（详见根 README「手机电脑不在同一个局域网」）。详见
[docs/permissions.md](docs/permissions.md) 的「安全模型」。

## 安装

需 Node `~24` + 本机已装并配置至少一种 agent：Claude Code（`claude auth login`）、
Codex（`codex login`），或 DeepSeek Harness（Node `>=24.9`，`npm install -g @deepseek-ai/dsh`，
`DEEPSEEK_API_KEY` 或 `dsh web` 的模型设置）：

```bash
npx @noresign/paboot --help           # 免安装试用
npm install -g @noresign/paboot       # 装成全局命令（命令名仍是 paboot）
paboot --workspace /path/to/project
```

## License

Apache-2.0，见 [LICENSE](LICENSE)。
