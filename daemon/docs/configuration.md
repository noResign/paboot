# daemon 技术方案 · 配置参数

> 索引见 [daemon.md](daemon.md)

## 配置参数参考

优先级：**命令行 flag > 已存在的 shell 环境变量 > `.env` 文件 > 默认值**。
所有变量都可用 `--env-file <path>` 指定 `.env` 加载（默认 `./.env`）。

> **路径类参数支持开头的 `~`**（`--workspace` / `PABOOT_WORKSPACE`，以及
> `POST /api/workspaces` 等的 `path` 字段），展开成 **daemon 进程所在机器**的用户主目录
> （只认 `~` 与 `~/`，不认 `~user`）。客户端把路径当**原始 argv / JSON** 交给 daemon，这条链路上
> 没有 shell——不展开的话 `~/x` 会被 `path.resolve` 当成相对路径，落到 daemon 的 cwd 下并被
> `mkdirSync` 静默建出来。
>
> **数据根不可配置**：固定 `~/.paboot`。这样 serverId`（首次启动生成、持久化在这个库的 settings 表里）
> 才是**这台机器上这个用户的稳定身份**，客户端才能认出「用不同地址连上的是同一台 daemon」。
>
> **同一数据目录同时只能跑一个 daemon**：启动时靠 `~/.paboot/paboot.lock` 单实例锁判定，
> 已有存活实例则拒绝启动（详见 [protocol.md](protocol.md) 的数据模型一节）。

### 命令行 flag

| flag | 默认 | 说明 |
|---|---|---|
| `--host <host>` | `0.0.0.0` | 监听地址；`127.0.0.1` = 仅本机 |
| `--port <port>` | `4780` | 端口（1–65535） |
| `--workspace <path>` | `~/.paboot/life` | 初始项目 Workspace 根目录。**显式传入时是权威值**：每次启动都确保该目录存在并设为默认 Workspace；不传时进入内置「个人空间」工作区 |
| `--token <token>` | 自动生成并持久化 | **operator** Bearer token；客户端连接时输入的就是它 |
| `--print-operator-token` | — | 打印 operator token 后退出；可在 daemon 已运行时使用，不抢数据目录锁 |
| `--permission-mode <mode>` | `default` | 初始 Workspace 默认权限模式 seed（见下） |
| `--env-file <path>` | `./.env` | `.env` 文件路径 |
| `-h, --help` | — | 帮助 |
| `-v, --version` | — | 版本 |

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PABOOT_HOST` | `0.0.0.0` | 监听地址 |
| `PABOOT_PORT` | `4780` | 端口 |
| `PABOOT_WORKSPACE` | `~/.paboot/life` | 初始项目 Workspace 根目录（**首次启动注册一次**为默认 Workspace；显式 `--workspace` 才是每次生效的权威值） |
| `PABOOT_TOKEN` | 自动生成 | operator Bearer token（客户端连接用） |
| `PABOOT_AUTH_MAX_FAILURES` | `5` | 同一来源连续认证失败多少次后进入冷却；`0` = 关闭冷却 |
| `PABOOT_AUTH_LOCKOUT_SECONDS` | `60` | 首次冷却时长（秒）；同一来源再次触发翻倍，上限 15 分钟 |
| `PABOOT_PERMISSION_MODE` | `default` | 新 Session 默认权限模式的 seed；`default` 对应产品模式 `ask` |
| `PABOOT_PERMISSION_TIMEOUT_SECONDS` | `120` | 工具审批决策窗口（秒，超时自动拒绝；`0`/非法值回退 `120`） |
| `PABOOT_RUN_IDLE_TIMEOUT_SECONDS` | `900` | 空闲看门狗（无事件多少秒自动取消；`0` = 禁用） |
| `PABOOT_MEMORY_MODEL` | 无 | 无 UI 部署的后台模型（记忆抽取 + 直连 runtime 的会话标题），格式 `<provider>:<model>`；设置页选择优先，未配置 = 仅记录 |
| `PABOOT_TLS_CERT` | 无 | TLS 证书路径（与 KEY 同设才启用 TLS） |
| `PABOOT_TLS_KEY` | 无 | TLS 私钥路径 |
| `PABOOT_ENV_FILE` | `./.env` | `.env` 路径（等价 `--env-file`） |
| `DEEPSEEK_API_KEY` | 无 | 透传给 `dsh acp` 的模型凭据；也可由 `dsh web` 写入 `~/.dsh/.credentials.yaml` |
| `PABOOT_ALLOW_DEPLOY` | 关闭 | 允许 `POST /api/deploy` 触发部署（`1` / `true` 开启） |
| `PABOOT_DEPLOY_SCRIPT` | `<cwd>/../.claude/skills/deploy/scripts/deploy.sh` | 部署脚本路径 |

