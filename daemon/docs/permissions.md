# daemon 技术方案 · 权限与安全

> 索引见 [daemon.md](daemon.md)

## 权限审批

每个 Session 有自己的权限模式：

| 模式 | Write/Edit | Bash 只读 | Bash 有副作用 |
|---|---|---|---|
| `ask` | 询问 | 自动 | 询问 |
| `acceptEdits` | 自动 | 自动 | 询问 |
| `bypass` | 自动 | 自动 | 自动，不注入 hook |

模式到 Claude Code `--permission-mode` 的映射：

```text
ask          -> default
acceptEdits  -> acceptEdits
bypass       -> bypassPermissions
```

`Read` / `Grep` **不纳入门禁**：读工作区外的文件不审批（见下文「读取不门控」）。`ask` 模式下 PreToolUse
hook 的 matcher 为 `Bash|Write|Edit|MultiEdit|NotebookEdit|mcp__.*`；`acceptEdits` 匹配
`Bash|mcp__.*`；`bypass` 不注入 hook。

`Glob` **不纳入**：它只返回文件名、不返回内容，却是探索阶段最频繁的调用，
每加一个受门禁的工具就多一次 hook 进程 spawn。

### 读取不门控

`Read` / `Grep` 不纳入 PreToolUse matcher；在 `ask` / `acceptEdits` 下，engine 同时在
传给 Claude Code 的 `--settings` 中注入 `permissions.allow: ["Read", "Grep"]`。
仅移除 hook 不会解除 CLI 自身的目录检查，显式允许规则才使工作区外的读取默认无需审批。
因此读工作区外的文件——包括 agent 自己的 `~/.claude/...` 记忆文件——默认**不审批、
不弹框，也不往工作区加任何目录**。用户或管理员显式配置的 `deny` / `ask` 规则仍优先，
其他 CLI / OS 限制也不被这份允许规则覆盖。配置在下一次 spawn 时生效。

> 安全提示：这意味着 agent 可无审批读取本机任意文件（含密钥、配置）。从客户端驱动一个带 shell
> 的 agent 时，这是刻意的取舍——之前那套「越界读取→审批→目录授权」的机制已整体移除
> （`permission-paths.ts`、hook 的离线放行、`PABOOT_ALLOWED_DIRS` 均已删除）。

**MCP 工具**（`mcp__<server>__<tool>`）与 Bash/Write/Edit 是平级的顶层工具，不属于其中任何
一类，但**在 `ask` 和 `acceptEdits` 下都纳入客户端审批**：MCP 工具能调用外部服务、产生任意副
作用，不属于「编辑类」语义，静默放行会留下绕过审批的口子。只有 `bypass` 模式不审批。

```
claude 要执行工具 → hook(permission-hook.js) → POST /api/internal/permissions/create
  → daemon 广播 permission_request（SSE）→ 客户端决定 → POST .../decision
  → hook 轮询 status → permissionDecision allow/deny → claude 放行/阻止
```

审批策略（`routes/permissions.ts` + `command-safety.ts`）：

1. **Session grant**（用户点过「允许全部 Bash」）→ 直接放行，不再广播；
2. **只读 Bash 白名单**（`ls`/`cat`/`grep`/`node --version`/`git status`…，且命令里不含
   `|`、`>`、`<`、`&`、`;`、反引号、`$` 这些 shell 元字符）→ 自动放行；
3. 其余（修改/写入/删除/未知）→ 广播给客户端，弹「允许 / 拒绝 / 允许全部」；
4. **超时或断线 → 默认拒绝**（deny-by-default）。

规则：

- `allow_all` 写入 `session_permission_grants`，作用域为 **当前 Session + 同一个 grant key**：
  普通工具是 toolName 本身（`Bash`、`Write`…），**MCP 工具是 server 级通配**
  `mcp__<server>__*`——一个 server 往往暴露几十个工具，逐个批准没法用；key 映射见
  `tool-grants.ts`（`toGrantKey` / `grantKeyCandidates`）；
- 查 grant 时 MCP 工具会同时匹配 server 级通配与早期写入的精确名字，旧 grant 继续有效；
- 「允许全部」会把当前已 pending 的、同一 grant key 覆盖的请求一并放行，并广播最终状态；
- grant 持久化到 SQLite，daemon 重启/App 重连后仍有效；
- 用户可在 Session 权限设置中撤销单条或全部；
- 切换权限模式不会清空已有 grant；切到 `bypass` 时 grant 暂时不生效，切回后继续生效；
- 权限模式只影响后续 Run，当前 Run 已经在使用的 hook/模式不会热切换。

- **超时三层对齐**：审批决策窗口由 `PABOOT_PERMISSION_TIMEOUT_SECONDS` 统一控制（默认 120 秒），
  daemon 定时器、hook 轮询兜底、Claude hook 的 `timeout` 都从它推导。
- **审批解决广播**：被审批的请求如果已经广播给客户端，之后无论用户决策、`allow-all`、超时还是
  run 清理导致状态变化，daemon 都会向该 run 的 SSE 推送一条同 `permissionId` 的状态帧。

审批状态会**写回 `events` 表**：`permission_request` 事件携带 `status` 字段（`pending` /
`allowed` / `denied` / `timed_out`）。

## 安全模型

