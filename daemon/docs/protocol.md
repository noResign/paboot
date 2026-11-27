# daemon 技术方案 · 协议与数据模型

> 索引见 [daemon.md](daemon.md)

## 数据模型（SQLite）

数据根固定 `~/.paboot`（不可配置），下面有 `paboot.sqlite`、`token`、
`daemon_runtime.json`（见运行信息）与 `paboot.lock`。

**`paboot.lock` —— 单实例锁**：同一数据目录同时只允许一个 daemon。启动时用 `O_EXCL` 原子创建，
内容包括 `{pid, startedAt}`；拿不到且持有者 pid 仍存活就**拒绝启动**（退出码 1，日志给出 pid），
持有者已死的僵死锁会被接管（那正是「进程确实死了」的情形，此时 boot 时的
`interruptOrphanedRuns` 才成立）。正常退出（SIGTERM/SIGINT）会删掉它。

| 表 | 内容 |
|---|---|
| `sessions` | 会话：`id`、`runtime`、`kind`（`chat` / `command`，后者是命令任务的隐藏会话）、`purpose`（`task_config` / `peer`；后者是跨机运行用的隐藏会话）、`native_session_id`、`workspace_id`、`end_id`（主端，P0 只加列，暂为 `NULL`）、`memory_mode`（默认 `normal`；P0 只加列）、`permission_mode`、`model`（建会话时选择的模型，`NULL` = 沿用 CLI 默认）、`model_parameters`（JSON 对象，通用模型参数如 `{"reasoningEffort":"high"}`）、`cwd`、`title`、时间戳 |
| `workspaces` | 工作区：`id`、`name`、`path`（主目录）、`is_default`、`is_builtin`、`enabled`、`family`（`dev \| life`，默认 `dev`）、`profile_mode`（`off \| portable \| full`，默认 `portable`，仅 life 有意义）、`life_readable`（dev 专用，默认 `0`）、时间戳 |
| `ends` | 工作区里的端（P0 只落表与约束，CRUD 留到 S2/S3）：`id`、`workspace_id`、`family`（必须等于所属工作区）、`kind`、`name`、`status`、`archived_at`。DB trigger 拒绝 family 不匹配；partial unique index 保证一个工作区只有一个 `family=life` 的端。`end_roots` 存端与目录的绑定 |
| `end_roots` | 端引用的目录：`(end_id, path)`；life 端不绑定 end_roots（life 工作区的附加目录仍写 `workspace_dirs`，与 dev 同一套授权） |
| `memory_settings` | 记忆开关按 workspace 一行：`workspace_id`、`enabled`（默认关）、`injection_enabled`、`provider_override`、`updated_at`（M1 使用，P0 建表） |
| `notification_outbox` / `deletion_outbox` | 提醒 / 删除 outbox（M1/M3 使用，P0 建表；主库仍是唯一通知链路） |
| `workspace_dirs` | 工作区**附加目录**（agent 可读写、该工作区所有会话继承）：`workspace_id`、`path`、`created_at`；随工作区级联删除 |
| `workspace_shortcut_dirs` | 文件 Tab 的**浏览书签**（`workspace_id`、`path`、`created_at`；随工作区级联删除）。与 `workspace_dirs` 刻意分开：书签**不授予 agent 任何权限**，只多一个可切换的 tab |
| `session_permission_grants` | Session 级「允许全部」授权：`session_id`、`tool_name`（普通工具名，或 MCP 的 `mcp__<server>__*`）、`created_at` |
| `settings` | 运行期可变配置：`key`、`value`、`updated_at` |
| `messages` | 对话转录：user prompt + assistant 聚合后的可见文本；`agent_id` / `turn_id` / `task_id` 记录发言人归属，`source='peer'` 表示这段文本来自另一台 daemon（**永不进记忆**），`committed_seq` 是时间线位置（NULL = 尚未定稿） |
| `runs` | 一次 spawn：`status`（running/succeeded/failed/cancelled）、`exit_code`、`error`、实际使用的 `model` / `model_parameters`、`task_id`、`trigger`（`user\|scheduled\|run_now\|peer`）、`permission_mode`、`agent_id` / `thread_id` / `turn_id`（产生这一轮的 agent 与对话）、`peer_id` / `client_run_id`（B 侧幂等键，按 peer 唯一）/ `remote_run_id`（对端 run，用于取消与对账） |
| `scheduled_tasks` | 定时任务：任务类型/目标会话/工作区/runtime、prompt 或 command、`cron_expr` + `timezone` + `schedule_preset`、`next_run_at`、执行状态、`enabled` / `disabled_reason`、`created_by`（见 [scheduled-tasks.md](scheduled-tasks.md)） |
| `events` | 归一化事件流，键 `(run_id, seq)`，用于断线重连回放；`session_id` / `room_seq` 是房间流的游标（同一行，不重复写） |
| `audit_log` | 审计：chat / cancel / permission_decision / 权限模式与 grant 变更 / session 重命名与删除 / config 更新 / workspace 增删改与目录、书签变更 / browse_root |
| `deploy_jobs` | 部署任务：`id`、`channel`、`target`、`status`、`unit`、`log_path`、时间戳、`exit_code`、`error` |
| `exposed_agents` | 跨机授权：`agent_id`、`contract_json`（整份合同）、`enabled`、时间戳；一个 agent 一份 |
| `peers` | 一条连接对应一个 agent：`id`（本地连接 id）、`direction`（`in` / `out`）、`server_id`（对端 serverId）、`remote_agent_id`（out 必填）、`label`、`base_url`、`fingerprint`、`token_cipher`（出站 token）、`last_seen_at`、`created_at`。出站连接由 daemon 后台每 60s 自动探活刷新 `last_seen_at`（启动即探一次）；agent 的 `available` 以「5 分钟内见过」判定在线 |
| `peer_tokens` | 入站 guest 凭证：只存 `token_hash`、`scopes`（**一个** agentId）、`expires_at`（v1 为 NULL：邀请过期不等于连接过期，直到吊销）、`revoked_at`（吊销不删行） |
| `peer_invites` | 一次性邀请：`token_hash`、`agent_ids`、`expires_at`、`consumed_at`；默认 24h、单次 |
| `peer_threads` | B 生成的 `thread_key` → 本机隐藏会话：`(peer_id, thread_key)` 主键、`agent_id`、`session_id`；同一个 key 不能挪给另一个 agent |