### 内置「个人空间」工作区

不带 `--workspace` / `PABOOT_WORKSPACE` 时，daemon 默认进入 `<dataDir>/life`
（即 `~/.paboot/life`）的内置「个人空间」工作区。它是唯一内置工作区，客户端始终渲染为「个人空间」；
不可删除或停用，但可以设为默认、改名和管理附加目录。旧的 `<dataDir>/defaultworkspace`
fallback 已移除：启动时若发现空的历史行会清理，若该行仍有会话则降级为普通 dev 工作区以保留历史。

### 权限模式

产品模式的来源：

```text
--permission-mode / PABOOT_PERMISSION_MODE (seed)
  -> settings.default_permission_mode
  -> 新 Session 的 permission_mode
  -> Claude Code --permission-mode
```

| 产品模式 | Claude 参数 | 含义 |
|---|---|---|
| `ask` | `default` | **默认**。Write/Edit/Bash 修改类操作询问；只读 Bash 自动放行 |
| `acceptEdits` | `acceptEdits` | 自动接受文件编辑；Bash 等命令仍询问 |
| `bypass` | `bypassPermissions` | 完全放开（⚠️ 危险，需用户在手机上明确切换） |

### token 角色

只有 **operator token** 持久化、展示给用户；另外两个是 daemon 启动时随机生成的内部 token，
**不落盘、不进日志、不可配置**，每次启动轮换：

| 角色 | 谁用 | 权限 |
|---|---|---|
| `operator` | 客户端、本地 CLI、`--print-operator-token` | 全部 `/api/*` |
| `agent` | agent 运行时 / permission hook（`PABOOT_TOKEN`） | 公共 API 只读（GET/HEAD）+ `/api/internal/permissions/*` |
| `server` | MCP server 子进程（`PABOOT_TOKEN`） | 仅 `/api/internal/*` |

agent 的 Bash 能读到 agent token，但写公共端点一律 403；server token 只存在 MCP server 的
环境里，不在 agent 环境里。这不是 OS 沙箱：同用户的进程仍可读数据目录/`providers.json`；
run-scoped 细粒度 token 留到后续。

### operator token 解析顺序

先由 env 与文件决定「文件里的那个 token」：

1. `PABOOT_TOKEN` env → 直接使用，**不读也不写文件**；
2. 否则读 `<data-dir>/token`（存在且非空则复用，保证重启不变）；
3. 否则生成 64 位 hex（32 字节随机）写入 `<data-dir>/token`（0600）。

`--token` flag 是解析结果之上的覆盖值（优先于以上三步），但**它不会阻止第 2/3 步执行**：
env 未设且文件不存在时，第 3 步照样会写入一个本次新生成的值。

⚠️ 因此 `<data-dir>/token` 只在「本次没被 env / flag 覆盖」时才是权威值。**读它之前先确认
当前 token 的来源**——`daemon_runtime.json` 的 `tokenSource` 就是给这件事用的：只有 `file`
才可读该文件；`env` / `flag` 时读到的是旧值或本次新生成的值，拿去用必然 401。

删掉 `<data-dir>/token` 即轮换（下次启动重新生成，前提是没被 env / flag 覆盖）；agent / server
token 每次启动自动轮换，无需手动处理。

### 登录失败冷却

token 本身就是 256 位随机值，在线穷举不可行；冷却的作用是挡住扫描器、让反复猜测付出代价：

