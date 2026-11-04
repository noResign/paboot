# daemon 技术方案 · 共享 LLM 层（`llm/`）

> 索引见 [daemon.md](daemon.md)。P0.4 只落骨架：类型契约、provider 目录、凭据、registry 与
> `none` 降级。具体 HTTP adapter（Anthropic Messages / OpenAI 兼容）在 P3.1；provider 管理 API /
> 设置页在 P2。本层同时服务 builtin runtime、Memory 和后台任务，任何人不得另建 provider 栈。

## 1. 契约

`LlmRequest`：`provider`、裸 `model`、`system`、`messages`（中立 `LlmMessage[]`）、`tools`、
`maxTokens?`、`temperature?`、`signal`。provider 专属的消息格式不进入契约，由 adapter 自行 render。

中立内容块支持 `text`、`image`、`tool_use`、`tool_result`。`image` 是
`{ type: 'image', mediaType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif', data }`，
`data` 是**不带 `data:` 前缀的 base64**。图片只在请求边界变成 base64：builtin transcript / SSE /
事件只保留 attachment 引用，字节存 `~/.paboot/attachments/`，不进 DB、不进日志。

`LlmChunk`（流式）：

- `text_delta` / `reasoning_delta`；
- `tool_call_start` / `tool_call_delta`（工具参数是**原始 JSON 字符串**，由 loop 累积解析）；
- `usage`（`Usage` + `contextTokens`）；
- `finish`（`FinishReason` + 可选 `rawReason`）。

`LlmCompletion`：`text`、`reasoning?`、`toolCalls`、`finishReason`、`rawFinishReason?`、`usage`。
`complete()` 无工具、非流式（或内部聚合），供 Memory 抽取 / 整理、会话标题等后台调用；
不要为了抽取 spawn 一个 agent 会话。

`FinishReason`：`stop | length | tool_use | content_filter | error | cancelled | unavailable`。
`unavailable` 只由显式 `none` provider 产生。

## 2. Provider 目录与模型 id

模型 id 统一 `<provider>:<model>`，在**第一个冒号**处切分（模型名可以再含冒号）。
`catalog.parseModelId` / `formatModelId` 负责编解码；未知 provider / 非法 id 抛 `LlmError`，
由调用方转成 400，不做静默回退。

内置模板：`anthropic`、`openai`、`deepseek`（后两者是 OpenAI 兼容 kind，baseUrl 不同）。
模板只给 baseUrl、`apiKeyEnv` 和空模型数组；模型目录由 P2 刷新 / P3 adapter 填充，
避免把会过期的模型名写死。模型元数据支持 `supportsTools` / `supportsImages`：附件入口和请求
构造都要先看当前模型是否支持图片；非 vision 模型的历史图片在渲染时替换为文字占位
（「图片已省略：当前模型不支持图片输入」），不让 run 整体失败。

Provider 来源按 id 合并，后者覆盖前者：

1. 内置模板；
2. `PABOOT_LLM_PROVIDERS` 内联 JSON；
3. `PABOOT_LLM_PROVIDERS_FILE`（默认 `~/.paboot/providers.json`，存在才读）。

`models` 数组整体替换，不做逐模型合并（避免出现删不掉的幽灵模型）。新 id 首次定义必须带
`kind` + `baseUrl`。JSON 格式支持数组或 `{ providers: [...] }`；单个条目坏掉只记 warning 跳过，
不会拖垮整个目录。

## 3. 凭据（只写不读）

密钥解析顺序：providers.json / 内联 JSON 的 `apiKey` → provider 的 `apiKeyEnv` 环境变量 → 无。
支持的 env：`ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`（以及各自的
`*_BASE_URL`，由 provider 定义覆盖）。

- `loadProviders()` 返回内部 `ResolvedProvider`（含 `apiKey`，只给 adapter 用）；
- **任何 API / 日志 / DB 都只能使用 `toPublicProvider()`**：只有 `hasApiKey` 与
  `apiKeySource: file|env|null`，没有明文 key；
- `writeProvidersFile()` 原子写入（临时文件 + rename），权限固定 `0600`；目录不存在时创建。
- 本层不落 SQLite；provider 管理 API（P2）负责「省略=不变 / null=清除 / 字符串=覆盖」的语义。

## 4. Registry 与 `none`

`LlmRegistry` 持有 provider 实例，始终注册 `none`：

- `none.available=false`，`unavailableReason='no llm provider configured'`；
- `none.stream()` 只 yield `{type:'finish', reason:'unavailable'}`；`none.complete()` 返回
  `finishReason:'unavailable'`、`usage:null`——**不抛异常**，调用方即使忽略 `available` 也只会
  得到明确的空结果；
- `hasAvailableProvider()` 是 Memory「仅记录、不抽取」的判断依据；
- `resolveModel('<provider>:<model>')` 切分并 `require` provider；未知 provider 抛 `LlmError`。

P0.4 只注册 `none`。P3.1 的 adapter 由 catalog + `ResolvedProvider` 构造后 `register()`；
真实 provider 的 `available` 由 adapter 根据 key / 配置决定。

## 5. 现状与后续

P0.4 **没有**接 run、Memory、HTTP 路由或 UI；行为零变化。图片契约已经在类型里，但附件 API、
transcript image 块、客户端 photo picker 与 render 仍未实现（builtin design 的 P5.1；若图片输入
要提前到 builtin MVP，直接复用该契约，不需要改 `llm/types.ts`）。后续：

1. P2：`/api/providers` CRUD / test / refresh + 客户端设置页，写操作即时 invalidate registry；
2. P3.1：Anthropic / OpenAI 兼容 adapter（SSE 翻译、重试、usage、超时）；
3. P3：builtin runtime 用 `stream()`；Memory 用 `complete()`（P4）。