> `messages` 只是「聚合可见文本」；**工具卡、用量这些细节只存在 `events`**，
> 客户端重进会话时需用 `GET /api/runs/:id/events` 回放（Android 已实现）。
> 思考正文不落库也不回放，只有 `thinking_start` 用于思考卡片的转圈状态。

## HTTP / SSE 协议

| 方法 & 路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/health` | 否 | 存活 + 版本 + 默认 workspace 根目录 + `serverId`（见下） |
| `GET /api/config` | 是 | 全局默认权限模式、默认 Workspace、只读/重启级配置；`workspaces` 与 `defaultWorkspaceId` 都只反映可见工作区 |
| `PATCH /api/config` | 是 | 更新 `defaultPermissionMode` / `defaultWorkspaceId`（任何启用的工作区都可设为默认，包括 life） |
| `GET /api/workspaces` | 是 | 工作区列表（含 `family` / `profileMode` / `lifeReadable` / `defaultRuntime` / `defaultPermissionMode`、sessionCount 与附加目录 `dirs`）。所有工作区都会返回；`family=life` 是唯一内置工作区，客户端必须渲染成「个人空间」入口 |
| `POST /api/workspaces` | 是 | 新增工作区，`{name?, path}`，校验目录存在且路径未重复（允许嵌套，如根目录工作区下再建子目录工作区）。第一条真实工作区自动成为默认 |
| `PATCH /api/workspaces/:id` | 是 | 重命名 / 启停 / 设为默认 / 设置新建会话默认 `defaultRuntime` / `defaultPermissionMode`（`null` 清除 = 跟随全局）。life 工作区可改名、配置和设为默认；停用 → 409 `workspace_is_life` |
| `DELETE /api/workspaces/:id` | 是 | 删除工作区（只删注册信息，磁盘不动；级联清附加目录与书签）。`?cascade=1` 时连它的 Session 一起删，否则有 Session 就 409 `workspace_not_empty`。删除默认工作区时先把默认切给另一个启用的工作区，没有就切给「个人空间」；个人空间不可删（409 `workspace_is_life`），因此「零工作区」不可达 |
| `POST /api/workspaces/:id/dirs` | 是 | 添加附加目录，`{path}`；校验存在 + 是目录，拒绝「等于主目录」/「已存在」。dev / life 都适用 |
| `DELETE /api/workspaces/:id/dirs` | 是 | 移除附加目录，`{path}`（body；Retrofit 用 `@HTTP` 绕过 `@DELETE` 无 body 的限制） |
| `POST /api/workspaces/:id/shortcuts` | 是 | 加一个浏览书签，`{path}`；去重（主目录/附加目录/已有书签都算重复 → 409 `shortcut_exists`） |
| `DELETE /api/workspaces/:id/shortcuts` | 是 | 移除浏览书签，`{path}`；只删书签，不动任何授权 |
| `GET /api/workspaces/:id/knowledge` | 是 | K0 知识列表；`?endId=&kind=&status=&verified=&q=` 过滤（`endId=workspace` 表示工作区级；`verified=true/false` = 已/未人工核验）。文件自动收录 |
| `GET /api/workspaces/:id/knowledge/:kid` | 是 | 知识详情：元数据 + `body` + `absolutePath`（正文真源仍是磁盘文件） |
| `POST /api/workspaces/:id/knowledge` | 是 | 人工新建知识，直接 `confirmed/curated`；按 kind 落盘（requirement→`requirements/`、convention→`conventions/`、其余 `knowledge/`）；已存在 workspace convention 时 409 `knowledge_convention_exists`。body `{title,body,kind?,endId?,tags?,summary?}` |
| `PATCH /api/workspaces/:id/knowledge/:kid` | 是 | 编辑知识，保存后保持 `confirmed`；body 同上字段可选 |
| `POST /api/workspaces/:id/knowledge/:kid/verify` | 是 | `{verified:boolean}`；切换人工核验标记（`curated`/`derived`），不改文件、不影响注入 |
| `DELETE /api/workspaces/:id/knowledge/:kid` | 是 | **永久删除**文件（不可恢复）；同时清理空的 end 目录 |
| `GET /api/workspaces/:id/knowledge/export` | 是 | 导出 ZIP（识别到的 markdown + `.meta.json`） |
| `GET /api/fs/directories` | 是 | 目录选择器，`?path=<abs>&showHidden=`；**只列目录名，不读文件内容**，无工作区限制 |
| `GET /api/changes` | 是 | 某目录的 Git 未提交改动，`?workspaceId=&root=<abs>` |
| `GET /api/changes/diff` | 是 | 单文件 diff，`?workspaceId=&root=<abs>&path=<relative>` |
| `GET /api/files` | 是 | 单层目录懒加载，`?workspaceId=&root=<abs>&path=&cursor=&limit=&showHidden=&showIgnored=`；响应里的 `parent`：根目录为 `null`，一级目录为 `""`（父目录即根），更深为父目录的相对路径 |
| `GET /api/files/content` | 是 | 读取文本文件，`?workspaceId=&root=<abs>&path=<relative>`；有大小限制与二进制检测 |
| `GET /api/files/raw` | 是 | 原始字节流（图片/视频预览），同参数；不截断、不解码，支持 `Range`（206/416），按扩展名给 `Content-Type` |
| `GET /api/agent` | 是 | 探测 Claude Code（版本/认证/能力/models） |
| `GET /api/agents` | 是 | 已注册运行时列表 `{agents:[{id,name,bin,available}]}`（`available` = 本机是否装上） |
| `GET /api/agents/:id/models` | 是 | 某运行时的模型目录 `{models:[{id,label,parameters?,supportsImages?}]}`。`parameters` 是该模型支持的可调参数（如 `{id:"reasoningEffort",label,values,defaultId?}`）；`supportsImages=false` 表示不能接收图片。Claude 用静态别名（**探测到 `--effort` 才带 reasoningEffort**）；Codex 短启 app-server 调 `model/list`（映射 `supportedReasoningEfforts`）；DeepSeek 用默认路由的静态目录（ACP 不透明选择器 + `off/low/high/max`）。Registry 缓存 5 分钟（失败 30 秒） |
| `POST /api/sessions` | 是 | 创建会话；**可选**在同一请求里发出首条 turn。body `{workspaceId?, runtime?, agentId?, permissionMode?, model?, modelParameters?, title?, prompt?, mentions?, commandId?, attachmentIds?}`；`agentId` 表示直接和这个助手对话（它成为 leader，`runtime` 由它决定，peer 也可作为 1:1 leader 但不召唤其他助手）。不带 `prompt` → 只建会话，返回 `{session}`；带 `prompt` → 复用 `/turns` 的校验与派发，返回 `{session, turn}`（`turn` 形状同 `/turns` 的 202）。首条 turn 被拒时回滚该会话并返回对应 4xx。老 daemon 会忽略 `prompt`，客户端据此回退到 `/turns` |
| `PATCH /api/sessions/:id/model` | 是 | 切换该会话后续 run 使用的模型/参数，body `{model?: string\|null, modelParameters?: object\|null}`（至少给一个；`null` = 回到默认）。省略的字段保持原值。正在运行的 run 不受影响，返回 `{ok, effective:"next_run", session}` |
| `POST /api/deploy` | 是 | 提交部署任务，`{channel:'test'|'prod', target?:'auto'|'daemon'|'android'|'desktop'|'all'}` |
| `GET /api/deploy` | 是 | 最近部署任务列表 |
| `GET /api/deploy/:id` | 是 | 查询部署任务状态 |
| `POST /api/chat` | 是 | **兼容/自动化入口**：发指令并直接返回该 run 的 SSE。新交互客户端应使用 `POST /api/sessions` + `/turns` + 房间流；单 agent 只是只有一个 leader 的房间。body 可带 `attachmentIds`（≤8 张图片）。带 `commandId` 时幂等。该 Session 已有在跑的 run → 409 `session_busy` |
| `POST /api/attachments` | 是 | raw body 上传图片（png/jpeg/webp/gif，≤10MB），返回 `AttachmentDto` |
| `GET /api/attachments/:id` | operator | 取图片字节；agent token 拒绝 |
| `GET /api/runs` | 是 | 当前运行中的 run 列表（`?workspaceId=` 过滤） |
| `POST /api/runs/:id/cancel` | 是 | 取消运行 |
| `GET /api/runs/:id/events` | 是 | 一次性回放 run 事件，`?after=<seq>` 续传游标 |
| `GET /api/runs/:id/stream` | 是 | SSE：先回放 `?after=<seq>` 后的事件，再续传直播（重连订阅） |
| `GET /api/sessions` | 是 | 会话列表（`?workspaceId=` 过滤；含 `running`/`runningRunId`） |
| `GET /api/sessions/:id/ends` | 是 | 会话端集合（primaryEndId + ends，含 role/summary） |
| `PUT /api/sessions/:id/ends` | 是 | `{endIds: string[] \| null}`；收窄端集合，空/null 回到工作区默认 |
| `GET /api/sessions/:id/events` | 是 | SSE：会话级提示流。首帧 `state`（含 `runningRunId`）后推 `run_started` / `run_finished` / `session_updated`（标题变化）。不持久化，重连以 `state` 为准 |
| `GET /api/sessions/:id` | 是 | 会话 + 消息 + 运行 |
| `PATCH /api/sessions/:id` | 是 | 重命名（body `{title}`） |
| `DELETE /api/sessions/:id` | 是 | 删除会话（先取消进行中的 run，级联删） |
| `GET /api/sessions/:id/permissions` | 是 | Session 权限模式 + 已授权工具 |
| `PATCH /api/sessions/:id/permissions` | 是 | 修改 Session 权限模式（仅对后续 Run 生效） |
| `DELETE /api/sessions/:id/permissions/grants/:toolName` | 是 | 撤销单个工具授权 |
| `DELETE /api/sessions/:id/permissions/grants` | 是 | 撤销全部工具授权 |
| `GET /api/scheduled-tasks` | 是 | 定时任务列表（`?workspaceId=&sessionId=` 过滤） |
| `POST /api/scheduled-tasks` | 是 | 创建定时任务（AI 绑定已有/新建会话；命令绑定工作区；`schedule` 用预设或 5 段 cron） |
| `GET /api/scheduled-tasks/:id` | 是 | 任务详情 + 最近 20 条 run |
| `PATCH /api/scheduled-tasks/:id` | 是 | 改名 / prompt / command / 计划 / 启停 |
| `DELETE /api/scheduled-tasks/:id` | 是 | 删除任务；命令任务连带删除隐藏会话 |
| `POST /api/scheduled-tasks/:id/run-now` | 是 | 立即运行（不推进计划）；会话忙 → 409 |
| `POST /api/scheduled-tasks/config-session` | 是 | 打开/创建该 workspace 的 AI 配置会话并起一条配置 run（每 workspace 复用） |
| `POST /api/internal/mcp/schedule-task` | 是 | 内部：agent 创建任务；`target.mode=current/existing/new`，只收 `runId` |
| `GET /api/internal/mcp/scheduled-tasks` | 是 | 内部：agent 查看当前会话的任务 |
| `POST /api/internal/mcp/scheduled-tasks/:id/cancel` | 是 | 内部：agent 取消当前会话的任务 |
| `GET /api/internal/mcp/sessions` | 是 | 内部：列出当前 workspace 的会话，供 agent 选择已有会话目标 |
| `POST /api/permissions/:id/decision` | 是 | 工具审批决定（allow/deny/allow_all） |
| `POST /api/internal/permissions/create` | 是 | 内部：hook 注册审批请求 |
| `GET /api/internal/permissions/:id/status` | 是 | 内部：hook 轮询决定 |

鉴权失败返回 `401 unauthorized`；同一来源连续失败触发冷却时返回 `429 too_many_attempts`，
并带 `Retry-After`（秒）。触发条件与时长见 [configuration.md](configuration.md) 的「登录失败冷却」。

**附加目录（`workspace_dirs`）与 `--add-dir`**：一个工作区 = 主目录 + N 个附加目录。
`workspace_dirs` 现在只有**一个来源**：手机在「工作区管理」里手动增删（早期版本还会在批准越界读取时
自动写入，该机制已随读取门控一并移除，见 [permissions.md](permissions.md) 的「读取不门控」）。

运行时还会把 **dev 工作区的知识根** `<dataDir>/workspaces/<id>/` 自动加入本次 run 的附加目录
（`run-service.extraDirsForRun`）。它不是 `workspace_dirs` 行，不出现在工作区目录管理里；
支持的 runtime 直接据此 Read/Write，DeepSeek 因 ACP 不接受 `additionalDirectories` 走提权审批。

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
| claude | **最近一次请求**的三个输入桶之和（`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，三段互不相交故相加） | 无 |

