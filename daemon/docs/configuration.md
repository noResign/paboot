# daemon 技术方案 · 配置参数

> 索引见 [daemon.md](daemon.md)

## 配置参数参考

优先级：**命令行 flag > 已存在的 shell 环境变量 > `.env` 文件 > 默认值**。
所有变量都可用 `--env-file <path>` 指定 `.env` 加载（默认 `./.env`）。

### 命令行 flag

| flag | 默认 | 说明 |
|---|---|---|
| `--host <host>` | `0.0.0.0` | 监听地址；`127.0.0.1` = 仅本机 |
| `--port <port>` | `4780` | 端口（1–65535） |
| `--workspace <path>` | 当前目录 | 初始 Workspace 根目录。**显式传入时是权威值**：每次启动都确保该目录存在并设为默认 Workspace |
| `--data-dir <path>` | `~/.paboot` | 数据根（SQLite + token + `daemon_runtime.json`） |
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
| `PABOOT_DATA_DIR` | `~/.paboot` | 数据根 |
| `PABOOT_TOKEN` | 自动生成 | 鉴权密钥 |
| `PABOOT_PERMISSION_MODE` | `default` | 新 Session 默认权限模式的 seed；`default` 对应产品模式 `ask` |
| `PABOOT_PERMISSION_TIMEOUT_SECONDS` | `120` | 工具审批决策窗口（秒，超时自动拒绝；`0`/非法值回退 `120`） |
| `PABOOT_RUN_IDLE_TIMEOUT_SECONDS` | `900` | 空闲看门狗（无事件多少秒自动取消；`0` = 禁用） |
| `PABOOT_TLS_CERT` | 无 | TLS 证书路径（与 KEY 同设才启用 TLS） |
| `PABOOT_TLS_KEY` | 无 | TLS 私钥路径 |
| `PABOOT_ENV_FILE` | `./.env` | `.env` 路径（等价 `--env-file`） |
| `PABOOT_ALLOW_DEPLOY` | 关闭 | 允许 `POST /api/deploy` 触发部署（`1` / `true` 开启） |
| `PABOOT_DEPLOY_SCRIPT` | `<cwd>/../.claude/skills/deploy/scripts/deploy.sh` | 部署脚本路径 |

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
