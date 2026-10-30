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
| `--workspace <path>` | 当前目录 | 初始 Workspace 根目录。**显式传入时是权威值**：每次启动都确保该目录存在并设为默认 Workspace |
| `--token <token>` | 自动生成并持久化 | Bearer 鉴权密钥 |
| `--permission-mode <mode>` | `default` | 初始 Workspace 默认权限模式 seed（见下） |
| `--env-file <path>` | `./.env` | `.env` 文件路径 |
| `-h, --help` | — | 帮助 |
| `-v, --version` | — | 版本 |

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PABOOT_HOST` | `0.0.0.0` | 监听地址 |
| `PABOOT_PORT` | `4780` | 端口 |
| `PABOOT_WORKSPACE` | 当前目录 | 初始 Workspace 根目录（**首次启动注册一次**为默认 Workspace；显式 `--workspace` 才是每次生效的权威值） |
| `PABOOT_TOKEN` | 自动生成 | 鉴权密钥 |
| `PABOOT_AUTH_MAX_FAILURES` | `5` | 同一来源连续认证失败多少次后进入冷却；`0` = 关闭冷却 |
| `PABOOT_AUTH_LOCKOUT_SECONDS` | `60` | 首次冷却时长（秒）；同一来源再次触发翻倍，上限 15 分钟 |
| `PABOOT_PERMISSION_MODE` | `default` | 新 Session 默认权限模式的 seed；`default` 对应产品模式 `ask` |
| `PABOOT_PERMISSION_TIMEOUT_SECONDS` | `120` | 工具审批决策窗口（秒，超时自动拒绝；`0`/非法值回退 `120`） |
| `PABOOT_RUN_IDLE_TIMEOUT_SECONDS` | `900` | 空闲看门狗（无事件多少秒自动取消；`0` = 禁用） |
| `PABOOT_TLS_CERT` | 无 | TLS 证书路径（与 KEY 同设才启用 TLS） |
| `PABOOT_TLS_KEY` | 无 | TLS 私钥路径 |
| `PABOOT_ENV_FILE` | `./.env` | `.env` 路径（等价 `--env-file`） |
| `DEEPSEEK_API_KEY` | 无 | 透传给 `dsh acp` 的模型凭据；也可由 `dsh web` 写入 `~/.dsh/.credentials.yaml` |
| `PABOOT_ALLOW_DEPLOY` | 关闭 | 允许 `POST /api/deploy` 触发部署（`1` / `true` 开启） |
| `PABOOT_DEPLOY_SCRIPT` | `<cwd>/../.claude/skills/deploy/scripts/deploy.sh` | 部署脚本路径 |

### 内置 fallback 工作区

桌面端第一次启动 daemon 时会把 `--workspace` 预填为 `<dataDir>/defaultworkspace`
（默认即 `~/.paboot/defaultworkspace`）。daemon 按这个路径把该工作区标记为**内置 fallback**：

- 没有启用的真实工作区时，它是默认工作区；`/api/workspaces` 仍会返回它（客户端需要它的 id
  来拉会话/文件），但客户端渲染列表/切换器时会过滤掉它，用户看到的是「还没有工作区」；
- 一旦用户添加了真实工作区，它自动让位（默认切到真实工作区），接口也不再返回它；
  行和它下面的会话仍在库里，删掉最后一个真实工作区后会重新作为默认出现；
- 它不可删除、不可停用（409 `workspace_is_builtin`），是「永远至少有一个工作区」的兜底。

CLI 不带 `--workspace` 时仍然用 cwd，与内置 fallback 无关。

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

### token 解析顺序

先由 env 与文件决定「文件里的那个 token」：

1. `PABOOT_TOKEN` env → 直接使用，**不读也不写文件**；
2. 否则读 `<data-dir>/token`（存在且非空则复用，保证重启不变）；
3. 否则生成 64 位 hex（32 字节随机）写入 `<data-dir>/token`（0600）。

`--token` flag 是解析结果之上的覆盖值（优先于以上三步），但**它不会阻止第 2/3 步执行**：
env 未设且文件不存在时，第 3 步照样会写入一个本次新生成的值。

⚠️ 因此 `<data-dir>/token` 只在「本次没被 env / flag 覆盖」时才是权威值。**读它之前先确认
当前 token 的来源**——`daemon_runtime.json` 的 `tokenSource` 就是给这件事用的：只有 `file`
才可读该文件；`env` / `flag` 时读到的是旧值或本次新生成的值，拿去用必然 401。

删掉 `<data-dir>/token` 即轮换（下次启动重新生成，前提是没被 env / flag 覆盖）。

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
# PABOOT_TOKEN=
# PABOOT_TLS_CERT=/path/cert.pem
# PABOOT_TLS_KEY=/path/key.pem
```

### 定时任务

定时任务没有新增环境变量，以下行为固定：

- 调度器每 **30 秒**扫一次 `next_run_at`；daemon 停机/休眠错过的触发**直接跳过**，不补跑。
- 时区：创建任务时写入 daemon 当前的 IANA 时区，之后固定；不会随 daemon 迁移而改变语义。
- 定时 run 固定 `bypass`（客户端创建时警告）。
- `PABOOT_RUN_IDLE_TIMEOUT_SECONDS` 同样作用于定时 run 与命令任务：无输出/事件超时会取消。
- 限制（代码常量，非配置）：每会话 20 个任务；prompt ≤ 16 KiB；command ≤ 8 KiB；cron 必须 5 段。

详见 [scheduled-tasks.md](scheduled-tasks.md)。