- 计数按**来源地址**（socket 对端 IP，**不信任 `X-Forwarded-For`**）分别统计；`/api/health` 不参与。
- 只有**带了非空 token 但校验失败**的请求才计数；完全没带 `Authorization` 的探测只回 401，不计。
- 同一来源**连续**失败达到 `PABOOT_AUTH_MAX_FAILURES`（默认 5）次后进入冷却，返回 `429`
  + `Retry-After`（JSON：`{error, code:"too_many_attempts", retryAfterSeconds}`），冷却期间即使
  带正确 token 也拒绝。
- 首次冷却 `PABOOT_AUTH_LOCKOUT_SECONDS`（默认 60 秒）；同一来源再次触发翻倍，上限 15 分钟。
  一次成功认证会清空该来源的计数与升级等级。
- 状态只在内存里，daemon 重启即清空；空闲 1 小时自动遗忘。正常客户端不会被误伤——成功请求
  不断重置计数；若确实连续输错被锁，等冷却结束或重启 daemon 即可。

### `.env` 示例

```ini
# 参考 daemon/.env.example
PABOOT_HOST=0.0.0.0
PABOOT_PORT=4780
PABOOT_WORKSPACE=/path/to/your/workspace
PABOOT_PERMISSION_MODE=default
PABOOT_RUN_IDLE_TIMEOUT_SECONDS=900
# PABOOT_MEMORY_MODEL=deepseek:deepseek-chat
# PABOOT_TOKEN=
# PABOOT_TLS_CERT=/path/cert.pem
# PABOOT_TLS_KEY=/path/key.pem
```

### 运行时配置（`~/.paboot/builtin.json`）

内置 runtime 的上下文/工具预算和 **daemon 级安全档位**集中在 `<data-dir>/builtin.json`，
**不是环境变量**。文件可选：不存在时全部使用代码默认值；只需写要覆盖的字段，其余按字段合并。
坏 JSON / 非法值 / 未知 key 会打 `warn` 日志并按字段回退默认值。**修改后重启 daemon 生效。**

```jsonc
{
  "version": 1,
  "securityProfile": "local",                // local（默认）| server-strict
  "allowLocalBypass": true,                  // local 档位下是否允许 bypass（默认 true）
  "allowServerBypass": false,                // server-strict 档位下是否允许 bypass（默认 false）
  "context": {
    "fallbackWindowTokens": 128000,          // 模型目录没有 contextWindow 时使用
    "systemPromptRatio": 0.04,               // 占模型窗口
    "maxSystemPromptTokens": 8000,
    "runtimeContextRatio": 0.10,
    "maxRuntimeContextTokens": 24000,
    "compaction": {
      "enabled": true,
      "triggerAt": 0.8,                      // 真实 contextTokens 达窗口 80% 时开始压缩
      "keepRecentRatio": 0.4,                // 保留最近约 40% 窗口的原文
      "minCompactTokens": 4000,              // 待摘要前缀不足这个数就跳过
      "maxSummaryTokens": 1024,              // 摘要本身的 token 上限
      "pruneOldToolResults": true,           // 先替换超大旧工具结果
      "toolResultPruneTarget": 0.6,          // 裁到 60% 以下就不再生成摘要
      "toolResultKeepBytes": 8192            // 只裁剪大于 8KB 的结果
    }
  },
  "projectDocs": {
    "shareOfRuntimeContext": 0.5,            // 项目文档最多占 runtime-context 的一半
    "maxTokens": 16000,
    "maxFileBytes": 32768                    // 单文件 I/O 安全上限
  },
  "tools": {
    "maxResultTokens": 8000,                 // 所有工具结果的统一上限（头尾保留）
    "read": {
      "maxFileBytes": 8388608,
      "defaultLimit": 2000,
      "maxLimit": 2000,
      "maxLineChars": 4000
    },
    "write": { "maxFileBytes": 8388608 },
    "edit": { "maxFileBytes": 8388608 },
    "bash": {
      "defaultTimeoutMs": 120000,
      "maxTimeoutMs": 600000,
      "maxOutputBytes": 32768,               // 单流超过后写 spill
      "envAllow": []                          // 额外透传的环境变量名
    },
    "grep": {
      "maxResults": 1000,
      "maxFileBytes": 8388608,
      "maxLineChars": 500
    },
    "glob": { "maxResults": 2000 },
    "spill": { "retentionDays": 7 }
  },
  "skills": {
    "maxFileBytes": 262144,
    "catalogDescriptionChars": 500
  },
  "web": {
    "fetch": {
      "enabled": true,
      "provider": "auto",                      // auto（无 key 回退本机）| provider | http（本机直连，可访问内网）
      "timeoutMs": 15000,
      "baseUrl": null                          // 只影响 provider 后端；默认 <provider origin>/v1/tools
    },
    "search": {
      "enabled": true,
      "timeoutMs": 15000,
      "baseUrl": null                          // 默认 <provider origin>/v1/tools
    }
  },
  "agent": { "maxSteps": 200, "maxToolCalls": 200 }
}
```

