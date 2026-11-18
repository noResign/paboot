package com.noresign.paboot.network.daemon

import com.noresign.paboot.network.daemon.dto.ChatRequest
import com.noresign.paboot.network.daemon.dto.SessionEventDto
import com.noresign.paboot.network.daemon.dto.SseFrame
import com.noresign.paboot.network.http.parseApiErrorBody
import com.noresign.paboot.network.sse.OkHttpSseSource
import com.noresign.paboot.network.sse.SseException
import com.noresign.paboot.network.sse.SseSource
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.flow.transform
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

private const val AUTH_HEADER = "Authorization"
private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
private val DEFAULT_JSON = Json { ignoreUnknownKeys = true }

/**
 * paboot 聊天流的**域适配层**：在通用 [SseSource] 之上，把 SSE 帧体 JSON 解码成 [SseFrame]，
 * 并把传输层异常翻译成 [ChatStreamEvent.Failed]。
 *
 * 分层意图：通用 SSE 传输（[SseSource] / [com.noresign.paboot.network.sse.OkHttpSseSource]）与
 * 业务协议解耦——接其他 AI 时只需另写一个这样的域适配层，通用层原样复用。
 */
class PabootStream(
    private val sse: SseSource,
    private val json: Json = DEFAULT_JSON,
) {

    /** `POST /api/chat`：发指令，流式接收事件。 */
    fun chat(baseUrl: String, token: String, body: ChatRequest): Flow<ChatStreamEvent> {
        val request = Request.Builder()
            .url(PabootClient.normalizeBaseUrl(baseUrl) + "api/chat")
            .post(json.encodeToString(ChatRequest.serializer(), body).toRequestBody(JSON_MEDIA_TYPE))
            .header(AUTH_HEADER, "Bearer $token")
            .build()
        return stream(request)
    }

    /** `GET /api/runs/:id/stream`：重连——先回放 `after` 之后的事件，再续直播。 */
    fun streamRun(baseUrl: String, token: String, runId: String, after: Long? = null): Flow<ChatStreamEvent> {
        val query = if (after != null) "?after=$after" else ""
        val request = Request.Builder()
            .url(PabootClient.normalizeBaseUrl(baseUrl) + "api/runs/$runId/stream$query")
            .header(AUTH_HEADER, "Bearer $token")
            .build()
        return stream(request)
    }

    private fun stream(request: Request): Flow<ChatStreamEvent> {
        // 显式标注类型，避免 transform 把下游元素类型推断成 `Frame` 子类型
        val frames: Flow<ChatStreamEvent> = sse.events(request)
            // 协议帧解码失败（未知事件类型 / 损坏帧）抛 SerializationException，由下方 catch 转成 Failed
            .transform { event -> emit(ChatStreamEvent.Frame(decode(event.data))) }
        return frames
            // 正常读完 → Closed；异常结束时不发（cause != null）
            .onCompletion { cause -> if (cause == null) emit(ChatStreamEvent.Closed) }
            // 传输层异常 / 协议解码失败 → Failed（其余异常照旧抛出）
            .catch { cause ->
                when (cause) {
                    is SseException -> emit(describe(cause))
                    is SerializationException -> emit(ChatStreamEvent.Failed("无法解析 daemon 事件帧（协议可能不兼容）"))
                    else -> throw cause
                }
            }
    }

    /** `GET /api/sessions/:id/events`：会话级提示流（别的端开始的 run、标题变化）。 */
    fun sessionEvents(baseUrl: String, token: String, sessionId: String): Flow<SessionWatchEvent> {
        val request = Request.Builder()
            .url(PabootClient.normalizeBaseUrl(baseUrl) + "api/sessions/$sessionId/events")
            .header(AUTH_HEADER, "Bearer $token")
            .build()
        val events: Flow<SessionWatchEvent> = sse.events(request)
            .transform { event ->
                emit(SessionWatchEvent.Event(json.decodeFromString(SessionEventDto.serializer(), event.data)))
            }
        return events
            .onCompletion { cause -> if (cause == null) emit(SessionWatchEvent.Closed) }
            .catch { cause ->
                when (cause) {
                    is SseException -> emit(
                        SessionWatchEvent.Failed(
                            message = describe(cause).message,
                            httpCode = cause.httpCode,
                            apiCode = parseApiErrorBody(cause.body)?.code,
                        ),
                    )
                    is SerializationException -> emit(SessionWatchEvent.Failed("无法解析会话事件（协议可能不兼容）"))
                    else -> throw cause
                }
            }
    }

    private fun decode(payload: String): SseFrame = json.decodeFromString(SseFrame.serializer(), payload)

    /**
     * 传输层失败 → [ChatStreamEvent.Failed]。
     *
     * `/api/chat` 的所有前置校验（未知 runtime、runtime 未安装、会话不存在…）都在 SSE 头
     * 之前返回，所以它们只能以非 2xx 正文的形式到达这里。正文里的 `{error, code}` 是唯一
     * 能说明原因的信息，HTTP 状态码只作兜底；`code` 一并带上去，让业务层用同一张文案表映射。
     */
    private fun describe(e: SseException): ChatStreamEvent.Failed {
        val api = parseApiErrorBody(e.body)
        return ChatStreamEvent.Failed(
            message = when {
                e.isUnauthorized -> "token 无效（401）"
                api?.error != null -> api.error
                api?.message != null -> api.message
                e.httpCode != null -> "HTTP ${e.httpCode}"
                else -> e.message ?: "SSE 连接失败"
            },
            httpCode = e.httpCode,
            apiCode = api?.code,
        )
    }

    companion object {
        /** 生产用默认实例：共享一个长连接 SSE 客户端。 */
        val default: PabootStream by lazy { PabootStream(OkHttpSseSource()) }
    }
}