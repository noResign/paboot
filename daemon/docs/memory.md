# paboot Memory（M0 + M1.1）

> 长期记忆的 life 垂直切片 + M1.1 的 workspace scope / 开关 / read-policy。设计源在
> `docs/local/paboot_memory/`（私有笔记，不入库）；本文件只描述 daemon 已实现的行为、配置与边界。

## 1. 范围

已实现：

- life 会话结束后捕获 user / assistant 可见文本；
- 后台用共享 LLM 抽取 claim（事实 / 偏好 / 关系 / 画像）；
- 新会话注入 brief；
- 客户端只读 + 改正 / 忘记；
- **M1.1**：dev workspace 可选开启记忆；每 workspace 开关 / 注入开关 / provider override；
  life 的 `profileMode`、dev 的 `lifeReadable`；读写都走统一的 read-policy。
- **M1.2**：D31 检索阶梯；K2 知识文档索引；life → user 晋升；run 结束生成 observation +
  session summary，文件列表从结构化工具事件机械提取；搜索支持 `files` 过滤，提供 timeline。

**不做**（后续 M1/M2/M3）：工具事件、observation / session summary、检索阶梯、实体归一、
去重候选、强化、memory MCP、主动提醒；`provider_override` 目前只持久化，尚未参与抽取模型解析。

## 2. 存储

- 独立库 `<dataDir>/memory/memory.db`，WAL + `busy_timeout=5000`。
- 不与主库做跨库外键；主库只保留 `memory_settings` / `sessions.memory_mode` 等开关。
- `memory_settings` 按 workspace 一行：`enabled` / `injection_enabled` / `provider_override`。
  **缺行时按产品默认**：dev 关、life 开、注入开、`profileMode=portable`、`lifeReadable=0`。
  写入前先合并默认值，避免只改注入开关把 life 静默关掉。
- `workspaces.profile_mode`（life）与 `life_readable`（dev）由
  `GET/PATCH /api/workspaces/:id/memory` 维护。
- M0 使用的表：`mem_sources` / `mem_claims` / `mem_claim_evidence` / `mem_tombstones` /
  `mem_ops` / `mem_state`；完整 schema 已建好，供 M1/M2 使用。
- **K2**：`mem_documents` / `mem_document_chunks` / `mem_search`。文件与 `.meta.json` 仍是真源，
  这三张表是可重建索引；正文不进 memory.db，只存 chunk 文本用于检索。

### K2 索引

- `MemoryKnowledgeIndexer.syncWorkspace()` 把 `.meta.json` 镜像成 document + chunk：
  标题 / 段落切块（约 2000 字符），hash 未变则复用；正文变化重建 chunk 与 `mem_search`。
- 权威映射：`authority=curated` 且 `reviewStatus=confirmed` → `curated`，其余 → `derived`。
- 文件消失 / 删除 → 删除镜像与索引；外部修改在 knowledge 列表 reconcile 后同步。
- 触发：daemon 启动时全量同步；knowledge 列表 / 新建 / 编辑 / 核验 / 删除后同步。
  索引失败只 warn，不影响知识接口。
- `mem_state.schema_version` 由 memory.db 自己维护。

## 3. 捕获

- 触发：`runs/run-service.ts` 在 run 终态与 assistant 消息落库后，`setImmediate`
  异步投递，不阻塞 SSE。
- 写 scope：`workspace:<id>`。life 默认开启；dev 仅在 `memory_settings.enabled=1` 时捕获。
  `end_id` 仅作为标签（life 端 / dev 端），不做隔离。
- 来源：主库 `messages`（builtin 也走这里；M1 后续再接 `native_messages` / 工具事件）。
- 幂等键：`scope + end + session + source_table + message_id`（无 message id 时用 content hash）。
- 过滤（D30）：`<private>` / `<no-memory>` 整段剥离；`<paboot-memory-context>` 注入块剥离；
  command / task_config 会话不捕获；`memory_mode=off` 不捕获，`no_injection` 仍捕获。
- 墓碑：删除 claim 时写入 tombstone；相同原话不会再次成为 source / claim。
- `off → normal/no_injection` 时把当前会话最大 message id 记为捕获水位；关闭期间的消息不会被回填。
- **observation / summary（M1.2）**：run 结束后，同一个异步捕获先写一条机械 `turn`
  observation + session summary（标题取首条用户消息，narrative 取最后一条 assistant 文本），
  随后 worker 的抽取调用（与 claim 同一次 LLM 请求）可返回 `observations` / `summary`：
  - LLM observation 替换同 source 的机械基线；`files_read` / `files_modified` 始终保留
    服务端从 `tool_use`（Read / Write / Edit / MultiEdit / NotebookEdit）机械提取的值，
    Bash 不猜。
  - LLM summary 覆盖 request / investigated / learned / completed / notes；`nextSteps`
    同时写一条 open `followup` loop 候选（同 scope + 标题去重）。
  - `(scope, source_id, content_hash)` / `(session_id, run_id)` 保证幂等。
  - provider=none 时机械基线仍保留；配置 provider 后 LLM 结果替换基线。

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
- **实体（M2）**：抽取可返回 `entities{tempId,kind,name,aliases}`；worker 在 scope 内按
  canonical / alias 精确 upsert，claim 可用 `subjectEntity` / `objectEntity` 引用 tempId。
  跨 scope 只建 `mem_entity_links`，不自动 merge；显式 merge 会把 claim 引用改指目标实体并
  保留 `merged_into` / `mem_ops`。