Claude 这条的取值来源有讲究，按可靠性排：

1. `stream_event` → `message_start` → `message.usage`：**原生 API 事件**，一次请求一个，最可靠。
   但它没有 parent id，所以只是**按 message id 暂存**，等对应的 `assistant` 帧到了、确认是主回合
   （而非子 agent——子 agent 有自己的窗口）才采用。
2. `assistant` 帧的 `message.usage`：同一个值，但**有些 CLI 版本会漏带**（于是要靠上面那条兜）。

⚠️ **绝不要用 `result` 帧的 `usage` 当占用**：那是**整次 query 的累计值**——它旁边就摆着
`num_turns` 和 `modelUsage`，工具调用循环里每一次请求都算进去。一次长 agentic run 能累到百万级，
曾经因此在客户端显示过「上下文 10M+」。那一帧的 `usage` 只作为该 run 的**用量/成本**信息转发。

claude 每来一条主回合 assistant 帧就发一次（值相同则跳过；子代理帧有自己的窗口，不参与），
`result` 帧带上最后一次的值以便历史重建确定性收尾。这些帧 `usage: null`，所以客户端不会
把它们当成本轮累计用量。

SSE 每帧 `{ runId, seq, event }`，`seq` 单调递增（重连游标）。`event` 是 `NormalizedEvent`：

