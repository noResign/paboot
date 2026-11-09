# Capability（Dev Space S2）

> 代码在 `daemon/src/capabilities/`；MCP server 在 `daemon/src/mcp/servers/paboot_capability/`。

## 1. 注册表与作用域

`registry.ts` 描述能力族（不是 MCP server 本身）：

| id | families | scope | server | 说明 |
|---|---|---|---|---|
| `tasks` | dev / life | workspace | `paboot_tasks` | 始终注入，不参与 binding |
| `android-device` | dev | end | `paboot_capability` | 需要活跃 Android 端 |
| `mock` | dev | workspace | `paboot_capability` | S2 文件模型，后续接 C1 |

`capability_bindings(scope_type, scope_id, provider_id, enabled, config_json)` 存在主库：

- `scope_type` = `workspace` / `end` / `session`；解析时**最近作用域优先**（session > end > workspace），
  同一 provider 只取最近一层。
- 只有 `enabled=1` 且 family 与 workspace 匹配的 binding 才会挂载对应 MCP server。
- `scope=end` 的能力即使有 workspace binding，也必须存在活跃端。
- 端解析：`sessions.end_id` 优先；否则用 `end_roots` 的最长匹配前缀（客户端传入的 id 不生效）。

`GET /api/internal/mcp/capability/scope?runId=` 返回 `{ runId, sessionId, workspaceId, endId, family }`，
供 capability MCP server 反查作用域（只接受 server token）。

## 2. Android device provider

- 位置：`capabilities/providers/android/`（`adb.ts` / `ui-dump.ts` / `index.ts`）。
- adb 发现顺序：`PABOOT_ADB_PATH` → `ANDROID_HOME` / `ANDROID_SDK_ROOT` → 平台默认路径 → PATH。
- 所有命令走 `execFile`（无 shell）、带超时与 32 MB buffer；serial 未指定时要求设备唯一。
- 错误码：`adb_missing` / `adb_timeout` / `adb_failed` / `device_offline` / `device_ambiguous` /
  `selector_not_found` / `input_text_unsupported` / `screenshot_invalid`。
- 输入文本只支持 printable ASCII（空格转 `%s`），中文输入留给后续输入法方案。
- `ui_dump` 用 `uiautomator dump` + `exec-out cat`，按 text / resource-id / content-desc / class
  精确匹配，优先 clickable 节点，取 bounds 中心点。

## 3. 内部端点

`POST /api/internal/capability/device/:action`（server token）：

| action | 参数 | 返回 |
|---|---|---|
| `list` | — | `{ devices }` |
| `screenshot` | `serial?` | `{ png(base64), mimeType, width, height, serial }` |
| `ui-dump` | `serial?` | `{ nodes }` |
| `tap` | `x`, `y`, `serial?` | `{ ok, x, y, serial }` |
| `tap-selector` | `selector{text,resourceId,contentDesc,className}`, `serial?` | `{ ok, x, y, serial }` |
| `input-text` | `text`, `serial?` | `{ ok, serial }` |
| `key-event` | `key`, `serial?` | `{ ok, serial }` |
| `launch-app` | `package`, `serial?` | `{ ok, serial }` |
| `logcat` | `lines?`, `serial?` | `{ text }` |
| `current-activity` | `serial?` | `{ activity }` |

- 只允许 dev workspace 且存在活跃端；life → 403 `capability_not_allowed`，无端 → 409 `end_missing`。
- 变更类 action（tap / tap-selector / input-text / key-event / launch-app）写 `capability_device` audit。

## 3.1 端管理与操作路由（operator）

| 端点 | 方法与说明 |
|---|---|
| `GET /api/workspaces/:id/ends` | 列出端（含 roots） |
| `GET /api/workspaces/:id/end-suggestions` | 扫描 workspace 根目录（深度 ≤4）中的 Gradle / `AndroidManifest.xml` |
| `POST /api/workspaces/:id/ends` | `{name, kind?}` 创建 `draft` 端（仅 dev） |
| `POST /api/workspaces/:id/ends/:endId/roots` | `{path}` 绑定目录；必须位于 workspace 内 |
| `POST /api/workspaces/:id/ends/:endId/activate` | 至少一个 root 后激活，并写入 `android-device` 的 end binding |
| `GET /api/workspaces/:id/device` | 设备列表 + 当前 serial |
| `POST /api/workspaces/:id/device/select` | `{endId, serial}` 记住设备 |
| `GET /api/workspaces/:id/device/screenshot` | PNG 字节（operator；agent 一律 403） |
| `POST /api/workspaces/:id/device/action` | 与内部端点相同的 action 集合，供桌面 / CLI 使用 |
| `GET /api/workspaces/:id/device/stream` | 独立 SSE 镜像流；首个订阅启动、最后一个离开停止 |

SSE 帧：`{type:'frame', endId, serial, png(base64), width, height, ts}`；错误帧
`{type:'error', code, message}`。默认 2 fps，抓取仍在进行时丢帧而不是排队。

## 3.2 CLI 兜底

MCP 不可用的 runtime 可用：

```bash
paboot-capability android list --workspace <id>
paboot-capability android screenshot --workspace <id> --end <endId> --out shot.png
paboot-capability android tap --workspace <id> --x 120 --y 340
paboot-capability android tap-selector --workspace <id> --selector-text 登录
paboot-capability android input-text --workspace <id> --text "hello world"
paboot-capability android key-event --workspace <id> --key back
paboot-capability android launch-app --workspace <id> --package com.example
paboot-capability android logcat --workspace <id> --lines 50
```

环境变量：`PABOOT_DAEMON_URL`、`PABOOT_TOKEN`（operator）。CLI 不自行审批；它经 Bash
调用时已受现有 Bash 审批约束。

## 4. MCP 工具与审批

`paboot_capability` 暴露 10 个 `android_*` 工具。审批策略：

- 需要审批（`requireToolPermission`，服务端自 gate）：screenshot、ui_dump、tap、tap_selector、
  input_text、key_event、launch_app。
- 只读诊断不弹窗：device_list、logcat、current_activity。
- builtin runtime 由 `ToolExecutor` 统一审批，server 不重复弹窗（`PABOOT_RUNTIME=builtin`）。

`stdio-server.ts` 支持 `text | image` 内容块；builtin 的 MCP client 没有图片渲染，截图降级为
`[image omitted: builtin runtime cannot render images]`，Agent 可用 CLI 兜底。

## 5. 兼容性

- adb 路径、`.exe`、时间戳与 buffer 处理均为跨平台；Windows 走 `adb.exe` 发现顺序。
- 能力未启用时 `paboot_capability` 不注入，现有 tasks / memory 不受影响。

## 6. 测试

- `tests/android-device.test.ts`：设备解析 / serial 选择 / PNG 尺寸 / UI dump / selector / 输入守卫 /
  action 路由与 family / end 校验。
- `tests/capability-scope.test.ts`：binding 最近者优先、family 拒绝、`end_roots` 解析、scope 端点。
- `tests/capability-mcp.test.ts`：工具列表、审批 gate、截图 image block。
- `tests/capability-routes.test.ts`：端建议 / 创建 / 绑定 / 激活、operator 设备路由与 403、
  SSE 帧、CLI 参数与截图落盘。
