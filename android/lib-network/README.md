# `:lib-network` — 网络底座

paboot 客户端的**全部网络能力**都收在这个 module：依赖、传输、协议 DTO、Retrofit API、
SSE 流式、错误包装。`app` 只依赖它，直接用里面的类型，不再自己声明网络依赖。

编译产物是普通 AAR，不引用任何 `android.*`。

## 边界（改这个 module 前先看）

**可以放**：HTTP / SSE 传输、协议解析、wire DTO、Retrofit 接口与客户端工厂、大模型供应商抽象、
路由、网络错误包装。

**不可以放**：任何 `android.*` 引用、`SettingsStore`（MMKV）、仓库层的业务编排、UI / ViewModel /
主题、把网络 DTO 组装成页面模型的逻辑。

## 依赖

全部以 `api` 暴露给上层 —— 因为它们在公开签名里出现，`app` 因此不必再声明：

| 依赖 | 为什么是 `api` |
|---|---|
| `okhttp` | `SseSource.events(request: Request)` |
| `retrofit` | `PabootApi` 是公开接口（注解与 `HttpException` 都来自它） |
| `kotlinx-coroutines-core` | `LlmProvider.stream(): Flow<…>` |
| `kotlinx-serialization-json` | DTO 里的 `JsonElement` / `JsonArray` |

`retrofit-converter-kotlinx-serialization` 只在 `PabootClient` 内部用，所以是 `implementation`。

## 目录

```
lib-network/src/main/java/com/noresign/paboot/network/
├─ sse/        通用 SSE 传输（无业务语义，任何后端都能用）
│  ├─ SseSource.kt        接口：Request → Flow<SseEvent>
│  ├─ OkHttpSseSource.kt  裸 OkHttp 长连接实现（不依赖 okhttp-sse）
│  ├─ SseParser.kt        纯逻辑行解析器（无 IO，可单测）
│  ├─ SseEvent.kt         一条原始事件（id/event/data/retry）
│  └─ SseException.kt     HTTP 非 2xx / 连接失败 / 空响应
├─ http/       REST 结果包装
│  └─ NetworkResult.kt    Success / Error + safeApiCall（统一捕获 HttpException / IOException）
├─ llm/        大模型供应商抽象（OpenAI 兼容协议，直连大模型时用）
│  ├─ LlmProvider.kt             接口：stream / collectStream / generate
│  ├─ LlmStreamEvent.kt          流式事件：ContentDelta / ReasoningDelta / Completed
│  ├─ OpenAiCompatLlmProvider.kt OpenAI 兼容实现（chunk 解码 + 聚合）
│  ├─ RoutingLlmProvider.kt      按 model 路由到不同供应商
│  ├─ ModelResolver.kt           模型 → 供应商名（依赖倒置，实现由业务层给）
│  ├─ OpenAiCompatConfig.kt      接入配置（baseUrl / apiKey / 默认模型）
│  ├─ LlmException.kt            对外唯一异常类型
│  ├─ OpenAiChunk.kt             流式 chunk 的 wire DTO（internal）
│  ├─ OpenAiCompletion.kt        非流式响应的 wire DTO（internal）
│  ├─ OpenAiUsage.kt             usage 的 wire DTO（internal）
│  └─ dto/                       对外 DTO：LlmRequest / ChatMessage / ToolCall / …
└─ daemon/   paboot daemon 协议层（与 `daemon/src/types/api.ts` 一一对齐）
   ├─ PabootApi.kt       Retrofit 接口（/api/health、/api/sessions、/api/runs…）
   ├─ PabootClient.kt    baseUrl 归一化 + Bearer 拦截器 + Retrofit 工厂
   ├─ PabootStream.kt    SSE 域适配：POST /api/chat、GET /api/runs/:id/stream
   ├─ ChatStreamEvent.kt   Frame / Failed / Closed
   └─ dto/                 wire 模型，按业务域分文件（不再往下建子目录）
      ├─ AgentDtos.kt              AgentDto + AgentsResponse
      ├─ SessionDtos.kt            SessionDto / SessionsResponse / SessionDetailResponse / MessageDto / RunDto / RunsResponse
      ├─ SessionPermissionDtos.kt  PermissionGrantDto / SessionPermissionsResponse / UpdateSessionPermissionsRequest
      ├─ EventDtos.kt              NormalizedEvent（sealed，11 个子类）/ SseFrame / EventsResponse / ChatRequest / PermissionDecisionRequest / QuestionDto
      ├─ WorkspaceDtos.kt          WorkspaceDto / WorkspacesResponse / 增改与目录、书签请求响应 / DirectoryEntryDto / DirectoriesResponse
      ├─ ChangeDtos.kt             ChangedFileDto / ChangesResponse / DiffResponse
      ├─ FileDtos.kt               FileEntryDto / FilesResponse / FileContentDto
      ├─ ConfigDtos.kt             ServerConfigDto / ConfigResponse / UpdateConfigRequest / ConfigWorkspaceDto
      └─ CommonDtos.kt             HealthResponse / OkResponse / RenameRequest / RenameResponse
```

