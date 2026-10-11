# 附录：数据映射 / 里程碑 / 接口契约（§8-§10 + 附录）

> 文档索引见 [README.md](../README.md)；Design Tokens 与组件库见 [design-principles.md](design-principles.md)。章节编号沿用拆分前的 `ui_design.md`，未重新编号。

## 8. 数据与界面映射（API → UI）

> 全部端点均在 `/api` 下；除 `/api/health` 外均需请求头 `Authorization: Bearer <token>`。
> Workspace 相关请求可带 `workspaceId`；客户端把 `selectedWorkspaceId` 存在本地。

| 界面数据 | 来源 |
|---|---|
| 服务器地址 / token | 用户输入，本地持久化 |
| 当前 Workspace | 客户端 `selectedWorkspaceId` + `GET /api/workspaces` 校验 |
| Workspace 列表 | `GET /api/workspaces` |
| 新增/选择目录 | `GET /api/fs/directories?path=...`、`POST /api/workspaces` |
| daemon 版本号 | `GET /api/health` |
| 全局默认配置 | `GET /api/config`；`PATCH /api/config` 更新默认 Workspace/权限模式 |
| 可用 agent 列表 | `GET /api/agents` |
| 当前 Workspace 的会话列表 | `GET /api/sessions?workspaceId=<id>` |
| 单个会话的消息历史 + runs | `GET /api/sessions/:id` |
| 续接本机 Claude 会话列表 | `GET /api/claude-sessions?workspaceId=<id>` |
| Session 权限模式与 grants | `GET /api/sessions/:id/permissions`；`PATCH /api/sessions/:id/permissions`；`DELETE /api/sessions/:id/permissions/grants/:toolName` |
| 流式事件 | SSE：`POST /api/chat`（body `{sessionId?, workspaceId?, claudeSessionId?, prompt, model?, runtime?}`） |
| 停止运行中的任务 | `POST /api/runs/:id/cancel` |
| 工具审批决策 | `POST /api/permissions/:id/decision`（body `{decision, reason?}`） |
| 当前 Workspace 的改动文件列表 | 🟡 `GET /api/changes?workspaceId=<id>`（**待后端实现**） |
| 改动文件 diff | 🟡 `GET /api/changes/diff?workspaceId=<id>&path=...`（**待后端实现**） |
| 当前 Workspace 的全部文件列表 / 内容 | 🟡 `GET /api/files?workspaceId=<id>&path=...`（**后续里程碑**） |
| 断线补齐事件 | `GET /api/runs/:id/events?after=seq` |

## 9. 交付里程碑（正式产品，增量上线）

> 这是长期维护的正式产品，按里程碑增量交付，但**每个页面从设计到实现都按生产级标准**，不留"临时版"。

**M1（首批可用）**：
- ① 连接页、② 会话列表、③ 聊天详情、④ 新建/续接会话、⑦ 设置、Ⓟ Bash 权限审批。
- 覆盖：连接、列会话（含运行指示）、建会话（选 agent / Workspace 展示）、会话重命名/删除、发消息、流式回复、思考块、工具卡片、用量、**Bash 命令审批**、停止任务、断线重连。

**M2（增强）**：
- ⑤ 文件浏览 + ⑥ 文件查看器；
- ⑧ Workspace 管理 + ⑨ 目录选择器；
- ⑩ 会话权限设置 + Write/Edit 审批；
- Workspace 切换后 Sessions/Files/Settings 刷新；
- 扫码连接、消息搜索、多端观看。

---

## 10. 交付物清单（对设计师的要求）

请设计师产出：

1. **信息架构图**确认（可对本文档第 3 章提出优化）。
2. **高保真页面稿**（浅色为默认，附暗色对照）：
   - 连接页、会话列表、聊天详情、新建/续接会话、设置、**权限审批浮层**；
   - 工作区管理、目录选择器、会话权限设置 —— 各含关键状态。
3. **组件库**：消息气泡、工具卡片（running/done/error/interrupted）、思考块、状态条、运行指示器、Runtime 身份（§5.2）、权限模式徽章、**Workspace 切换器**、空态、**权限审批卡片**。
4. **交互说明**：流式追加、工具卡状态流转、**命令审批流**、Workspace 切换刷新流、断线重连、**语音输入流（按住说话→转写→确认发送）** 的动效示意。
5. **Design Tokens**：最终色板（暗/浅）、语义字体/间距/圆角、语义图标名。
6. **Runtime 身份映射**：§5.2 的 `id → 图标 + 主题色 + 展示名` 表，含未知 id 兜底。
7. **跨平台适配**：竖屏手机为主；小屏（≤360dp/pt 宽）排版策略；说明两端（Android/iOS）同一设计如何落到各自控件。

---

## 附录 A：后端接口契约（真实 + 规划，供开发/设计师对照）

