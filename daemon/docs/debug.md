# 调试指南：实时上下文监控 `/debug`

> 用来回答一个问题：**这一轮 AI 到底收到了什么，paboot 塞了哪些上下文，记忆调用了什么。**
> 纯内存、不落盘，只看当前 daemon 进程里正在跑 / 刚结束的 run。

## 1. 打开页面

1. 确认 daemon 在跑：`systemctl --user status paboot`（或你本机的启动方式）。
2. 浏览器打开：

   ```
   http://127.0.0.1:4780/debug
   ```

   远程访问把 `127.0.0.1` 换成 daemon 的局域网地址（daemon 默认监听 `0.0.0.0`）。
3. 在右上角填入 **operator token**：
   - 默认在 `~/.paboot/token`；
   - 或看 daemon 启动日志里的 `operator token: ...` 那一行。
4. token 只保存在浏览器 localStorage，请求走 `Authorization: Bearer`，不会拼进 URL。

不需要 token 也能打开 HTML 外壳，但看不到任何数据。agent token / server token 会被
`403 operator_required` 拒绝。

## 2. 采集模式与内存占用

| 模式 | 环境变量 | 行为 |
|---|---|---|
| `auto`（默认） | `PABOOT_DEBUG=auto` | 只有浏览器连着 `/api/debug/stream` 时才采集；没有连接时约 0 内存 |
| `on` | `PABOOT_DEBUG=on` | 常开采集，适合“先复现、再打开页面回看” |
| `off` | `PABOOT_DEBUG=off` | 完全关闭，页面显示 off |

- 最后一个 debug 连接断开 **30 秒**后清空全部内存数据。
- 硬上限（都可调）：

  | 上限 | 默认 | 环境变量 |
  |---|---|---|
  | 单条快照 | 1 MiB | `PABOOT_DEBUG_MAX_BYTES` |
  | 全部快照合计 | 32 MiB | `PABOOT_DEBUG_MAX_TOTAL_BYTES` |
  | 已结束 run 保留 | 10 分钟 | `PABOOT_DEBUG_KEEP_MINUTES` |
  | 每个 run 的 builtin step | 100 条 | 固定 |
  | 已结束 run 数量 | 50 个 | 固定 |
  | 每个 session 的记忆提取 | 50 条 | 固定 |

超出上限时淘汰最旧快照。

> `auto` 的代价：如果页面是在 run 进行中才打开的，之前的 step 和已经发出的
> `run-injection` 无法补录，只能从当前 step 开始看；需要“先跑再回看”就用 `on`。

## 3. 页面怎么看

左侧两栏：

- **runs（实时，进程内）**：运行中的 run 置顶，带状态点、runtime、model、快照数；
  已结束的按结束时间排序，保留 `KEEP_MINUTES`。
  - 采集开始前就已经在跑的 run 仍会列出，但带 **`未采集`** 标记：paboot 没有记录它的注入上下文。
    Claude / Codex / DeepSeek 每轮只在开始时注入一次，需要**下一轮开始前保持页面打开**；
    builtin 会从下一步模型调用开始出现。
  - 页面必须填写 operator token 并保持连接（SSE）才会触发 `auto` 采集；右上角显示
    `capture idle (auto)` 表示当前没有连接、不会采集。
- **memory extraction（后台）**：发生过记忆提取的 session 列表（含 `后台（无会话）`），
  显示调用次数和最近时间。点进去看每次提取模型调用。

选中 run 后，右侧按快照类型显示：

### run-injection（每轮一次）

paboot 在这一轮开始前注入的东西：

- `injectionMode`：上下文是怎么进去的
  - `native-system-prompt`：作为 system prompt（Claude / Codex）
  - `first-message-prelude`：拼在第一条用户消息前（DeepSeek 首轮等）
  - `skipped-resume`：本应注入，但属于 resume 且该 runtime 不支持原生注入，本轮跳过
  - `none`：没有注入（如 builtin / command 会话）
- `resumeNativeSession`：是否续接已有原生会话
- model / modelParameters / permissionMode / extraDirs
- MCP tool servers：name / command / args / env **keys**（env 值全部 `[redacted]`）
- knowledge：知识文档指针注入的正文与元数据
- memory brief：记忆摘要正文、claims 数、usedClaimIds、是否截断
- memory recall：触发词、查询词、命中数、被丢弃的条目与原因
- merged prelude：knowledge + brief + recall 合并后的最终文本
- prompt（用户原始输入）vs prompt sent（实际发给 runtime 的文本）

### builtin-step（内置 runtime，每个模型调用一步）

- 顶部：step、provider:model、maxTokens、估算 token、system/context 版本、是否超预算
- `system`：编译后的 system prompt 原文
- `runtime context`：运行时上下文快照（含 memory brief 等 contribution）
- `messages`：这一步完整发出去的消息（图片用 `[image omitted]` 占位）
- `tools`：工具 schema
- `wire body`：真正发给 provider 的请求体（OpenAI / Anthropic），排查网关协议问题很有用