- **认证**：非 health 的 `/api/*` 全要 Bearer token（`auth.ts` 常量时间比较）。
- **传输**：默认 HTTP 绑 `0.0.0.0`（局域网）；跨网络访问建议用组网工具放进加密内网（见 README
  「手机电脑不在同一个局域网」），内网穿透只适合自用。
- **权限**：Session 级 `ask` / `acceptEdits` / `bypass`；审批 + 只读白名单 + 默认拒绝（见「权限审批」）。
- **工作目录**：`--workspace` 只在**工作区表为空时**注册一次（首次安装），之后不再自动重建——
  用户删掉的工作区不会在重启后自己回来，目录不存在也不会让启动抛错；缺工作区时客户端可随时新增。
  每个 Session 绑定 `workspace_id + cwd`，续接和导入都要校验 cwd 位于该 Session 所属 Workspace 内，
  否则 400 `cwd_not_allowed`。**注意**：这条校验针对工作区**主目录**（新 Session 的 cwd 就取自主目录）；
  工作区还可能有附加目录（[protocol.md](protocol.md) 的「附加目录」），它们不参与 cwd 校验，只扩大 agent 的可达范围。
- **删除工作区**：默认只删注册信息（行 + 附加目录 + 浏览书签），磁盘上的目录和文件一律不动；
  有 Session 时 409 `workspace_not_empty`，`?cascade=1` 才会连 Session（含聊天记录、run、事件、
  会话级授权）一起删。级联会先取消这些 Session 在跑的 run。**级联不删**
  `~/.claude/projects/<cwd>/<id>.jsonl`——那是 Claude Code 自己的会话记录，删了会破坏电脑上的续接，
  所以同一目录重新加成工作区后，`GET /api/claude-sessions` 仍会列出它们。
- **默认工作区不可删**（409 `workspace_is_default`）：它是客户端没指定工作区时的落点，删了新会话
  无处落地。要删就先把另一个设为默认。这条顺带保证了「永远删不掉最后一个工作区」——最后一个必然
  是默认的那个，所以「零工作区」这个状态不可达，`resolveWorkspaceForRequest` 不会拿到 null。
- **Workspace 嵌套**：允许父子包含关系（典型场景：daemon `--workspace` 指向根目录，之后把其下的
  子目录注册成独立 Workspace）。Session 的归属靠自身 `workspace_id`，不从路径前缀推导；前缀只用于
  校验 cwd 位于所属 Workspace 内，因此嵌套不影响归属正确性。唯一的语义放宽：查询外层 Workspace 的
  TUI 会话列表时会包含落在内层 Workspace 里的会话（外层视为「其下所有内容」）。
- **防御性超时**：run 空闲看门狗（`PABOOT_RUN_IDLE_TIMEOUT_SECONDS`，默认 900 秒、0=禁用）。
- **审计**：所有写操作与 `browse_root` 记入 `audit_log`（清单见 [protocol.md](protocol.md) 的「数据模型」）。
- **CORS**：`Access-Control-Allow-Origin: *` 仅为让网页客户端可用；真正边界是 token。

### ⚠️ 重要边界：`workspace` 不是沙箱

`workspace` 只决定 **Claude 进程从哪个目录启动（spawn cwd）**，**不是文件系统沙箱**。
Claude 启动后，访问别的目录由「工具权限」决定，与 workspace 无关。
下表为**实测**行为（2026-09，Claude Code 当前版本）：

| 工具 | 行为 |
|---|---|
| Read / Grep | **不受 paboot 门禁**（matcher 不含它们），读任意路径都放行（见上文「读取不门控」） |
| Glob | 不受 paboot 门禁（matcher 不含它），只返回文件名 |
| Write / Edit / MultiEdit | `ask` 下弹审批；`acceptEdits` / `bypass` 下**直接放行**，可写任意路径 |
| Bash 只读（`cat`/`ls`/`grep`…） | 自动放行，**完全不看路径**——`cat <工作区外文件>` 一样放行 |
| Bash 有副作用 | 弹审批（审批的是命令本身，不专门按目录拦截） |

**因此读取从来不构成边界**：`Read` 与 `cat` 都放行，终点一致——paboot 对读取不做任何拦截。
曾评估给只读 Bash 白名单补路径校验以堵住这条，**已决定不做**——读命令放行的影响可接受，
而 agent 本就有 Bash 权限，堵住 `cat` 收益有限。（`env` 泄露 `PABOOT_TOKEN` 同理：
读命令本来就放行，摘掉 `env` 只是装饰。**但注意这不是「同一个值」**——见 [configuration.md](configuration.md) 的「token 解析顺序」，
env 命中时 `<data-dir>/token` 里可能是旧值。）

要做到文件级物理隔离，需要 OS 层沙箱（bwrap / firejail / 容器 / sandbox-exec），纯靠 Claude
Code CLI 做不到。`workspace` 的准确语义是「**从哪个目录启动**」，不是「只能碰哪些目录」。

### 授权的作用域

只剩一个「允许」：工具授权（「允许全部」），作用域 **Session + toolName**（MCP 为 server 级
通配），落点 `session_permission_grants`，在 Session 权限页撤销。

早期还有一类「目录授权」——批准越界读取后把目录记到工作区；随读取门控一并移除了。
现在 `workspace_dirs` 只是「手动添加的附加目录」（见 [protocol.md](protocol.md) 的「附加目录」），不来自任何审批。
