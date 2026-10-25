# ④ 新建会话（New Conversation）

> 文档索引见 [../README.md](../../README.md)；Design Tokens 与组件库见 [../design-principles.md](../../shared/design-principles.md)。章节编号沿用拆分前的 `ui_design.md`，未重新编号。

### 6.4 ④ 新建会话（New Conversation，底部 Sheet）🟢

**目的**：开始一个新对话。

**关键元素**（Sheet 内）：
1. 标题「新建会话」+ 关闭。
2. **Workspace**（只读）：显示当前选中的 Workspace 名，**不可在 Sheet 内切换**。新会话固定归属当前
   Workspace；要在其他 Workspace 建会话，先去 ⑧ 工作区管理切换当前 Workspace。
3. **Agent 选择**（单选，来自 `GET /api/agents`）：带 `available`，**没装的置灰不可选**并标「未安装」，
   列表顺序不变（用户仍能看到有哪些 agent）；默认选中**第一个可用的**，而不是列表里的第一个。
4. 模型与推理强度**不在这里选**：新建会话一律沿用电脑端 Agent 的默认配置。建立会话后可在
   ③ 聊天页输入框下方的「模型」入口切换（从下一轮开始生效）。
5. **权限模式**：默认继承当前 Session 所属 Workspace 的全局默认值，可在这里覆盖为 `ask` / `acceptEdits` / `bypass`。
   **每个 runtime 的三档语义不同，描述文案随之切换**（见 ⑩ 会话权限设置）；未知 runtime 用中性文案。
6. 主按钮「创建」：**固定在 Sheet 底部**，不随内容滚动。Sheet 主体（Agent / 权限模式）内部滚动，
   列表再长也不会把主按钮挤出屏幕。

**交互**：选择即高亮；创建成功后自动进入该会话并收起 Sheet。
新会话在 `POST /api/chat` 里带 `workspaceId`、`runtime`、`permissionMode`；服务端校验 Workspace 有效并写入 `sessions.workspace_id`。新建时不带 `model`，会话模型留空（= CLI 默认）。

> 客户端不提供「续接本机 Claude 会话」入口。

> 权限模式是 **Session 级**，不是全局只读配置。新建 Session 默认 `ask`；全局 `default_permission_mode` 可配置为 `acceptEdits`。已有 Session 的权限模式在 ⑩ 会话权限设置里修改。