`web.fetch` 只影响 builtin 的 `WebFetch` 工具：

- 假设所有模型 provider 都提供抓取 API：`auto` 时只要当前 provider 有 API key，就用它的
  地址推导出 `POST <provider origin>/v1/tools/fetch`（返回 Markdown，在服务商侧抓取，
  公网限定、碰不到内网 / 回环）。**web 工具在 `/v1/tools` 下，不是 completions base 本身**——
  打到 `<base>/fetch` 会得到 404；自有路径布局用 `baseUrl` 覆盖。
- 三个取值：`auto` / `provider` / `http`。
  - `auto`：provider 后端可用就用它；**没有可用 key 时回退到本机后端**，并在日志里 warn
    （回退会扩大 agent 能触达的网络范围，必须留痕）。
  - `provider`：只用服务商后端。不可用时注册工具但调用报错，**不回退**——显式选择不该被
    悄悄改掉。
  - `http`：只用本机后端。
- `provider: "http"` 是**本机直连**后端：由 daemon 进程发出请求，**能访问内网与回环**，
  免 API Key、不计费。
  - 解码范围：`text/*`、`application/json`、`application/xml`（含 `+json` / `+xml`）原样返回；
    **HTML 转成 Markdown**（turndown + GFM 表格 / 删除线 / 任务列表）。PDF、图片等二进制拒绝。
  - HTML 转换有硬护栏：源字符上限 20 万；**嵌套超过 512 层拒绝转换**。转换是同步的
    （阻塞事件循环、定时器无法触发），深层嵌套呈超线性，所以这道护栏是必需项而非调优项。
  - 同源重定向最多 3 跳；跨源重定向直接拒绝（要抓就再发一次调用）。
  - URL 上限 2048 字符、拒绝带凭证的 URL；响应上限 2 MiB / 20 万字符（超长按字节截断，
    声明 `Content-Length` 超限则直接拒绝）。
  - 不带 cookie、不带 `Authorization`，只有固定 `user-agent` 与 `accept`。
- 显式 `provider` 不可用时**不回退**，由调用返回 tool error；`auto` 才会回退（并记 warn）。

`web.search` 只影响 builtin 的 `WebSearch` 工具：同样假设 provider 提供
`POST <provider origin>/v1/tools/search`（在服务商侧搜索，碰不到内网 / 回环），返回标题、
URL 与摘要，**不返回整页正文**——读正文仍交给 `WebFetch`。它**没有本机后端**，所以没有
`auto` 回退：当前 provider 没有 API key 或地址无法推导时不注册该工具。自有路径布局用
`baseUrl` 覆盖。

每次 run 按当前模型的 `contextWindow` 推导（缺省回退 `fallbackWindowTokens`）：

```
systemTokens      = min(ceil(window × systemPromptRatio), maxSystemPromptTokens)
runtimeTokens     = min(ceil(window × runtimeContextRatio), maxRuntimeContextTokens)
projectDocsTokens = min(ceil(runtimeTokens × shareOfRuntimeContext), projectDocs.maxTokens)
```

- 128K 窗口：system ≈ 5,120 / runtime ≈ 12,800 / 项目文档 ≈ 6,400 tokens。
- 预算单位是 **tokens**，不是字符；中英文混排按 CJK 感知的保守估算，并用每次模型调用
  返回的真实 `contextTokens` 自动校准比例（按 `provider:model` 学习，进程内有效）。
