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
没有 argv 可拼、也没有逐行 stdout 可解析，所以不实现 `RuntimeAdapter`：`registry.ts` 用
`RuntimeDetector`（只回答「装没装」「有哪些 model」）登记它，运行由 `runtimes/codex/session.ts`
自行驱动。`routes/chat.ts` 按 runtime id 选择引擎，**接入这类运行时需要改 chat 路由**——
这是两条路径的区别所在。

**事件流是 runtime 无关的**：客户端只认 `NormalizedEvent`，不感知底层是哪个 CLI。