```
status | text_delta | thinking_start | tool_use
tool_result | usage | turn_end | context_compacted | error | permission_request | question
```

`context_compacted` 只有 builtin 会发：自动压缩更早历史后报告 `beforeTokens` / `afterTokens`
（估算值）。它不产生聊天消息，客户端渲染成一行系统提示；历史重建时不会回放（压缩是内部动作）。

**会话级事件流**（`GET /api/sessions/:id/events`）与 run 流是两条不同的连接。它的 data 直接是
`SessionEvent`，不带 `{runId, seq}` 信封，也不落库：

| `type` | 载荷 | 客户端动作 |
|---|---|---|
| `state` | `session: SessionDto` | 连接/重连后的权威快照：对标题、`runningRunId` |
| `run_started` | `run: SessionRunBrief` | 该会话在别处开始了 run：若本地没在跑，追加用户消息 + 助手占位并 attach 到 `run.id` |
| `run_finished` | `run: SessionRunBrief` | 结束提示；已 attach 到该 run 时以 run 流终局为准 |
| `session_updated` | `sessionId, title` | 标题变化（首轮自动生成或另一端重命名），原地更新标题/会话列表 |

自动标题在会话首轮生成：builtin 用本次 run 的模型，直连 runtime 用后台模型
（`memory_model`）。本流只是把结果推给所有打开该会话的客户端。

