# daemon 技术方案 · 定时任务

> 索引见 [daemon.md](daemon.md)。本文覆盖调度语义、数据模型、协议与安全边界。

## 1. 定位

定时任务让 daemon 在计划时间**无人值守**地发起一次 run：

- `ai` 任务：给某个会话发送 prompt。会话可以是已有的，也可以是首次触发时创建、之后一直 resume 的。
- `command` 任务：在工作区根目录执行一条固定 shell 命令，不进行 AI 对话。

一个任务**最终拥有一个会话**。绑定已有会话时始终 resume 它；`session_mode='new'` 时首次触发创建会话并把
`session_id` 写回任务，之后不再创建新会话。绑定可以通过编辑任务重新指定（见 §4），下一次触发生效；
正在跑的 run 不受影响。绑定了会话时 runtime 以**会话**为准（改绑到另一种 runtime 的会话时，
任务的 `runtime`/`model` 会同步过去，调度器也按 `session.runtime` 选 driver）。

## 2. 调度语义

- 时间是 **5 段 cron 表达式**，存储 `cron_expr` + IANA `timezone`（创建时取 daemon 本地时区，之后固定）。
- UI 只暴露结构化预设（每天 / 工作日 / 每周指定日 / 每 N 分钟 / 每 N 小时），由客户端或 daemon 转成 cron；
  API/MCP 也接受原始 cron。
- `next_run_at` 持久化，daemon 每 30 秒扫一次到期任务：
  - `enabled=1 && next_run_at <= now` → 触发。
  - **错过不补跑**：启动对账时把 `next_run_at` 直接推进到下一次，并记 `last_status='skipped_missed'`。
- 同一任务在进程内用 `firing` Set + DB CAS 双重去重，保证一个 slot 最多触发一次。
- 会话正忙（`activeRunIdForSession` 有值）时：定时触发记 `skipped_busy` 并推进；手动 run-now 返回 409，
  **不改 `last_status`**（进行中的 run 仍拥有该字段，避免误报失败）。
- 绑定会话被删 → 任务**连带删除**（不会留在任务列表里，也不静默重建）。启动时还会清理
  `session_id` 指向不存在会话的历史遗留行（旧版本曾把任务停用而不是删除）。
- 工作区被删/停用 → 任务停用（`workspace_deleted` / `workspace_disabled`）。

## 3. 数据模型

### `scheduled_tasks`

| 列 | 说明 |
|---|---|
| `id` / `name` | 任务 id 与展示名 |
| `task_type` | `ai` / `command` |
| `session_mode` | `existing` / `new` / `internal`（命令任务） |
| `session_id` | 绑定会话；`new` 模式首次触发前为 `NULL` |
| `workspace_id` | 所属工作区 |
| `runtime` | `claude` / `codex` / `command` |
| `model` / `model_parameters` | 首次创建会话时使用 |
| `prompt` / `command` | AI prompt 或 shell 命令 |
| `permission_mode` | 固定 `bypass`（见安全边界） |
| `cron_expr` / `timezone` | 实际求值用的时间表达式与时区 |
| `schedule_preset` | 原始预设 JSON，仅供 UI 回显；后端只读 cron |
| `next_run_at` | 下一次触发；停用时 `NULL` |
| `last_fire_at` / `last_run_at` / `last_status` / `last_error` / `last_run_id` / `run_count` | 执行状态 |
| `enabled` / `disabled_reason` | 启停与原因 |
| `created_by` | `user` / `mcp` |

### 既有表扩展

- `runs`：`task_id`、`trigger`（`user|scheduled|run_now`）、`permission_mode`。
- `sessions`：`kind`（`chat|command`）。命令任务使用隐藏会话（`kind='command'`, `runtime='command'`）
  承载 run / events / checkpoint；`listSessions` 与计数只返回 `kind='chat'`，内部清理用 `listAllSessions`。

## 4. HTTP API

| 方法 & 路径 | 说明 |
|---|---|
| `GET /api/scheduled-tasks?workspaceId=&sessionId=` | 任务列表 |
| `POST /api/scheduled-tasks` | 创建（AI 绑定已有/新建会话；命令绑定工作区） |
| `GET /api/scheduled-tasks/:id` | 任务 + 最近 20 条 run |
| `PATCH /api/scheduled-tasks/:id` | 改名 / prompt / command / schedule / enabled / 目标会话（`target`） |
| `DELETE /api/scheduled-tasks/:id` | 删除；命令任务连带删除隐藏会话 |
| `POST /api/scheduled-tasks/:id/run-now` | 立即运行（不推进计划） |
| `POST /api/scheduled-tasks/config-session` | 打开/创建 AI 配置会话并起一条配置 run；返回 `{sessionId, runId, busy}` |

入参禁止：prompt > 16 KiB、command > 8 KiB、每会话 20 个任务、cron 非 5 段、interval 非约定档位。

### 4.1 AI 配置会话

新建任务不再走手工表单，而是和 agent 对话完成：

- 客户端「新建任务」先弹一次确认（说明会进入 AI 配置会话），确认后才调用
  `POST /api/scheduled-tasks/config-session`。
