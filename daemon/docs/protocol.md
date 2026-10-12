# daemon 技术方案 · 协议与数据模型

> 索引见 [daemon.md](daemon.md)

## 数据模型（SQLite）

数据根默认 `~/.paboot`（`--data-dir` 可改），下面有 `paboot.sqlite`、`token`
与 `daemon_runtime.json`（见运行信息）。

| 表 | 内容 |
|---|---|
| `sessions` | 会话：`id`、`runtime`、`native_session_id`、`workspace_id`、`permission_mode`、`cwd`、`title`、时间戳 |
| `workspaces` | 工作区**主目录**：`id`、`name`、`path`、`is_default`、`enabled`、时间戳 |
| `workspace_dirs` | 工作区**附加目录**（agent 可读写、该工作区所有会话继承）：`workspace_id`、`path`、`created_at`；随工作区级联删除 |
| `workspace_shortcut_dirs` | 文件 Tab 的**浏览书签**（`workspace_id`、`path`、`created_at`；随工作区级联删除）。与 `workspace_dirs` 刻意分开：书签**不授予 agent 任何权限**，只多一个可切换的 tab |
| `session_permission_grants` | Session 级「允许全部」授权：`session_id`、`tool_name`（普通工具名，或 MCP 的 `mcp__<server>__*`）、`created_at` |
| `settings` | 运行期可变配置：`key`、`value`、`updated_at` |
| `messages` | 对话转录：user prompt + assistant 聚合后的可见文本 |
| `runs` | 一次 spawn：`status`（running/succeeded/failed/cancelled）、`exit_code`、`error` |
| `events` | 归一化事件流，键 `(run_id, seq)`，用于断线重连回放 |
| `audit_log` | 审计：chat / cancel / permission_decision / 权限模式与 grant 变更 / session 重命名与删除 / config 更新 / workspace 增删改与目录、书签变更 / browse_root |
| `deploy_jobs` | 部署任务：`id`、`channel`、`target`、`status`、`unit`、`log_path`、时间戳、`exit_code`、`error` |

> `messages` 只是「聚合可见文本」；**工具卡、思考块、用量这些细节只存在 `events`**，
> 客户端重进会话时需用 `GET /api/runs/:id/events` 回放（Android 已实现）。

## HTTP / SSE 协议