**`question` 有两种回答通道**：

- Claude 等 headless runtime：事件不带 `permissionId`；工具已被自动拒绝，客户端把用户的选择
  作为**下一条消息**发出去。
- builtin / Codex：事件带 `permissionId`，run 阻塞在这个工具调用上。客户端用
  `POST /api/permissions/:id/decision` 回答，结构化答案按 question id 分组：

  ```json
  { "decision": "allow",
    "response": { "answers": { "q1": { "answers": ["yes", "其他：自定义"] } } } }
  ```

  daemon 把结果回填给工具/RPC（builtin 会把它格式化成可读的 `tool_result`），模型在同一个
  run 里继续。超时 / 拒绝时工具返回错误结果，让模型自己决定下一步。builtin 仍兼容旧的
  `response: { "answer": string }`。

**结算状态与答案都会持久化**：permission 解析时 daemon 把对应 `question` 事件的 payload 写上

| 字段 | 内容 |
|---|---|
| `answerStatus` | `allowed` / `denied` / `timed_out`（`permission_request` 则写最终 `status`） |
| `answers` | 用户选的选项，**按 question id 归键**：`{ "q1": ["方案 A", "其他：自定义"] }`。结构化答案从决策请求的嵌套形状扁平成这一层，客户端不用再解一层 |
| `answerText` | 纯文本答案（老客户端的 `{ "answer": ... }` 形状）。与 `answers` 互斥地出现 |

只写状态是不够的：卡片重进会话时只能显示「已发送答案」，选项一片空白，用户得翻回对话才能
想起自己选了什么。所以**答案必须一起落库**，三端在重放时用它把选项标回勾选态，并把「其他」
的输入框填回原文；不在 `options` 里的 label 按「其他」还原，不当成不存在的选项。
老 daemon 没有这两个字段，客户端据此回落到「已发送答案」即可（只加不改）。

拒绝和超时要分别显示，不能都叫「已回答」。没有 `permissionId` 的 runtime 由客户端按
“问题是否还属于当前一轮”决定是否可答。

`QuestionDto.id` 只有阻塞式通道需要；Codex 自带，builtin 由 daemon 生成（`q0`、`q1`…）。

**思考内容不下发**：运行时产生的 `thinking_delta` 在 run service 里直接丢弃——既不落库也不进
SSE。客户端靠 `thinking_start` 生成一张不可展开的思考卡片（标题行转圈），收到下一条内容事件
（文本 / 工具 / 提问 / 终局）时停止转圈。历史回放同样在 SQL 层排除旧的 `thinking_delta` 行
（数据保留在库中，不再传输），否则长会话一次重建就是几十万帧。`thinking_delta` 仍保留在事件
类型里，用于兼容旧数据解码。

**流的不变量**：终局 `status` 之前，每个 `tool_use` 都有配对的 `tool_result`。run 可能在工具还没返回时
就结束（取消 / 崩溃 / 空闲看门狗），此时引擎补发一帧合成结果（`interrupted: true`、`isError: true`，
content 说明未返回结果）。客户端因此可以把「没有配对的 tool_use」一律当成"仍在运行"，不必各自兜底；
历史回放读到的也是同一份自洽的流。

`POST /api/chat` 请求体：`{ prompt, sessionId?, workspaceId?, model?, runtime?, permissionMode?, commandId?, attachmentIds? }`。
`attachmentIds` 最多 8 个，来自 `POST /api/attachments`；图片会随用户消息一起送给 runtime，并记录在
`RunDto.attachmentIds` 供历史回显。runtime 或模型不支持图片时返回 400
`attachments_unsupported_runtime` / `attachments_unsupported_model`。