### memory-extraction（后台记忆提取）

- batchKey、attempt/maxAttempts、provider:model、scope、耗时
- system + user prompt、模型原始响应
- usage、错误、是否重试、failure state（consecutiveFailures / dead）

## 4. API（都以 operator token 鉴权）

| 方法 / 路径 | 说明 |
|---|---|
| `GET /debug` | 单页 HTML（无数据） |
| `GET /api/debug/config` | 采集模式、当前是否 active、订阅数、各项上限 |
| `GET /api/debug/live` | 当前进程内的 run 列表 + 记忆提取 session 列表 |
| `GET /api/debug/runs/:runId` | run 详情 + 快照元数据（不含 payload） |
| `GET /api/debug/sessions/:sessionId/memory` | 该 session 的记忆提取快照 |
| `GET /api/debug/snapshots/:id` | 单条快照 payload；`?raw=1` 返回原文 JSON |
| `GET /api/debug/memory/state` | 提取 worker 的失败 / 重试状态 |
| `GET /api/debug/stream` | SSE 元数据流：`run-started` / `run-finished` / `run-removed` / `snapshot` |

SSE 只推元数据，payload 由页面按需拉取，避免 1 MiB 级帧阻塞连接。
浏览器 `EventSource` 不能带 `Authorization`，页面用 `fetch` + `ReadableStream` 解析 SSE。

## 5. 安全与边界

- 纯内存，重启 daemon 即清空；不写 SQLite、不落盘。
- daemon 的三个 token 精确替换为 `[redacted]`，另有 `Bearer …` / `sk-…` / `PABOOT_*_TOKEN=` 兜底。
- MCP env 值全部脱敏，只保留 key；图片 base64 替换为 `[image omitted: N base64 chars]`。
- 采集失败只 `log.warn`，不会影响 run。
- 外部 runtime（Claude / Codex / DeepSeek）的内部上下文不采集，只展示 paboot 注入部分。

## 6. 在代码里判断 debug 模式

全局开关在 `src/platform/debug-flag.ts`。`platform/` 是最底层，db / http / runtimes /
业务 domain 都可以直接 import，不会破坏分层：

```ts
import { isDebugEnabled, isDebugLive, getDebugMode } from '../platform/debug-flag.js';

if (isDebugLive()) {
  // 只在“有人正在看 debug”时执行：
  // auto 模式随 /debug 页面的 SSE 连接开关，on 模式恒为 true。
}

if (isDebugEnabled()) {
  // 总开关不是 off（auto 或 on）。适合开销很小、但只在调试期需要的逻辑。
}
```

| 模式 | `isDebugEnabled()` | `isDebugLive()` |
|---|---|---|
| `off` | false | false |
| `auto`（默认） | true | 有调试页面连接时为 true |
| `on` | true | true |

状态由 `DebugRecorder` 在构造和订阅变化时同步，业务代码不需要自己维护。
需要“只在调试时执行”的昂贵/吵杂逻辑，用 `isDebugLive()`；便宜的埋点用 `isDebugEnabled()`。

## 7. 实现位置与代码边界

调试相关代码集中在：

- `src/debug/`：`types` / `redact` / `limits` / `store`（内存环形存储 + 订阅）/
  `builders`（三类快照）/ `recorder`（best-effort 写入、auto 模式与空闲清理）/ `page*`（页面）。
- 路由：`src/routes/debug.ts`，在 `src/app/server.ts` 注册。

生产代码里只保留少量**可选接缝**，并且统一带 `[debug]` 标记：

```bash
grep -rn "\[debug\]" daemon/src
```

| 接缝 | 作用 |
|---|---|
| `src/app/config.ts` | `PABOOT_DEBUG*` 配置与 mode 解析 |
| `src/app/context.ts` | `AppContext.debug`（可选） |
| `src/index.ts` | 构造 recorder、清理定时器、memory worker 回调 |
| `src/runs/run-service.ts` | run 生命周期 + run-injection 快照 |
| `src/runtimes/builtin/driver.ts` | 把 `debugStep` 接到 recorder |
| `src/runtimes/builtin/kernel/agent.ts` | 每步模型调用前回调（可选） |
| `src/memory/extract.ts` | 提取模型的 debug sink（可选） |
| `src/memory/worker.ts` | `onExtractionCall` 回调（可选） |
| `src/runs/memory-context.ts` / `memory-recall.ts` | 额外暴露的调试元数据（`usedClaimIds`、recall 诊断） |
| `src/platform/debug-flag.ts` | 全局 `isDebugEnabled()` / `isDebugLive()` 开关（任何层可 import） |

约束由测试守护：

- `tests/debug-boundary.test.ts` 只允许 `index.ts` / `app/context.ts` /
  `routes/debug.ts` 从外部 import `debug/`；
- 同一测试还要求上表文件保留 `[debug]` 标记。

所有接缝都是**可选、best-effort**：recorder 不存在、模式为 off、或采集抛错时，run 行为不变。