| 方法 & 路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/health` | 否 | 存活 + 版本 + 默认 workspace 根目录 |
| `GET /api/config` | 是 | 全局默认权限模式、默认 Workspace、只读/重启级配置 |
| `PATCH /api/config` | 是 | 更新 `defaultPermissionMode` / `defaultWorkspaceId` |
| `GET /api/workspaces` | 是 | 工作区列表（含 sessionCount 与附加目录 `dirs`） |
| `POST /api/workspaces` | 是 | 新增工作区，`{name?, path}`，校验目录存在且路径未重复（允许嵌套，如根目录工作区下再建子目录工作区） |
| `PATCH /api/workspaces/:id` | 是 | 重命名 / 启停 / 设为默认 |
| `DELETE /api/workspaces/:id` | 是 | 删除工作区（只删注册信息，磁盘不动；级联清附加目录与书签）。`?cascade=1` 时连它的 Session 一起删，否则有 Session 就 409 `workspace_not_empty`；默认工作区一律 409 `workspace_is_default` |
| `POST /api/workspaces/:id/dirs` | 是 | 添加附加目录，`{path}`；校验存在 + 是目录，拒绝「等于主目录」/「已存在」 |
| `DELETE /api/workspaces/:id/dirs` | 是 | 移除附加目录，`{path}`（body；Retrofit 用 `@HTTP` 绕过 `@DELETE` 无 body 的限制） |
| `POST /api/workspaces/:id/shortcuts` | 是 | 加一个浏览书签，`{path}`；去重（主目录/附加目录/已有书签都算重复 → 409 `shortcut_exists`） |
| `DELETE /api/workspaces/:id/shortcuts` | 是 | 移除浏览书签，`{path}`；只删书签，不动任何授权 |
| `GET /api/fs/directories` | 是 | 目录选择器，`?path=<abs>&showHidden=`；**只列目录名，不读文件内容**，无工作区限制 |
| `GET /api/changes` | 是 | 某目录的 Git 未提交改动，`?workspaceId=&root=<abs>` |
| `GET /api/changes/diff` | 是 | 单文件 diff，`?workspaceId=&root=<abs>&path=<relative>` |
| `GET /api/files` | 是 | 单层目录懒加载，`?workspaceId=&root=<abs>&path=&cursor=&limit=&showHidden=&showIgnored=` |
| `GET /api/files/content` | 是 | 读取文本文件，`?workspaceId=&root=<abs>&path=<relative>`；有大小限制与二进制检测 |
| `GET /api/files/raw` | 是 | 原始字节流（图片/视频预览），同参数；不截断、不解码，支持 `Range`（206/416），按扩展名给 `Content-Type` |
| `GET /api/agent` | 是 | 探测 Claude Code（版本/认证/能力/models） |
| `GET /api/agents` | 是 | 已注册运行时列表 `{agents:[{id,name,bin,available}]}`（`available` = 本机是否装上） |
| `POST /api/deploy` | 是 | 提交部署任务，`{channel:'test'|'prod', target?:'auto'|'daemon'|'android'|'desktop'|'all'}` |
| `GET /api/deploy` | 是 | 最近部署任务列表 |
| `GET /api/deploy/:id` | 是 | 查询部署任务状态 |
| `GET /api/claude-sessions` | 是 | 列出指定 Workspace 内的 Claude 会话（`?workspaceId=`） |
| `POST /api/chat` | 是 | 发指令，返回 SSE 流。带 `commandId` 时幂等（重发重连到同一个 run）。该 Session 已有在跑的 run → 409 `session_busy`（见下文「一个 Session 同时只跑一个 Run」） |
| `GET /api/runs` | 是 | 当前运行中的 run 列表（`?workspaceId=` 过滤） |
| `POST /api/runs/:id/cancel` | 是 | 取消运行 |
| `GET /api/runs/:id/events` | 是 | 一次性回放 run 事件，`?after=<seq>` 续传游标 |
| `GET /api/runs/:id/stream` | 是 | SSE：先回放 `?after=<seq>` 后的事件，再续传直播（重连订阅） |
| `GET /api/sessions` | 是 | 会话列表（`?workspaceId=` 过滤；含 `running`/`runningRunId`） |
| `GET /api/sessions/:id` | 是 | 会话 + 消息 + 运行 |
| `PATCH /api/sessions/:id` | 是 | 重命名（body `{title}`） |
| `DELETE /api/sessions/:id` | 是 | 删除会话（先取消进行中的 run，级联删） |
| `GET /api/sessions/:id/permissions` | 是 | Session 权限模式 + 已授权工具 |
| `PATCH /api/sessions/:id/permissions` | 是 | 修改 Session 权限模式（仅对后续 Run 生效） |
| `DELETE /api/sessions/:id/permissions/grants/:toolName` | 是 | 撤销单个工具授权 |
| `DELETE /api/sessions/:id/permissions/grants` | 是 | 撤销全部工具授权 |
| `POST /api/permissions/:id/decision` | 是 | 工具审批决定（allow/deny/allow_all） |
| `POST /api/internal/permissions/create` | 是 | 内部：hook 注册审批请求 |
| `GET /api/internal/permissions/:id/status` | 是 | 内部：hook 轮询决定 |

**附加目录（`workspace_dirs`）与 `--add-dir`**：一个工作区 = 主目录 + N 个附加目录。
附加目录现在只有**一个来源**：手机在「工作区管理」里手动增删（早期版本还会在批准越界读取时
自动写入，该机制已随读取门控一并移除，见 [permissions.md](permissions.md) 的「读取不门控」）。

spawn 时把「主目录 + 附加目录」中**除 cwd 之外**的部分逐个传给 `claude --add-dir`。
`--add-dir <directories...>` 是**变长参数**，因此它必须排在 argv 最末；prompt 走 stdin
（`--input-format stream-json`），不是位置参数，这一点不能改。
存储在磁盘上已消失的目录在 spawn 时被过滤掉（`existingDirs`），但**不**从配置里静默删除。

Codex 在每次 `turn/start` 时将 cwd 和有效附加目录传入
`sandboxPolicy: { type: "workspaceWrite", writableRoots: [...] }`，保持网络默认受限；
新会话和续接会话都重新读取目录授权，因此增删授权在下一轮生效。书签不授予写权限。
`bypass` 使用 `dangerFullAccess`，不受这些目录限制。

**发出时机与 Claude 对齐**：`usage` 只在 `turn/completed` 发一次（Claude 是 `result` 帧）。
codex 每次模型调用都会推 `thread/tokenUsage/updated`，但中途只发「上下文占用」帧
（`usage: null` + `contextTokens`/`contextWindow`）——否则手机上会看到用量条在任务还没跑完时
就往上跳，和 Claude 行为不一致。

**上下文窗口占用**与 `usage` 是两回事，走 `usage` 事件上的两个**兄弟字段**（不在 `usage` 里）：

- `contextTokens`：当前装了多少（「下一次请求会重发多少输入」），客户端顶栏显示的就是它；
- `contextWindow`：窗口总容量，用来算百分比。**`null` = 占用已知、容量未知**（Claude Code
  从不报窗口，猜一个会给出错误的百分比）；**字段缺省 = 本帧不含此信息**，客户端保留上一个
  已知值。这两个语义必须区分，不要用 0 兜底。

| runtime | 占用算法 | 窗口 |
|---|---|---|
| codex | `thread/tokenUsage/updated` 的 `last.inputTokens`（已是最近一次请求的完整输入，含缓存部分） | `modelContextWindow` |
| claude | 最近一条主回合 assistant 消息的 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`（三段互不相交，故相加） | 无 |