- 新会话使用 `workspaceId`（缺省用默认 Workspace）作为 cwd。runtime 优先级：请求 `runtime` → workspace `defaultRuntime` → `claude`；权限优先级：请求 `permissionMode` → workspace `defaultPermissionMode` → 全局 `default_permission_mode`。已有会话始终沿用自身的 runtime / 权限模式。
- `model` 缺省 / 空串 / `'default'` 都表示沿用 CLI 默认。新建会话通常不带 `model`（`sessions.model` 留空）；会话模型用 `PATCH /api/sessions/:id/model` 切换，下一轮生效。单轮请求仍可用 `body.model` 覆盖（`runs.model` 记录实际使用的值），但不会改写会话。
- `modelParameters` 是通用字符串 map（当前只有 `reasoningEffort`）。解析顺序与 `model` 相同：请求体 > 会话保存值 > provider 默认。Claude 映射为 `--effort`（探测到才传），Codex 写进 `turn/start.effort`，DeepSeek 走 ACP `session/set_config_option(reasoning_effort)`。新增参数不需要改协议：目录声明描述符，daemon 原样存储/透传，客户端按描述符渲染。
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
  避免为必然被拒的请求去 spawn CLI。异步探测完成后会再次检查；开跑前快照和收口后的快照期间
  也占用该 Session，直到快照完成并持久化终态才允许下一轮开始。

**断线续接**：`/api/chat` 客户端断开后，run **继续在 daemon 上运行**（不因断线取消）；重连
用 `GET /api/runs` 找运行中的 run，再 `GET /api/runs/:id/stream?after=<seq>` 回放 + 续直播；
显式停止用 `POST /api/runs/:id/cancel`。**不同 Session 之间**多 run 并发无全局锁
（同一 Session 见上面的 409 守卫）。

**重启对账**：daemon 启动时把所有仍是 `running` 的 run 标为 `interrupted`（进程已随上次退出消失，
没有任何东西在跑），并给它的持久流补一帧终局 `status(label=interrupted)`。否则该 run 会永远读作
"运行中"。

## 多 agent 群聊（room）

一个 Session 是一个房间：多个 agent 各自拥有 runtime / 工作目录 / 模型 / provider 会话
（`agent_threads`），共用一条时间线。房间的 leader 是「用户建会话时选择的 runtime 所对应的
agent」，**创建后不可更换**，也没有换 leader 的端点；要换主答就新建会话。

- **归属**：`/api/chat` 与 turn 的答案在定稿时就把 `agent_id` / `turn_id` / `task_id` /
  `committed_seq` 一起写入 `messages`，不存在「先写后认领」的竞态；`runs.agent_id` 记录实际
  执行者。老数据由启动 backfill 按 leader 补齐。
- **权限**：生效模式 = `min(会话模式, agent.permissionCeiling)`，只会收紧。implicit agent
  （老 daemon 的替身）与 peer agent 不参与收紧。
- **路由**：显式 `@名字` → 恰好这些成员（`heavy` 也允许，@ 就是它的显式请求）；`@all` →
  所有 enabled 且非 heavy、非 peer 的成员；无 @ → leader。disabled / peer / 未知 id 进入
  `dropped`，**不会**回落给 leader——静默换人回答比不回答更糟。
- **并发**：同一 turn 的 tasks 同时开跑（turn 不是屏障），但同一 `(session, agent)` 的 run
  串行排队：同一个 agent 的两轮若并发，会同时 `--resume` 同一个 provider 会话。
- **有限接力**：leader 可在回答最后用行首 `@成员` 召唤最多 3 个助手（task source=`summon`）；
  被召唤的助手完成后可以行首 `@leader` / `@主答` 回报一次，最多生成 3 个 `reply` task。
  `reply` 是链路终点，不能再召唤别人，因此 `leader → summon → reply` 之后一定停止，避免
  来回 @ 形成循环。
- **上下文投影**：每个成员只看到其他成员的 committed 消息，默认保留最近 6 条、总预算
  24,000 字符。超出总预算时优先丢更早的消息；最新一条即使很长也优先完整保留，只有单条
  本身超过总预算时才截断，并在文本中明确标注 `（已截断）`。
