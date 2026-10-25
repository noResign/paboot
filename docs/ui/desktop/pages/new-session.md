# ④ 新建会话（New Conversation）— 桌面

> 索引与全局规范见 [../design.md](../design.md)。移动端原页：`docs/ui/mobile/pages/new-session.md`
> ——**内容模型沿用，本文件只写桌面差异**。

### 6.4 ④ 新建会话（New Conversation）→ **居中模态**

**目的**：开始一个新对话。

**🔴 这一页属于 M1**（技术方案已定 11）：桌面端若只能打开已有会话、不能新建，M1 就不可用
（新用户没有会话可开）。而且 **Agent 选择器**必须在 M1——「在一个端上同时用 claude 和 codex」
正是本项目初衷。

**形态差异**：移动端是底部 Sheet（拇指够不着上方）；桌面改成**居中模态，宽 520**。

**关键元素**：

1. 标题「新建会话」+ 关闭。
2. **Workspace**（只读）：显示当前 Workspace 名，**不可在此切换**（沿用移动端语义）。
3. **Agent 选择**（来自 `GET /api/agents`）：带 `available`，**没装的置灰不可选**并标「未安装」；
   默认选中**第一个可用的**，而不是列表里的第一个。
   - 桌面形态：**带身份色的分段控件**（2–4 个 agent 时最合适），更多时回落为列表。
     Agent 的身份色/图标沿用 `docs/ui/shared/design-principles.md` §5.2 的映射。
4. 模型与推理强度**不在这里选**：新建会话一律沿用电脑端 Agent 的默认配置。建立会话后可在
   ③ 聊天页输入框左下角的模型下拉里切换（从下一轮开始生效）。
5. **权限模式**：默认继承当前 Workspace 的全局默认值，可在这里覆盖为 `ask` / `acceptEdits` / `bypass`。
   **每个 runtime 的三档语义不同，描述文案随之切换**（见 §6.9 的 ⑩）；未知 runtime 用中性文案。
6. 主按钮「创建」+「取消」（移动端是「固定在 Sheet 底部」；模态里随内容即可，因为内容不会太长）。

**交互**：
- `⌘N` 打开、`Esc` 关闭、`⌘Enter` 提交。
- 选择即高亮；创建成功后**自动进入该会话**并关闭模态。
- 新会话在 `POST /api/chat` 里带 `workspaceId`、`runtime`、`permissionMode`；
  服务端校验 Workspace 有效并写入 `sessions.workspace_id`。新建时不带 `model`，会话模型留空（= CLI 默认）。

**状态**：
- agents 列表加载中：分段控件占位。
- agents 全部不可用（一个都没装）：主按钮禁用 + 一行说明「本机没有可用的 agent，请先安装并登录
  Claude Code、Codex 或 DeepSeek Harness」——比让用户点了才 503 好。
- 提交中：按钮 loading；失败：（`workspace_not_found` / `unknown_runtime` / `runtime_unavailable`）
  就地红字，沿用移动端的错误映射表。

> 权限模式是 **Session 级**，不是全局只读配置。新建 Session 默认继承 Workspace 的全局默认；
> 已有 Session 的权限模式在 §6.9 的 ⑩ 里改。
