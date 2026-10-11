# Ⓟ 权限审批浮层（Permission Approval）

> 文档索引见 [../README.md](../../README.md)；Design Tokens 与组件库见 [../design-principles.md](../../shared/design-principles.md)。章节编号沿用拆分前的 `ui_design.md`，未重新编号。

### 6.7 Ⓟ 权限审批浮层（Permission Approval）🔴 M1 安全必需

**目的**：agent 想执行需要审批的工具时，暂停运行，由用户允许/拒绝。这是本产品的**安全边界**。

**触发**：聊天流中出现 `permission_request` 事件，内容为
`{permissionId, toolName, toolInput, status}`。

> `Read` / `Grep` 不纳入审批（读工作区外不弹框），所以本浮层不会再收到这两个工具。

**按工具类型渲染**：

| toolName | 展示内容 |
|---|---|
| `Bash` | command 全文，等宽、可滚动、长按复制 |
| `TerminalInput` | 同 `Bash`（Codex 向运行中的命令写 stdin；与 `Bash` 分成两个 toolName，避免「允许全部」跨用） |
| `Write` | 文件路径 + 内容预览 |
| `Edit` / `MultiEdit` | 文件路径 + diff；Codex 的 `changes` 数组逐项展示路径、操作类型、重命名目标和 diff |
| `Permissions` | Codex 的权限档案扩展：网络开关、读取/写入路径（含 `special` 路径的中文标签）、原因 |
| `UserInput` | 不是审批，见 6.7.1 |
| 其他 | 通用 `toolInput` JSON 展示 |

**界面**（全屏覆盖浮层，modal，不可通过点外部关闭）：
1. 头部：警示图标 + 标题「⟨Agent 展示名⟩ 请求执行」（取自 §5.2 的身份映射，未知 id 兜底为「Agent」）。
2. 工具名（如 `Bash` / `Write`）。
3. **工具参数主体**：按上表渲染。
4. 安全提示小字："此操作可能修改文件或系统，请确认安全后再允许。"
5. 超时提示：`超时未处理将自动拒绝`（不写死 120 秒，超时值由 daemon 配置决定）。
6. 操作按钮：
   - **允许**（primary）→ `{decision: "allow"}`；
   - **允许全部（本 Session）**（secondary）→ `{decision: "allow_all"}`；
   - **拒绝**（error）→ `{decision: "deny", reason?}`。
7. 拒绝时展开可选理由输入框。

**“允许全部”说明**：

- 作用域：当前 Session 后续所有 **同一个 toolName**（MCP 工具是**整个 Server**）；
- 例如：Bash 弹窗点“允许全部” → 本 Session 后续所有 Bash 免问；
- 不会自动放行 Write/Edit 等其他工具；
- 可在 ⑩ 会话权限设置里撤销。
- **例外**：Codex 的 `Permissions` 卡片授权的是「权限扩展」这一类请求本身，所以它的「允许全部」=
  本 Session 后续**任意路径、任意网络范围的扩展**都自动批准。卡片警示文案必须写明这一点，
  否则用户按「允许全部」时的预期只是卡片上列出的那几个路径。
- 撤销只影响**后续**请求，撤不回已经批准过的操作；Codex 的权限扩展在服务端可延续到当前轮结束，
  要立即收回只能停止运行（见 ⑩）。

**状态**：
- pending：等待用户作答；
- 已处理：浮层关闭；
- 超时：浮层自动消失，并在消息流里显示“命令审批超时，已自动拒绝”。

#### 6.7.1 Ⓟ′ 需要你的回答（User Input）🔴 M1 安全必需

**触发**：`permission_request` 的 `toolName == "UserInput"`（Codex 的用户提问与 MCP elicitation）。
它复用审批的 pending / 超时生命周期，但**不是审批**：

- 按钮只有「拒绝」和「提交回答」，**没有「允许全部」**（daemon 对该决定直接返回 400）；
- 答案只回给提供方，**不写入聊天历史、不进 SSE**；未处理按超时拒绝；
- 按 `toolInput.kind` 渲染：
  - `questions`：逐题展示选项按钮 + 自由输入框（`isSecret` 用密码框）；
  - `form`：按 `requestedSchema` 的字段/类型渲染，选项类字段展示可选值；
  - `url`：展示链接与「打开链接」，并说明**打开链接不等于批准**；
  - `unsupported`：只能拒绝，提示改用受支持的方式。
- **错误就地显示**：本地能查的（必填、非空）在弹窗内报错；服务端校验失败（`bad_response`）
  同样必须回填到弹窗内——snackbar 在 Activity 的 Scaffold 里，会被模态遮罩压住，用户只会
  看到「点了没反应」。服务端消息里的字段细节（`Invalid option: x`）不能丢。
