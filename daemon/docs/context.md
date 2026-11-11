# daemon 技术方案 · 上下文装配（ContextAssembler）

> 索引见 [daemon.md](daemon.md)。P0.3 落契约与纯函数；P1 K0 提供 curated；S1/P2 接
> runtime 注入（当前 Claude 已用原生 system prompt，其余走首条消息前导）；P4 Memory 提供 memory 段。

## 1. 契约

`ContextSection`：`kind`、`scope`、`priority`、`tokenBudget`、`content`、`source`。

固定注入顺序：

1. `runtime`：runtime 自己拥有的段落（**只有 builtin 使用**，见 §2）；
2. `workspace`：工作区 curated（WORKSPACE.md / 规范 / 知识摘要）；
3. `end`：cwd 主端的 curated（end.json / CONVENTIONS / 知识摘要）；
4. `requirements`：当前需求 / 迭代；
5. `memory`：user 画像 + observation / summary / derived 提示；
6. `task`：会话任务状态。

同一 kind 内按 `priority` 降序、`source` 升序排列。`source` 是去重键（全局唯一），
排序后第一条保留，重复项记为 `duplicate`。`scope` 只做归属标记（runtime / user / workspace /
end / session），不参与排序；记忆隔离是 Memory 的 read-policy，不在这里。

## 2. 运行时规则（重要）

- **非 builtin 的 runtime（Claude / Codex / DeepSeek）自己读取 `CLAUDE.md` / `AGENTS.md`，
  daemon 不注入、也不得重复注入。** assembler 对外部 runtime 会丢弃所有 `runtime` kind 的
  section（防御性，防止 provider 误加），并记为 `runtime-self-managed`。
- **builtin** 没有外部 agent，项目文档 / 身份 / 工具规范由 builtin 自己的 `runtime` section
  提供（P3 实现）；assembler 只负责排序与裁剪。
- 其它段（workspace / end / requirements / memory / task）来自各自 provider；
  **provider 只提供 section，不自行合并、去重或裁剪**。

## 3. 归属

| 段 | 提供方 |
|---|---|
| `workspace` / `end` / `requirements` | Knowledge / K0（P1） |
| `memory` | Memory（P4） |
| `runtime` | builtin runtime（P3）；外部 runtime 不使用 |
| `task` | 会话 / builtin 任务状态（后续） |

K0 已经提供 workspace / end / requirements section（`src/knowledge/index.ts`）。S1 把它接到
run 启动（`src/runs/knowledge-context.ts` + `run-service`）：Claude / Codex 每轮通过
system prompt / developer instructions 传入；没有原生注入通道的 DeepSeek 只在新建会话的
首条用户消息前导（resume 不重复）；builtin 走 `runtime` 段的 `workspace-knowledge`
source（每个模型 step）。

知识根 `<dataDir>/workspaces/<id>/` 同时作为 dev run 的附加目录传给 runtime
（`run-service.extraDirsForRun`），因此需要正文时模型可以直接 Read/Write，而不是依赖注入正文。

## 4. 预算

- 默认按**字符数**测量（D32）；`ContextAssemblyOptions.measure` 可注入别的测量函数（后续 tokenizer）。
- `ContextSection.tokenBudget` 是该段的硬上限；超了整段丢弃（`section-budget`），不切半条。
- 总预算 `budget` 不足时，从最终顺序的**末尾**（低优先级 / 靠后的 kind）整段丢弃，直到装下；
  不做半段截断。
- 丢弃项写入 `omitted`，并置 `overBudget`；调用方后续在 UI 显示「上下文被裁剪」，
  不静默变空。分隔符不计入 `used`（只累计各段内容长度）。

## 5. 代码与测试

- `src/context/types.ts`：`CONTEXT_KIND_ORDER` / `ContextSection` / `AssembleOptions` / `AssembledContext`。
- `src/context/assembler.ts`：`assembleContext(sections, options)`。
- `tests/context-assembler.test.ts`：顺序、去重、外部 runtime 不注入自有文档、空段、段预算、
  总预算整段裁剪、自定义 measure。

## 6. 后续

1. **已完成（K0）**：workspace / end / requirements curated section（文件 + `.meta.json`）。
2. **S1.1 已完成**：assembler 输出接到 run 启动；Claude 在探测到 `--append-system-prompt` 后
   **每轮**传稳定 block（未变化时字节一致，保 prompt cache；变化时下一轮生效）；Codex 用
   `thread/start` / `thread/resume` 的 `developerInstructions`，同样每轮刷新。DeepSeek 的
   ACP `session/new` 没有 instruction 字段，暂退回首条消息前导（resume 不再注入）。
3. **S1 后续**：DeepSeek 原生通道（若 ACP/DSH 后续提供）；工作区默认 agent / 权限。
4. P3：builtin 的 `runtime` 段（身份 / 工具规范 / 项目文档）。
5. P4：Memory 的 `memory` 段与 read-policy。