| 端点 | 方法 | 鉴权 | 返回/说明 |
|---|---|---|---|
| `/api/health` | GET | 否 | `{ok, service, version, workspace}` |
| `/api/workspaces` | GET | 是 | `{workspaces:[{id,name,path,isDefault,enabled,sessionCount}]}` |
| `/api/workspaces` | POST | 是 | body `{name?, path}`；新增 Workspace，校验目录、防嵌套 |
| `/api/workspaces/:id` | PATCH | 是 | body `{name?, isDefault?, enabled?}` |
| `/api/workspaces/:id` | DELETE | 是 | 删除/禁用；有 Session 引用时阻止 |
| `/api/fs/directories` | GET | 是 | `?path=<abs>&showHidden=false`；返回目录列表、父目录、面包屑 |
| `/api/changes` | GET | 是 | `?workspaceId=<id>`；基于 `git status` 返回改动文件列表 |
| `/api/changes/diff` | GET | 是 | `?workspaceId=<id>&path=<relativePath>`；返回单文件 diff |
| `/api/config` | GET | 是 | 返回默认权限模式、默认 Workspace、只读/重启级配置 |
| `/api/config` | PATCH | 是 | body `{defaultPermissionMode?, defaultWorkspaceId?}` |
| `/api/sessions` | GET | 是 | `?workspaceId=<id>`；返回该 Workspace 的会话 |
| `/api/sessions/:id` | GET | 是 | `{session, messages, runs}` |
| `/api/sessions/:id` | PATCH | 是 | 重命名，body `{title}` |
| `/api/sessions/:id` | DELETE | 是 | 删除会话 |
| `/api/sessions/:id/permissions` | GET | 是 | `{mode, grants:[{toolName,createdAt}]}` |
| `/api/sessions/:id/permissions` | PATCH | 是 | body `{mode:"ask"|"acceptEdits"|"bypass"}`；仅影响后续 Run |
| `/api/sessions/:id/permissions/grants/:toolName` | DELETE | 是 | 撤销单个工具授权 |
| `/api/sessions/:id/permissions/grants` | DELETE | 是 | 撤销全部授权 |
| `/api/chat` | POST | 是 | SSE 流；body `{sessionId?, workspaceId?, claudeSessionId?, prompt, model?, runtime?, permissionMode?}` |
| `/api/runs` | GET | 是 | `?workspaceId=<id>`；当前运行中的 run |
| `/api/runs/:id/cancel` | POST | 是 | `{ok, id}` |
| `/api/runs/:id/events` | GET | 是 | `?after=<seq>` 一次性回放 |
| `/api/runs/:id/stream` | GET | 是 | SSE：回放 + 续直播 |
| `/api/agents` | GET | 是 | `{agents:[{id,name,bin}]}` |
| `/api/agent` | GET | 是 | 检测信息 |
| `/api/claude-sessions` | GET | 是 | `?workspaceId=<id>`；枚举该 Workspace 内的 Claude 会话 |
| `/api/permissions/:id/decision` | POST | 是 | body `{decision:"allow"|"deny"|"allow_all", reason?}` |

**流事件补充**：

| 事件 type | 关键字段 | UI 用途 |
|---|---|---|
| `permission_request` | `permissionId, toolName, toolInput, status` | 🔴 审批浮层；已决状态帧用于移除旧弹窗 |

## 附录 B：后端现状与待补项（UI 依赖、但后端还没实现的能力）

| 能力 | UI 依赖 | 状态 |
|---|---|---|
| Bash 有副作用时审批 | Ⓟ 审批浮层 | 🟢 已支持 |
| Write/Edit 在 `ask` 模式下审批 | 审批浮层、工具卡片 | 🟡 需扩展 PreToolUse hook matcher |
| 三档 Session 权限模式 | ⑩ 会话权限设置 | 🟡 需新增 Session 字段和 API |
| “允许全部”Session 级持久化、可撤销 | 审批浮层、⑩ 会话权限设置 | 🟡 当前仅内存，需改 DB |
| Workspace 注册与切换 | 工作区管理、顶部切换器 | 🟡 未实现 |
| 目录选择器 | ⑨ 目录选择器 | 🟡 未实现 |
| 按 Workspace 过滤会话 | ② 会话列表 | 🟡 未实现 |
| 改动文件列表（git status） | ⑤ Files 改动 Tab | 🟡 未实现 |
| 单文件 diff | ⑥ Diff 查看器 | 🟡 未实现 |
| 全部文件浏览 / 文件内容 | ⑤ Files 全部文件 Tab | 🟡 后续里程碑 |
| 停止任务 | 聊天页「停止」按钮 | 🟢 已支持 |
| 事件回放 / 断线续传 | 7.3 断线重连 | 🟢 已实现 |
| 运行中 run 列表 | 7.2 运行状态 | 🟢 已实现（需补 `workspaceId` 过滤） |
| 会话列表 running 状态 | 会话列表运行指示 | 🟢 已实现 |
| 会话最后一条消息预览 | 会话列表卡片 | 🟡 未实现 |
| 模型列表 | 设置页默认模型 | 🟡 `GET /api/agent` 可返回 models，需确认 |
| 扫码连接（二维码） | 连接页扫码 | 🟡 未实现 |
| 语音输入（ASR 转文字） | 聊天输入区麦克风 | 🟡 未实现，需决策客户端系统 ASR / daemon 服务端 ASR |

## 附：关键术语对照

| 术语 | 含义 |
|---|---|
| daemon | 跑在电脑上的守护进程，真正执行任务 |
| agent / runtime | 编码 CLI（当前为 Claude Code，未来可加 codex 等） |
| 会话（session / conversation） | 一次持续的对话，绑定 runtime/工作目录 |
| run | 一次「发消息 → 跑完」的执行单元；一个会话可包含多次 run |
| 工作区（workspace） | agent 干活的根目录；daemon 启动时把 `--workspace` 注册为第一个 Workspace，之后可在手机上切换 |
| Session Cwd | Session 实际启动目录，必须位于所属 Workspace 内 |
| 权限模式（permission mode） | **Session 级**配置：`ask` / `acceptEdits` / `bypass` |
| Permission Grant | Session 级“允许全部”授权，按 toolName 持久化，可撤销 |
| token | 连接鉴权密钥（64 位 hex），**不是** LLM 计费的 token |