**依赖方向单向向下**：`daemon/` → `sse/` + `http/`，`llm/` → `sse/`；`sse/` 不反向依赖任何上层。
所以 SSE 层既能给 daemon 协议用，也能给大模型用（两条路互不干扰）。

daemon 协议类型都在 `com.noresign.paboot.network.daemon.dto` 包下，import 是「包 + 类型名」两段，
不再有 `dto.agent` / `dto.session` 这种子包：

```kotlin
import com.noresign.paboot.network.daemon.PabootClient
import com.noresign.paboot.network.daemon.PabootStream
import com.noresign.paboot.network.daemon.ChatRequest
import com.noresign.paboot.network.daemon.ChatStreamEvent
import com.noresign.paboot.network.daemon.SessionsResponse
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.network.http.safeApiCall
```

## 用法

### 1. 走 paboot daemon（app 的主路径）

```kotlin
val api = PabootClient.create(baseUrl, token)          // Retrofit + Bearer 拦截器
val result: NetworkResult<SessionsResponse> = safeApiCall { api.sessions() }

// 流式：POST /api/chat，断线后可用 runStream(runId, after) 续传
PabootStream.default
    .chat(baseUrl, token, ChatRequest(prompt = "hi", sessionId = id))
    .collect { event ->
        when (event) {
            is ChatStreamEvent.Frame -> render(event.frame)   // {runId, seq, event}
            is ChatStreamEvent.Failed -> showError(event.message)
            ChatStreamEvent.Closed -> markDone()
        }
    }
```

### 2. 直连 OpenAI 兼容大模型

```kotlin
val llm: LlmProvider = OpenAiCompatLlmProvider(
    OpenAiCompatConfig(baseUrl = "https://api.deepseek.com", apiKey = key, defaultModel = "deepseek-chat"),
)
llm.stream(LlmRequest(messages = listOf(ChatMessage.user("hi")))).collect { event ->
    when (event) {
        is LlmStreamEvent.ContentDelta -> append(event.delta)
        is LlmStreamEvent.ReasoningDelta -> appendThinking(event.delta)
        is LlmStreamEvent.Completed -> showUsage(event.response.totalTokens)
    }
}
```

多供应商按 `model` 路由：

```kotlin
val routed = RoutingLlmProvider(
    providers = mapOf("deepseek" to deepSeek, "openai" to openAi),
    resolver = object : ModelResolver {                       // 业务层提供
        override fun resolveProvider(modelId: String) = models[modelId]?.provider
    },
)
```

### 3. 接一个新后端 / 新厂商

- 新 daemon 协议 → 照 `daemon/` 加一个协议包（DTO + Retrofit 接口 + `SseSource` 域适配）。
- 新的大模型厂商 → 协议兼容 OpenAI 就用 `OpenAiCompatLlmProvider` + `OpenAiCompatConfig.extra`；
  不兼容就实现 `LlmProvider`，传输复用 `SseSource`，路由注册一行。

## 测试

`src/test/` 下是纯 JVM 单测，不需要 Android 环境、不需要真网络：

- `SseParserTest` —— 解析器拆成纯逻辑就是为了这个
- `OpenAiCompatLlmProviderTest` —— 用假的 `SseSource` 喂固定帧，覆盖增量聚合、tool_calls 分片累积、
  `[DONE]`、异常翻译、请求体/端点
- `RoutingLlmProviderTest` —— 路由与未知模型兜底
- `EventDtosTest` —— 钉死归一化事件的 `type` 多态判别（11 个子类逐个验）与请求体/帧编码
- `AgentDtosTest` —— `/api/agents` 响应的 `available` 字段编解码

```bash
./gradlew :lib-network:test
```