claude 每来一条主回合 assistant 帧就发一次（值相同则跳过；子代理帧有自己的窗口，不参与），
`result` 帧带上最后一次的值以便历史重建确定性收尾。这些帧 `usage: null`，所以客户端不会
把它们当成本轮累计用量。

SSE 每帧 `{ runId, seq, event }`，`seq` 单调递增（重连游标）。`event` 是 `NormalizedEvent`：

```
status | text_delta | thinking_delta | thinking_start | tool_use
tool_result | usage | turn_end | error | permission_request | question
```

**流的不变量**：终局 `status` 之前，每个 `tool_use` 都有配对的 `tool_result`。run 可能在工具还没返回时
就结束（取消 / 崩溃 / 空闲看门狗），此时引擎补发一帧合成结果（`interrupted: true`、`isError: true`，
content 说明未返回结果）。客户端因此可以把「没有配对的 tool_use」一律当成"仍在运行"，不必各自兜底；
历史回放读到的也是同一份自洽的流。

`POST /api/chat` 请求体：`{ prompt, sessionId?, workspaceId?, claudeSessionId?, model?, runtime?, permissionMode?, commandId? }`。

- 新会话使用 `workspaceId`（缺省用默认 Workspace）作为 cwd；`permissionMode` 可选 `ask` / `acceptEdits` / `bypass`，缺省用 `default_permission_mode`。
- 续接已有会话沿用 Session 自己的 `workspace_id + cwd`，并**每次续接都重新校验**是否仍在该 Workspace 内，否则 400 `cwd_not_allowed`。
- `permissionMode` 是 Session 级配置，切换后只影响后续 Run。
- **幂等（`commandId`）**：客户端可为一次「发送」生成一个 `commandId` 并随重试一并发回。daemon 把
  它记在 `runs.command_id`（唯一）。同一个 `commandId` 再次到达时，**重连到它已经起的那个 run**
  （回放 + 续直播，等价于 `GET /api/runs/:id/stream`），而不是起第二个 run——覆盖「响应丢失后重发」
  和「弱网重试」两种场景。此检查排在 Session 守卫之前：重试无论原 run 仍在跑还是已结束都要重连。
  同一 `commandId` 用于**不同 Session** → 409 `command_id_conflict`。不传 `commandId` 则每次请求都起新 run（旧行为）。