- **端点**：
  - `GET /api/workspaces/:id/agents`、`POST /api/workspaces/:id/agents`
  - `POST /api/workspaces/:id/agent-definition-draft`：用 builtin 默认模型（第一个可用
    provider/model）一次补全，根据 `{name, summary?, includeWorkspace?}` 起草助手「定义」，
    返回 `{instructions}`；不建会话、不落库。`includeWorkspace=true` 时把工作区名、端
    （名称/summary/notes/目录名）、verified 知识标题、顶层目录名拼进 prompt（**不含文件内容**）。
    未配置可用 provider → 409 `no_provider`
  - `POST /api/workspaces/:id/agent-draft`：`{idea, includeWorkspace?}` → `{name, summary, instructions}`。
    根据一句描述一次起草**整个助手**；模型返回 JSON，解析失败 → 502 `bad_response`，
    名字/简介超 40 字截断。同样不建会话、不落库；未配置 provider → 409 `no_provider`
  - `GET|PATCH|DELETE /api/agent-profiles/:id`
  - `GET|POST /api/sessions/:id/agents`、`DELETE /api/sessions/:id/agents/:agentId`、
    `POST /api/sessions/:id/agents/:agentId/reset-context`
  - `GET /api/sessions/:id/agents/:agentId`：助手 tab 的**展开态**——当前任务（queued/running
    与已等待/已运行时长）、最近一次已提交发言、以及它的对话信息（`cwd` / backend / model；
    builtin 另给 native 消息数与压缩次数）。成员不在会话里 → 404 `agent_not_in_session`
    （刻意区别于兜底 404，客户端据此区分「被移出」和「daemon 太老」）。
    **不返回 token 用量与记忆注入条数**：paboot 没有按 agent 记录这些（外部 CLI 自己管对话），
    宁可缺字段也不编一个数。
  - `POST /api/sessions/:id/turns`（body `{prompt, mentions: string[], attachmentIds?: string[], commandId?}`，
    `mentions` 最多 8 个）
    → 202 `{turnId, addressed, dropped, tasks}`。用户消息在返回前提交；答案是别的帧，走房间流。
    与 `POST /api/sessions` 的首条 `prompt` 共用同一套校验/派发（`rooms/dispatch-turn.ts`）。
    `attachmentIds` 是最多 8 张、此前通过 `POST /api/attachments` 上传的图片，由 turn 持有并
    同传给该 turn 的每个 task（包括 leader 之后召唤的 supplement）。只要有一个被点名的 agent
    所属 runtime 不支持图片输入，整张 turn 会在写用户消息前以
    `attachments_unsupported_agent` 拒绝，不会静默漏掉某个 @。
    同一个 `commandId` 重试会**重连到已建好的 turn** 并跳过启动任务，不会变成第二个提问；
    同一个 key 出现在**另一个会话** → 409 `command_id_conflict`，且不会写入任何行。
  - `POST /api/sessions/:id/cancel`：停止该会话当前所有 room 工作。排队中、尚未拿到
    run 的 task 直接标为 cancelled；正在运行的 runs 走取消路径。返回
    `{ok, cancelled}`。单个 run 仍可用 `POST /api/runs/:id/cancel`。
  - `POST /api/tasks/:id/cancel`：只停**一个**排队/运行中的 task，兄弟任务继续。排队中的
    同步标为 cancelled（并保证它在 per-agent 队列里轮到时不会执行）；运行中的通过其 run
    取消，由正常终态路径落库并发终局帧。返回 `{ok, taskId, status}`（`cancelled` |
    `cancelling`）。任务已结束 → 404 `task_not_found`。会话成员列表里的
    `taskStatus` / `taskId` 就是这里要停的目标。
  - `GET /api/sessions/:id/stream?after=<roomSeq>`：一个会话一条流，承载所有 agent 的帧
    （会话级通知也在内）。帧额外带 `roomSeq` / `taskId` / `agentId`；SSE 的 `id:` 是
    `roomSeq`，省略 `after` 只收直播，给了则回放并分页（500 行/页）直到追平。
    客户端重建历史时用 run events 的 `roomSeq` 取得快照游标，再从该位置接入 room stream，
    避免多个并发 run 的已显示前缀被直播流重复或遗漏。

## 跨机共享（peer，P3）

> **v1 是「可信对端」模式**：只承诺同一 LAN / Tailscale / SSH 隧道；合同是 `access='full'`，
> 工具 / 上下文 / 记忆与本地 run 一致。安全边界在网络 + `guest` 端点白名单 +
> **`~/.paboot/**` 尽力拒绝（路径/命令启发式，不是沙箱）**。**只有 builtin / Claude 的
> agent 可以被共享**；Codex / DeepSeek 返回 `backend_not_supported`。

| 方法 & 路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/peer/info` | 匿名 / guest | 匿名只返回 `serverId` / 协议版本；带 token 时只返回该 token 名下的**一个** agent（`publicName` / `summary` / 合同版本），**不含目录、token 状态** |
| `GET /api/peer/agent?agentId=` | guest | 自己的合同（B 用来渲染能力与发现版本变化） |
| `POST /api/peer/redeem` | guest | 把邀请 token 绑定成 `peers(in)` + `peer_tokens`；body 可带 `{peerId,label,baseUrl}`（B 的 serverId），重复调用幂等 |
| `POST /api/peer/runs` | guest | 发起一轮，直接返回 SSE。body `{agentId, clientRunId, threadKey, prompt, room?, attachments?}`；同一 `(peerId, clientRunId)` 重放不会新建 run |
| `GET /api/peer/runs/:id/stream?after=` | guest | 断线重连：先回放持久化事件，再续直播 |
| `POST /api/peer/runs/:id/cancel` | guest | 取消对端 run（A 侧同时有墙钟兜底） |
| `POST /api/peer/runs/:id/permission` | guest | `relay` 决策回传：`{permissionId, decision:'allow'|'deny'}` |
| `POST /api/agent-profiles/:id/exposed` | operator | 写入合同（v1 只接受 `access='full'`；`custom` → 400） |
| `GET /api/agent-profiles/:id/exposed` | operator | 读合同 |
| `POST /api/agent-profiles/:id/exposed/invites` | operator | 生成本 agent 的一次性邀请（一个邀请只能对应一个 agent），返回 `paboot://join?host&port&fp&t&exp`。请求来自 `127.0.0.1` 时 `host` 不写回环地址，而是取本机可用网卡（优先私有 IPv4 / Tailscale） |
| `DELETE /api/agent-profiles/:id/exposed/tokens` | operator | 一键吊销：缩小所有相关 token 的 scopes，空则吊销；同时 `enabled=0` |
| `GET /api/peer/sessions?workspaceId=` | operator | A 侧监控：列出本机 `purpose='peer'` 的隐藏会话（标题、共享的助手、来客 label、是否 running），**只读** |