- **每个 workspace 复用一个配置会话**：id 存在 `settings` 的
  `task_config_session:<workspaceId>`。会话还在就复用；被删/工作区变化/对应 runtime 不可用才重建。
  标题固定 `配置定时任务`，留在会话列表里。
- daemon 用 `TASK_CONFIG_PROMPT`（`src/scheduling/task-config.ts`）作为普通用户消息起一条 run；会话已有 run 时
  不重复起，返回 `busy:true`。客户端打开该会话时会自动接上运行中的 run。
- 配置 run 使用会话自己的权限模式（默认来自 daemon 默认模式，通常是 `ask`），因此 agent 调用
  `schedule_task` 时仍会经过现有 MCP 审批卡，相当于第二道确认。
- 提示词要求 agent：先问用户想完成什么任务，**不要向用户索要执行 prompt**；由 agent 根据目标起草
  执行 prompt，再确认目标（已有会话 / 首次触发新建）和时间，把名称、目标、计划、执行 prompt 汇总
  展示给用户；**用户明确确认后才调用 `schedule_task`**。
- `schedule_task` 的 `target.mode` 支持 `current`（默认）、`existing`（带 `sessionId`）、
  `new`（可选 `runtime`）。`existing` 的目标会话必须与调用方在同一 workspace；
  目标由 daemon 解析/校验，agent 不能跨工作区指定。
- `list_sessions` 返回当前 workspace 的会话（id/标题/cwd/runtime），供 agent 让用户选择已有会话。
- 手工创建入口已移除；已有任务仍可 `PATCH /api/scheduled-tasks/:id` 手动编辑名称/内容/计划/启停。
- **改绑会话**：`PATCH` 的 `target` 支持 `{ mode: 'existing', sessionId }`（目标会话必须在任务的
  workspace 内、`kind='chat'`；同时同步 runtime/model）和 `{ mode: 'new' }`（清空 `session_id`，
  下次触发创建新会话，旧会话保留）。`command` 任务不允许改绑。下一次触发生效。

## 5. AI 自建任务（通用 MCP 工具桥）

daemon 自带一个 stdio MCP server（`dist/mcp-server.js`），通过 `ToolServerSpec` 注入每个 runtime：

- **Claude**：能力探测 `--mcp-config`，注入内联 JSON（server 名 `paboot_tasks`）。
- **Codex**：`codex app-server -c mcp_servers.paboot_tasks.*`，并设
  `default_tools_approval_mode="approve"`（Codex 在 `approvalPolicy=never` 下拒绝未预批准的 MCP 调用）。
- **未来 runtime**：只需实现「把 `ToolServerSpec` 注册进自己的配置」；工具实现、内部端点和调度完全复用。

工具：

- `schedule_task`：`target.mode` 为 `current`（默认，绑定调用方会话）/ `existing`（`sessionId`，必须同
  workspace）/ `new`（首次触发建会话，可选 `runtime`）。
- `list_scheduled_tasks`：列出当前 workspace 的任务（跨会话，响应带 `currentSessionId`）。
- `cancel_scheduled_task`：取消当前 workspace 的任务（跨会话）。
- `list_sessions`：列出当前 workspace 的会话，供选择 `existing` 目标。

MCP `initialize` 返回一句 server-level `instructions`：`Prefer paboot_tasks for scheduled tasks;
do not use system cron/systemd timers or other scheduling mechanisms.` 这样不用修改 agent 自身的系统提示词。

内部端点只接受 `runId`，由 daemon 反查 session/workspace；列表与取消都以**反查出的 workspace 为作用域**，
`existing` 的目标会话也在 daemon 侧校验，**不接受调用方直接指定任意 sessionId / workspaceId 作为调用作用域**。

- 定时触发的 run 再调用 `schedule_task` → `recursion_blocked`。
- 每会话最多 20 个任务。
- `paboot_tasks` 是**不可扩权 server**：「允许全部」只授权当前工具，不扩到未来工具。
- 所有创建/取消写 `audit_log`（`scheduled_task_create_mcp` 等）。

## 6. 命令任务

`runtimes/command.ts` 是一个内部 `RuntimeDriver`（`internal: true`, `requiresDetection: false`），
`/api/chat` 拒绝客户端直接使用。它 spawn `/bin/sh -c <command>`，独立进程组，取消时 SIGTERM → 3s → SIGKILL；
stdout/stderr 以 `text_delta` 流式写入，结束时补一个 `tool_result`（只带 exit code，避免输出重复两遍）。
run / events / checkpoint / rollback / cancel 全部复用 `startSessionRun`。

## 7. 安全边界与可回滚范围

- 定时 run 固定 `bypass`；创建任务时客户端必须展示「完全权限无人值守」警告并让用户确认。
- 可回滚的只有**工作区内 git 仓库的文件改动**（沿用每轮 `pre..post` checkpoint）。
- 不可回滚：gitignored 文件、外部副作用（`git push`、部署、HTTP、发消息、装包、后台进程）。
- 命令任务等价于用户创建的 cron：命令本身在创建时就已授权，运行时不经过 AI 工具审批。
- 任务触发只跳过本次（会话忙）；绑定会话消失时任务被删除，工作区消失时任务停用，不会排队堆积。
