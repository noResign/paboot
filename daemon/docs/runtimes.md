# daemon 技术方案 · 运行时接入

> 索引见 [daemon.md](daemon.md)

## 运行时接入（两条路径）

运行时按驱动方式分两条路径，最后都产出同一份 `NormalizedEvent`。

**① argv + stdout 流式 CLI（`RuntimeAdapter`）**——`runtimes/types.ts` 定义接口，实现它并在
`registry.ts` 的 adapter 表注册一行：

| 成员 | 职责 |
|---|---|
| `id` / `name` / `bin` | 标识与可执行文件名 |
| `detect(env)` | 探测版本 / 认证 / 能力 flag（从 `--help` 解析） |
| `buildArgs(ctx)` | 拼 spawn 命令行（各 CLI argv 不同） |
| `createParser(onEvent)` | 把运行时私有 stdout 翻译成 `NormalizedEvent` |
| `encodeUserMessage(text)` | 把 prompt 编码成该运行时的 stdin 格式 |
| `keepStdinOpen` | stream-json 类运行时保持 stdin 打开以支持中途追加 |

通用 `engine.ts` 只负责运行时无关的部分：spawn、stdio 接线、`turn_end` 时关 stdin、
SIGTERM→SIGKILL 取消、退出码分类、**空闲看门狗**。目前只有 `runtimes/claude/`
（detect / stream / adapter）走这条路。

**② RPC 对等进程（`RuntimeDetector`）**——Codex 走 `codex app-server` 的 stdio JSON-RPC，
DeepSeek Harness 走 `dsh acp`（ACP v1，同样是换行分隔 JSON-RPC）。两者都没有 argv 可拼、
也没有逐行 stdout 可解析，所以不实现 `RuntimeAdapter`：`registry.ts` 用
`RuntimeDetector` 登记它们（回答「装没装」「有哪些 model」），运行由
`runtimes/codex/session.ts` / `runtimes/deepseek/session.ts` 自行驱动。
Codex 在需要目录时短启 app-server 调 `model/list`；DeepSeek 的默认目录是静态的，由
Registry 缓存。两种驱动共用 `runtimes/stdio-rpc.ts` 的通用 peer 传输（请求 / 响应 /
通知 / 服务端反向请求）。
所有运行时都通过 `RuntimeDriver` 注册执行驱动，`routes/chat.ts` 只按 id 取
`registry.driver(id)` 并调用 `start`，**接入新运行时不需要改 chat 路由**。

**事件流是 runtime 无关的**：客户端只认 `NormalizedEvent`，不感知底层是哪个 CLI。

## DeepSeek Harness（ACP）

**前置**：Node `>=24.9`，`npm install -g @deepseek-ai/dsh`；首次 `dsh acp` 会自动初始化
`~/.dsh/profiles/acp`。模型凭据用 `DEEPSEEK_API_KEY` 环境变量，或由 `dsh web` 的
**设置 → 模型** 写入 `~/.dsh/.credentials.yaml`。`dsh` 和 `claude` / `codex` 一样按
daemon 的 PATH 查找；源码构建用 `pnpm link --global` 暴露到 PATH。ACP 基础能力不依赖
profile 里的 pnpm 插件安装。

**进程与续接**：每次 run 启动一个 `dsh acp`，按 run 传 `DSH_PERMISSION_MODE`。首次
`session/new` 返回的 ACP session id 存入 `sessions.native_session_id`；后续 run 用
`session/resume`（要求同一个绝对 cwd，不回放历史）。run 结束前调用 `session/close`，
确保 DSH 持久化落盘。

**权限**：paboot 的产品模式映射到 DSH 原生 preset——

| paboot | `DSH_PERMISSION_MODE` | 效果 |
|---|---|---|
| `ask` | `read-only` | 写文件/提权命令触发 ACP 审批 |
| `acceptEdits` | `workspace-write` | 工作区内写入自动放行，越界仍需审批 |
| `bypass` | `danger-full-access` | 关闭沙箱，DSH approval policy 为 `never` |

DSH 的 `session/request_permission` 只带 `callId`，但它保证先发 `tool_call` update；
驱动用缓存补全 toolName / rawInput，再走 `PermissionManager`。`acceptEdits` 下
`Edit` / `Write` 的提权请求由 daemon 自动放行。