- 会话级 scope 由服务端解析，模型只产 candidate。
- **Tier-0 精确**：`dedupKey` 相同或 `(scope, end, predicate, normalized object)` 相同 →
  合并证据、追加 `reinforcement_dates`；不新增行。`derived` 重复不会降级
  `user_confirmed`，反向会升级并采用新 summary。
- **功能型谓词冲突**：`lives_in` / `works_at` / `name` / `birthday` 的旧值在新值有更晚
  `validFrom` 时标记 `superseded`（`valid_to = 新.valid_from`）；同起点且置信度接近 →
  双双 `disputed`；`user_confirmed` 永不被自动 supersede。多值谓词（likes / plans / goals /
  relations）保留多条 active。
- **Tier-1 近似**（D33）：语料 ≥ 20 条后启用，同 scope + predicate 上做 IDF 加权 cosine
  （CJK bigram + Latin token）；≥ 0.72 写入 `mem_claim_duplicates(status=pending)`，
  **不自动合并**；对称差里的稀有 identifier token（如 `ffmpeg-7.1` vs `6.1`）否决候选。
  `merged / distinct / dismissed` 由后续审核入口更新。
- **强化 / 排序**（D34）：重复确认按天追加 `reinforcement_dates`（FIFO 10，不改 confidence）；
  brief 用 ACT-R recency 选材（α=0），并保护最新 25% 不被预算裁掉。
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

- brief 由 `memory/brief.ts` 确定性拼装：`## 关于你` / `## 偏好` / `## 注意`；
  每条带短 ID（`#claim_ab12`）与有效期。
- **read-policy**（`memory/read-policy.ts`）：
  - dev：只读当前 workspace；
  - life：`user`（按 `profileMode` 过滤）+ life workspace + 每个 `life_readable=1` 且已启用的
    dev workspace（**normal 级、只读**）；
  - `secret` 永不读取；`private` 不跨 workspace；dev 注入时 privates 也不注入。
  - 显式 `scope=user` 是 operator 级只读入口。
- 预算：D32 按字符测量，默认 1200；整条丢弃，至少保留 1 条；`secret` 永不注入。
- **按轮召回**：每轮用消息生成 2–4 字 n-gram 检索（D31）。有「上次 / 之前 / 记得 / 我说过 /
  继续 / 接着」等明确线索时直接召回；没有线索时要求至少命中一个 ≥3 字段或两个 ≥2 字段，
  避免无关新会话串入别人的时间线。open loop 标题命中（或「继续」线索）时优先注入
  `[未完成]` 项。取最多 5 条 claim / observation / summary / document，按 read-policy 过滤后
  作为 `## 相关记忆` 追加。Claude / Codex 每轮生效；只有首条前导的 runtime（DeepSeek resume）
  只在首轮生效；builtin 目前只注入 brief。
- **检索（D31）**：`mem_search` FTS5 trigram。查询 ≥3 个码点时先走 FTS（子串 + bm25），
  无命中退 LIKE；1–2 个码点直接 LIKE；多词再退「任一词 OR」并按命中次数排序。
  `secret` 不建索引；`private` 只在允许它的 scope 返回；`excluded` source 不返回。
  claim 命中会再校验 read-policy 与 active 状态，source 命中通过 `/api/memory/sources/:id`
  取 L0 原文；document 命中返回标题 + 摘要 + 相对路径（正文由 agent Read 文件）；
  observation / summary 命中返回标题、摘要与 files 列表。
- **files 过滤**：`files=a,b` 时只返回带文件元数据的 observation / summary，并要求
  `files_read` / `files_modified` 包含任一请求值（子串匹配）。
- **timeline**：把 read-policy 内所有 scope 的 observation + session summary 按时间倒序合并；
  只用于展示，不整段进 prompt。
- **时间线不进 prompt**：当前会话自己的 observation / summary 本来就是已有对话的压缩版，
  runtime 历史里已经有，再注入只会重复并破坏 prompt caching；因此自动注入只保留 claim brief
  与按轮召回。时间线保留给 UI（workspace 级总览，每条带 `sessionId`）和相关性召回。
  未来如果检测到 runtime 已压缩历史，再考虑注入一次摘要。
