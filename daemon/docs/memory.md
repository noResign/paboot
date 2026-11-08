# paboot Memory（M0）

> 长期记忆的 life 垂直切片。设计源在 `docs/local/paboot_memory/`（私有笔记，不入库）；
> 本文件只描述 daemon 已实现的行为、配置与边界。

## 1. 范围

M0 只处理 `workspace.family = 'life'` 的会话：

- 会话结束后捕获 user / assistant 可见文本；
- 后台用共享 LLM 抽取 claim（事实 / 偏好 / 关系 / 画像）；
- 新会话注入 life brief；
- 客户端只读 + 改正 / 忘记。

**不做**：dev 记忆、工具事件、observation / session summary、检索阶梯、实体归一、去重候选、
强化、memory MCP、主动提醒。这些在 M1 / M2 / M3。

## 2. 存储

- 独立库 `<dataDir>/memory/memory.db`，WAL + `busy_timeout=5000`。
- 不与主库做跨库外键；主库只保留 `memory_settings` / `sessions.memory_mode` 等开关。
- M0 使用的表：`mem_sources` / `mem_claims` / `mem_claim_evidence` / `mem_tombstones` /
  `mem_ops` / `mem_state`；完整 schema 已建好，供 M1/M2 使用。
- `mem_state.schema_version` 由 memory.db 自己维护。

## 3. 捕获

- 触发：`runs/run-service.ts` 在 run 终态与 assistant 消息落库后，`setImmediate`
  异步投递，不阻塞 SSE。
- 来源：主库 `messages`（builtin 也走这里；M1 再接 `native_messages` / 工具事件）。
- 幂等键：`scope + end + session + source_table + message_id`（无 message id 时用 content hash）。
- 过滤（D30）：`<private>` / `<no-memory>` 整段剥离；`<paboot-memory-context>` 注入块剥离；
  command / task_config 会话不捕获；`memory_mode=off` 不捕获，`no_injection` 仍捕获。
- 墓碑：删除 claim 时写入 tombstone；相同原话不会再次成为 source / claim。
- `off → normal/no_injection` 时把当前会话最大 message id 记为捕获水位；关闭期间的消息不会被回填。

## 4. 抽取

- 配置：桌面设置 → 模型 Provider → 在模型目录勾选「用于记忆」（单选）。设置值写入
  主库 `settings.memory_model`，优先于 `PABOOT_MEMORY_MODEL`（后者只作无 UI 部署兜底）。
  两者都没有 = 仅记录（`none`）：source 保持 `pending`，配置后 worker 自动消化 backlog。
- Provider 删除 / 禁用模型 / 清空 key 会清理失效的 `memory_model` 设置，避免 status 谎报自动整理。
- 只接受**已启用且有 API key** 的模型；`PATCH /api/config { memoryModel }` 会校验，
  无效返回 400 `invalid_memory_model`；`null` 清除设置并回落到 env。
- 不自动挑选第一个可用 provider，避免生活数据被发到用户没选的模型。
- 严格 JSON + 受控 predicate；未知 predicate / 无 evidence / quote 回源失败 / `secret`
  一律丢弃。
- 会话级 scope 由服务端解析，模型只产 candidate。
- Tier-0：`dedupKey = hash(predicate + normalized object)` 相同则合并证据，不新增行。
- worker 单写者。捕获即时，抽取防抖：
  - 每次 run 结束只写 pending；单条消息不会立刻触发 LLM；
  - **按会话统计**：同一会话 pending 达到 6 条消息，立即抽取；
  - 否则该会话空闲 30s 后抽取；30s tick 是 backlog / provider 恢复 / 重启的兜底；
  - **turn 不可拆**：`run_id` 相同的 user / assistant 消息始终在同一次调用里；
  - 批量只在 turn 边界切分；每轮最多取 200 条 pending，单次最多 20 条消息；
    字符预算按模型 context window 动态计算（保留 25% 给 system/output，32K 模型约 24K 字符）；
    单个 turn 超过上限也完整处理，不切半；
  - 每批会带该会话前 4 条已处理消息作为只读 context，帮助指代/背景理解；
    context 不能作为 claim 的 evidence；
  - schema 失败重试 1 次，连续失败 3 次后停靠 source。

## 5. 注入

- life brief 由 `memory/brief.ts` 确定性拼装：`## 关于你` / `## 偏好` / `## 注意`；
  每条带短 ID（`#claim_ab12`）与有效期。
- 预算：D32 按字符测量，默认 1200；整条丢弃，至少保留 1 条；`secret` 永不注入。
- 注入块：`<paboot-memory-context>…</paboot-memory-context>`。
- 外部 runtime：与 K0 知识合并后走 native system prompt / 首条消息前导；resume 默认不重注入。
- builtin：`MemoryBriefContextSource` 进入 ContextAssembler 的 runtime-context。
- `sessions.memory_mode = off | no_injection` 不注入。

## 6. HTTP

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/memory/brief` | GET | `sessionId` 或 `scope`；返回 brief |
| `/api/memory/claims` | GET | 列表，可带 `status` |
| `/api/memory/claims/:id` | GET / PATCH / DELETE | 查看 / 改正（operator）/ 忘记（operator） |
| `/api/memory/feedback` | POST | 记录 helpful / wrong / stale / corrected |
| `/api/memory/remember` | POST | 客户端「记住这个」（`sessionId` + `messageId`） |
| `/api/memory/status` | GET | pending / 最近整理 / 失败次数 / extraction model / modelAvailable |
| `/api/memory/session` | PATCH | 会话级 `memory_mode` |

- 所有端点必须带 `sessionId` 或显式 `scope`，没有默认全局。
- GET 允许 agent token；写端点由现有 role policy 限定 operator token。
- M0 对 dev workspace 返回 `400 memory_not_enabled`。
- claim 读写都校验 scope，防止跨工作区 IDOR。

## 7. 已知限制

- M0 只处理 life；`scope=user` 可读但为空（用户画像 / 晋升在 M1）。
- claim 只有 user 主语；relation 以 object text 表示，不建 entity / episode / loop。
- 客户端「记住这个」按钮与移动端会话级记忆开关尚未接线（API 已就绪）。
- 真实 provider 的抽取质量尚未评估；自动化 fixture 只验证管线与护栏。