**模型**：`session/new` / `session/resume` 后按需调用 `session/set_config_option`
（`configId=model` / `reasoning_effort`）。model 值是 ACP 的不透明选择器
（`["deepseek-official","deepseek-v4-flash"]`），daemon 原样存储和透传；静态目录包含 ACP
profile 的默认模型和 `packages/llm/llm-deepseek/src/models.ts` 的内置条目
（`deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-flash`），推理档位
`off/low/high/max`。如果 DSH 跟随服务端模型列表或配置了第三方 provider，静态目录可能落后；
会话不选模型时始终使用运行时默认。

**MCP**：`paboot_tasks` 直接映射成 `session/new.mcpServers` 的 stdio 条目
（`{name, command, args, env:[{name,value}]}`）。

**限制**：ACP 不接受 `additionalDirectories`，工作区额外目录只能通过提权审批访问；
DSH 默认不会为 MCP 工具发起审批，因此 `ask` 模式下 MCP 调用不会被门控；ACP 只推送**已提交**的
assistant message / thought，不是 token 级增量，长回复会在模型步骤结束时成块出现（也正因如此，
空闲看门狗把「有工具在跑」视为活动，避免长命令被误杀）。

## 命令任务（内部 runtime）

`runtimes/command.ts` 注册为 id `command` 的 `RuntimeDriver`，标记 `internal: true` /
`requiresDetection: false`：`/api/chat` 拒绝客户端直接使用，只有调度器会启动它。它 spawn
`/bin/sh -c <command>`（独立进程组，取消时 SIGTERM → 3s → SIGKILL），把 stdout/stderr 以
`text_delta` 写入事件流，结束时补 `tool_result`（只带 exit code）。run / checkpoint / rollback /
cancel 全部复用 `startSessionRun`。

## 通用工具桥（MCP，自建定时任务）

daemon 用同一个 `ToolServerSpec` 向每个 runtime 注入 `paboot_tasks` MCP server：

- **Claude**：探测到 `--mcp-config` 后内联 JSON（server 名 `paboot_tasks`，env 携带
  `PABOOT_DAEMON_URL/TOKEN/RUN_ID`）。非 bypass 模式下 MCP 工具走既有 `mcp__.*` PreToolUse
  matcher，会弹审批；bypass 不挂 hook。
- **Codex**：通过 `codex app-server -c mcp_servers.paboot_tasks.*` 注入，并设
  `default_tools_approval_mode="approve"`——Codex 在 `approvalPolicy=never` 下会拒绝未预批准的
  MCP 调用。
- **DeepSeek Harness**：作为 `session/new.mcpServers` 的 stdio 条目传入（每次 resume 重新挂载）。
  注意 DSH 不会为 MCP 工具本身发起审批。
- **未来 runtime**：实现「把 `ToolServerSpec` 注册进自己的配置」这一件事即可；工具实现、内部端点、
  调度完全复用。没有 MCP 的 runtime 可退回 CLI helper + `developer_instructions` 方案。

## 模型参数（可扩展）

`ModelOption` 除 `id` / `label` 外可带 `parameters: ModelParameter[]`，每个参数是一个
`{id, label, values[], defaultId?}` 描述符（例如 `reasoningEffort`）。约定：

- **目录由 runtime 声明**：argv runtime 通过 `detect().models` 返回，RPC runtime 通过
  `RuntimeDetector.listModels` 返回。某个能力没探测到（如老版本 Claude 没有 `--effort`），
  就不要声明对应参数。
- **daemon 只做通用存储与透传**：`sessions.model_parameters` / `runs.model_parameters` 是 JSON
  map，chat 请求体用 `modelParameters` 透传；不认识的参数 id 也保留，由 runtime 决定是否使用。
- **参数 id 保持 runtime 无关**（目前统一为 `reasoningEffort`），这样换模型/换 runtime 时客户端
  的选择语义一致。各 runtime 自己把它映射到原生机制：Claude → `--effort`，Codex →
  `turn/start.effort`。
- **客户端按描述符渲染**：新增参数（`serviceTier`、`contextTier` 等）不需要改协议或 UI 结构，
  只需 runtime 在目录里声明 + 在自己的驱动里读取。

新增 runtime 时，只要它的 `listModels` 返回带 `parameters` 的目录，并在 spawn/RPC 参数里消费
`modelParameters`，就自动获得模型与参数选择能力。