- 注入块：`<paboot-memory-context>…</paboot-memory-context>`。
- 外部 runtime：与 K0 知识合并后走 native system prompt / 首条消息前导；resume 默认不重注入。
- builtin：`MemoryBriefContextSource` 进入 ContextAssembler 的 runtime-context，使用同一份
  settings + read-policy。
- `sessions.memory_mode = off | no_injection` 不注入；workspace 关闭或
  `injection_enabled=0` 也不注入（仍按开关决定是否捕获）。

## 6. HTTP

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/memory/brief` | GET | `sessionId` 或 `scope`；返回 brief |
| `/api/memory/claims` | GET | 列表，可带 `status` |
| `/api/memory/claims/:id` | GET / PATCH / DELETE | 查看 / 改正（operator）/ 忘记（operator） |
| `/api/memory/claims/:id/promote` | POST | life → user 晋升；新建 user claim + `promoted_from`，源 claim 与 evidence 保留 |
| `/api/memory/feedback` | POST | 记录 helpful / wrong / stale / corrected |
| `/api/memory/remember` | POST | 客户端「记住这个」（`sessionId` + `messageId`） |
| `/api/memory/search` | GET | `q` + `sessionId`/`scope`（可选 `files`）；D31 检索阶梯，返回 claim / source / observation / summary / document 命中 |
| `/api/memory/timeline` | GET | observation + session summary 时间线 |
| `/api/memory/loops` | GET | 当前可读 scope 的 open loops |
| `/api/memory/sources/:id` | GET | L0 原文（read-policy 过滤） |
| `/api/memory/status` | GET | pending / 最近整理 / 失败次数 / extraction model / modelAvailable |
| `/api/memory/session` | PATCH | 会话级 `memory_mode` |
| `/api/workspaces/:id/memory` | GET / PATCH | 生效值 + 开关 / `profileMode`（life）/ `lifeReadable`（dev）/ `providerOverride` |

- 所有 memory 端点必须带 `sessionId` 或显式 `scope`，没有默认全局。
- GET 允许 agent token；写端点由现有 role policy 限定 operator token。
- 未启用的 workspace（dev 默认、或显式关闭的 life）读 / 写 claims 返回 `400 memory_not_enabled`；
  **会话级 `memory_mode` 例外**：即使 workspace 未启用也能保存（只是暂时不产生效果）。
- claim 读取走 read-policy；PATCH / DELETE / feedback 只允许调用方自己的 scope，
  跨 workspace 读到的 dev claim 是只读的。
- 设置端点按 family 校验字段：`profileMode` 仅 life，`lifeReadable` 仅 dev。

## 7. MCP 工具

`paboot_memory` 随每个 run 注入（external + builtin），env 带 `PABOOT_RUN_ID` /
`PABOOT_SESSION_ID` 与 **server token**；scope 由 daemon 从 run → session 解析，模型不能指定。
工具走 `/api/internal/memory/*`，agent token 不能直接调用这些端点。

只读（不额外审批）：

- `search_memory(query, limit?, files?)`
- `memory_timeline(limit?)`
- `memory_source(sourceId)`
- `list_open_loops()`

写工具（server 自 gate / builtin 由 ToolExecutor 审批；operator 逐次确认）：

- `remember(text)` — 当前 workspace 的 note source
- `forget(claimId)` — 只能删当前 workspace claim，写 tombstone
- `complete_loop(loopId)` — open → done

内部端点：`/api/internal/memory/{search,timeline,sources/:id,loops,remember,forget,loops/:id/complete}`。

## 8. 已知限制

- `provider_override` 已持久化，但 worker 仍使用全局 `memory_model`；按 workspace 选 provider
  留到后续。
- claim 主语仍是 user；relation 可带 object entity，但还没有按 entity 检索 / 加权。
- entity 跨 scope 只有 link + 显式 merge，没有 UI / 自动 link。
- Tier-1 候选只落库；没有合并 / distinct / dismissed 的操作 API 或 UI。
- memory MCP 读 / 写工具已接；`remember` 只写当前 workspace note，跨 workspace `target=life`
  仍未提供；loop 完成匹配仍靠模型显式调用 `complete_loop`。
- 按轮召回用 n-gram 词面相关性；实体命中 / 需求相似度待接入；builtin 暂未接按轮召回。
- loop 候选只落库，没有完成匹配 / 提醒 / UI。
- 观察压缩与 claim 共用一次 LLM 调用；超长事件的 `<elided>` 二次压缩尚未实现。
- 客户端「记住这个」按钮尚未接线（API 已就绪）；会话级记忆三档已接桌面 / Android / iOS；
  移动端只读设置 + 时间线，没有搜索 / 晋升（按只读范围）。
- 真实 provider 的抽取质量尚未评估；自动化 fixture 只验证管线与护栏。