- **一个 Session 同时只跑一个 Run**：该 Session 已有在跑的 run 时，请求返回 409
  `session_busy`（响应带 `runId`，即正在跑的那个）。否则第二个 run 会 `--resume` 同一个
  native session id，两个 agent 进程写同一份会话记录。客户端在 run 期间禁用发送只是礼貌，
  多端（桌面 + 手机）可能同时发出，所以由 daemon 兜底。此检查排在 runtime 探测之前，
  避免为必然被拒的请求去 spawn CLI。

**断线续接**：`/api/chat` 客户端断开后，run **继续在 daemon 上运行**（不因断线取消）；重连
用 `GET /api/runs` 找运行中的 run，再 `GET /api/runs/:id/stream?after=<seq>` 回放 + 续直播；
显式停止用 `POST /api/runs/:id/cancel`。**不同 Session 之间**多 run 并发无全局锁
（同一 Session 见上面的 409 守卫）。

## 会话与跨端续接

- Claude Code 的所有会话（TUI 与 headless）统一存 `~/.claude/projects/<cwd>/<id>.jsonl`，
  会话 id 就是文件名；`claude --resume <id>` 续接。
- daemon 自己生成 `--session-id`，续接用 `--resume`，并把该 id 存进 `sessions.native_session_id`
  ——这一列存的是**对应运行时自己的会话 id**：Claude 是 `--session-id` 生成的那个，Codex 是它的
  thread id（续接走 `thread/resume`）。
- `GET /api/claude-sessions` 枚举**workspace 内**的会话，客户端可「导入」一个 TUI 会话继续
  （`POST /api/chat` 带 `claudeSessionId`）。
- 双向互通：手机会话 → 电脑 `claude --resume <id>`；电脑 TUI 会话 → 手机导入继续。

## 运行信息文件（`daemon_runtime.json`）

**目的**：让同机的客户端（桌面端 / CLI / 部署脚本）不必猜端口就能找到本机 daemon。

写在 `<data-dir>/daemon_runtime.json`，在 server **开始接受连接之后**写入；退出
（`SIGTERM` / `SIGINT`）时删除。

```json
{
  "pid": 3087570,
  "startedAt": 1759930734000,
  "serverId": "8fa14743-5888-4f1f-9cfd-50d2fb934a84",
  "hostname": "ubuntu",
  "listen": "127.0.0.1:4780",
  "tls": false,
  "version": "1.7.0",
  "dataDir": "/home/renbin/.paboot",
  "tokenSource": "env"
}
```

| 字段 | 说明 |
|---|---|
| `pid` | daemon 进程号，用于存活判断 |
| `startedAt` | 本次启动时间（ms） |
| `serverId` | **该 daemon 的稳定身份**：首次启动生成、持久化在 `settings` 表，重启不变。用于「同一台机器换了地址（LAN / 隧道 / 以后的 relay）」时识别为同一个 host |
| `hostname` | 展示用 |
| `listen` | **可直接连接的** `host:port`。绑定 `0.0.0.0` / `::` 会翻译成 `127.0.0.1` / `[::1]`——原样给出是连不上的 |
| `tls` | 据此选 `http` / `https` |
| `version` | daemon 版本 |
| `dataDir` | 便于判断两个 daemon 是否共用同一个数据根 |
| `tokenSource` | 见 [configuration.md](configuration.md) 的「token 解析顺序」：**只有 `file` 时** `<data-dir>/token` 才是权威值 |

**约定**：

- **不含 token**（秘密只在 `<data-dir>/token`，0600），所以这个文件是 0644、可直接读。
- **文件存在 ⟹ 已在接受连接**：不存在「写了但还没 listen」的中间态，所以不需要
  `listen: null` 这种占位。
- **心跳就是 mtime**（没有 heartbeat 字段）：daemon 每 **30s** 刷新一次文件 mtime；
  读方以 **mtime 比现在老 90s 以上** 判为过期（崩溃 / 硬杀留下的残留文件）。
- ⚠️ **它是协调信息，不是权威**：被改过的地址、被复制的 `serverId`、被复用的 `pid`、
  地址抢占，都在它能保证的范围之外。所以存活判断要三条件同时成立——
  `mtime 新鲜` ∧ `pid 存活` ∧ `该地址的 /api/health 返回 paboot`。**鉴权仍然只认 token。**
- 数据根不可写时只 WARN、不影响启动；客户端的发现流程退化为试探候选地址。