- 工具结果在写事件 / transcript 前按 `maxResultTokens` 截断（保留头尾）。
- **自动压缩**：上一次模型调用的真实 `contextTokens` 达到 `triggerAt × window` 时，先从最新消息
  往回按 turn 累加，保留约 `keepRecentRatio × window` 的原文；然后把更早、超过
  `toolResultKeepBytes` 的工具结果换成占位（保留 spill 路径）。如果这样已降到
  `toolResultPruneTarget × window` 以下就不做摘要；否则把更早的前缀交给同一个 provider 生成
  ≤`maxSummaryTokens` 的摘要，写入 `native_compactions`（原始 transcript 不删）。待摘要前缀
  小于 `minCompactTokens` 时直接跳过；摘要失败只记 warning，不中断 run。
- **prompt cache**：显式缓存断点当前**关闭**（不发 `cache_control`，也不设 `promptCache`）。
  system 仍按 stable → dynamic → 历史摘要 的顺序排列，动态内容在尾部；以后要开缓存时，
  只需恢复 stable 段与最后一条消息的断点。OpenAI / DeepSeek 始终依赖稳定前缀。

#### 安全档位（daemon 全局）

`securityProfile` 和两个 bypass 开关对所有 runtime 生效；只有**当前档位对应的开关**起作用，
另一个保留下来，切换档位时不会丢失。降级统一发生在 `startSessionRun`，不依赖各 runtime 自己判断。
旧字段 `allowBypass` 仍可读，会同时写入两个开关并打 deprecation warning。

| | `local`（默认，单用户本机） | `server-strict`（服务器部署） |
|---|---|---|
| 读 | 不受路径限制、不审批（OS 权限边界） | 仅 workspace 根 + 知识根 |
| 写/执行 | 仅 workspace 根 + 附加目录（dev 知识根也作为附加目录）；**按 session 权限模式审批**（ask 询问 / acceptEdits 放行编辑 / bypass 放行） | 同左，且仅限授权根 |
| workspace 外写入 | 路径拒绝（除非 bypass 被允许并被选中） | 路径拒绝（除非 allowServerBypass=true 且选中 bypass） |
| `bypass` | 受 `allowLocalBypass` 控制（默认允许） | 受 `allowServerBypass` 控制（默认**静默降级为 `acceptEdits`**） |
| daemon 敏感文件 | 不在 grant 内（写拒绝） | 硬拒绝 `token` / `paboot.sqlite*` / `providers.json` / `builtin.json` / `paboot.lock` / `attachments`，即使工作区重叠也不放行 |
| 定时任务 | 以 bypass 运行 | 以 bypass 请求，但同样降级为 `acceptEdits`（Bash/MCP 无人审批时会超时拒绝） |
| 外部 runtime（Claude/Codex/DeepSeek） | 按原权限模式 | 同样禁止 bypass；各自的沙箱/审批继续生效 |

注意：`server-strict` 是**应用层**约束，不是完整沙箱。外部 runtime、MCP 子进程、
未来 Bash 的 OS 级隔离仍需独立用户 / 容器 / 只读挂载；bypass 是管理员显式打开的
全权限逃生门（`allowLocalBypass` / `allowServerBypass`），开启后不再受上面的路径硬拒绝约束。

### 定时任务

定时任务没有新增环境变量，以下行为固定：

- 调度器每 **30 秒**扫一次 `next_run_at`；daemon 停机/休眠错过的触发**直接跳过**，不补跑。
- 时区：创建任务时写入 daemon 当前的 IANA 时区，之后固定；不会随 daemon 迁移而改变语义。
- 定时 run 固定 `bypass`（客户端创建时警告）。
- `PABOOT_RUN_IDLE_TIMEOUT_SECONDS` 同样作用于定时 run 与命令任务：无输出/事件超时会取消。
- 限制（代码常量，非配置）：每会话 20 个任务；prompt ≤ 16 KiB；command ≤ 8 KiB；cron 必须 5 段。

详见 [scheduled-tasks.md](scheduled-tasks.md)。