**A 侧只读监控**：被远端驱动的隐藏会话不进普通 `GET /api/sessions`（`purpose <> 'peer'`），
主人只能通过 `GET /api/peer/sessions` 看到它们、按 id 打开回放/直播 run 事件；`POST /api/sessions/:id/turns`
对这类会话返回 `403 peer_session_read_only`。发言与审批仍归远端访客，主人不能接管。

**`guest` 是第四 token 角色**：只允许 `/peer/info`、`/peer/agent`、`/peer/redeem` 与 `/peer/runs*`。其余路径一律 403；`/peer/peers` 等 B 侧管理端点不对 guest 开放。**未兑换的邀请**只能访问 `/peer/agent` 与 `/peer/redeem`。

**B 侧管理（operator）**：`GET /api/peer/peers`、`POST /api/peer/peers {url,workspaceId?,label?}`、
`DELETE /api/peer/peers/:id`、`POST /api/peer/peers/:id/probe`。加入时先匿名探活 `/peer/info`
校验 serverId，再 `POST /peer/redeem`，然后把暴露的 agent 投影成本工作区的 `kind='peer'` agent。

**运行协议**：第一帧是 `peer_meta`（A 的 runId / threadKey / cwd / 是否续上），之后是与本地
run 相同的 `NormalizedEvent` 序列，最后一帧是 `terminal:true` 的 `status`。B 把事件写进自己的
`events`（run id 用 B 的），回答落 `messages.source='peer'`。A 用 `(peer_id, client_run_id)` 去重；
B 的 `clientRunId` 是 task id，重启对账（P3.3）会用它取消孤儿 run。

**默认值**：`approvalPolicy='relay'`、`capture=false`、并发 1、每小时 20 次、单次输入 20k、
墙钟 10 分钟；这些数字在 `peer/runs.ts` 真正执行，不只是展示。`capture=false` 时，peer 触发的
隐藏会话（`sessions.purpose='peer'`）与 `messages.source='peer'` 的文本都不进本机记忆。

**`~/.paboot` 尽力拒绝（启发式）**：peer run 带 `denyRoots=[dataDir]`——builtin 的路径策略在
`local` 下也会先查 denyRoots，Claude 的 hook matcher 额外包含 `Read|Grep|Glob` 并只做这一条
检查；Bash 侧是命令文本里 `dataDir` / `~/.paboot` 的子串匹配。**它挡的是误用，不是有意的
绕过**（`cat ${HOME}/.paboot/token` 之类仍可绕过），真正的边界是「可信对端 + 网络」。
**读类工具在检查通过后自动放行，不产生审批**；写类才走合同审批策略。

## 文件改动的查看

**没有 run 级回滚**（2026-11-23 移除）。原来每轮用隐藏 git ref 快照工作区、可以「回滚到某轮之前」，
实际使用率是 1/1139 轮，而 `refs/paboot/checkpoints/*` 累积了两万多个 ref 且没有保留期——代价与
收益不成比例，整套删掉（含 `RunDto.checkpoint`、`GET /api/changes?runId=`、`POST /api/runs/:id/rollback`
和 `rolled_back` 状态）。想撤销改动就用 git 本身：paboot 从不碰真实的 index / HEAD，工作区里留下
的改动照常用 `git diff` / `git checkout` 处理。

`GET /api/changes` / `GET /api/changes/diff` 仍只回答「这个目录现在有什么未提交改动」，
即实时状态，不按 run 切片。

## 会话续接

- Claude Code 的所有会话（TUI 与 headless）统一存 `~/.claude/projects/<cwd>/<id>.jsonl`，
  会话 id 就是文件名；`claude --resume <id>` 续接。
- daemon 自己生成 `--session-id`，续接用 `--resume`，并把该 id 存进 `sessions.native_session_id`
  ——这一列存的是**对应运行时自己的会话 id**：Claude 是 `--session-id` 生成的那个，Codex 是它的
  thread id（续接走 `thread/resume`），DeepSeek 是 ACP `session/new` 返回的 session id
  （续接走 `session/resume`）。客户端只续接自己创建的会话。

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
  "host": "0.0.0.0",
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
| `serverId` | **该 daemon 的稳定身份**：首次启动生成、持久化在 `settings` 表，重启不变。用于「同一台机器换了地址（LAN / 隧道 / 以后的 relay）」时识别为同一个 host。**也通过 `GET /api/health` 暴露**——那个文件只在本机，远程客户端只能从 health 拿 |
| `hostname` | 展示用 |
| `listen` | **可直接连接的** `host:port`。绑定 `0.0.0.0` / `::` 会翻译成 `127.0.0.1` / `[::1]`——原样给出是连不上的 |
| `host` | **绑定的原始地址**（`0.0.0.0` / `::` = 所有网卡，`127.0.0.1` = 仅本机）。`listen` 是被翻译过的、看不出这个区别，而「手机能不能连上」恰恰只由它决定 |
| `tls` | 据此选 `http` / `https` |
| `version` | daemon 版本 |
| `dataDir` | 数据根（现固定 `~/.paboot`），展示/诊断用 |
| `tokenSource` | 见 [configuration.md](configuration.md) 的「operator token 解析顺序」：**只有 `file` 时** `<data-dir>/token` 才是权威值 |

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
