package com.noresign.paboot.network.daemon.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** paboot daemon wire 模型——归一化事件流与相关请求。与 `daemon/src/types/api.ts` 对齐。 */

/** `AskUserQuestion` 工具的一个选项。 */
@Serializable
data class QuestionOptionDto(
    val label: String,
    val description: String? = null,
)

/** `AskUserQuestion` 工具里的单个问题。 */
@Serializable
data class QuestionDto(
    val question: String,
    val header: String? = null,
    val multiSelect: Boolean = false,
    val options: List<QuestionOptionDto> = emptyList(),
)

/**
 * 后端归一化事件流（runtime 无关）。SSE 的 `data` 里是 `{runId, seq, event}`，
 * `event` 就是本 sealed class，以 `type` 字段作为多态判别。
 */
@Serializable
sealed class NormalizedEvent {

    @Serializable
    @SerialName("status")
    data class Status(
        val label: String,
        val model: String? = null,
        val sessionId: String? = null,
        val runtime: String? = null,
        val ttftMs: Long? = null,
        val terminal: Boolean? = null,
    ) : NormalizedEvent()

    @Serializable
    @SerialName("text_delta")
    data class TextDelta(val delta: String) : NormalizedEvent()

    @Serializable
    @SerialName("thinking_delta")
    data class ThinkingDelta(val delta: String) : NormalizedEvent()

    @Serializable
    @SerialName("thinking_start")
    object ThinkingStart : NormalizedEvent()

    @Serializable
    @SerialName("tool_use")
    data class ToolUse(val id: String, val name: String, val input: JsonElement? = null) : NormalizedEvent()

    @Serializable
    @SerialName("tool_result")
    data class ToolResult(
        val toolUseId: String? = null,
        val content: String = "",
        val isError: Boolean? = null,
        /** daemon 补发的中断结果：run 结束时该工具还没返回（取消 / 崩溃 / 空闲超时）。 */
        val interrupted: Boolean? = null,
    ) : NormalizedEvent()

    @Serializable
    @SerialName("usage")
    data class Usage(
        val usage: JsonElement? = null,
        val costUsd: Double? = null,
        val durationMs: Double? = null,
        val stopReason: String? = null,
        val isError: Boolean? = null,
        /** 上下文窗口当前占用量（token）；缺省 = 本帧不含此信息，保留上一个已知值。 */
        val contextTokens: Long? = null,
        /** 窗口总容量；null = 占用已知但容量未知（Claude 不报窗口）。 */
        val contextWindow: Long? = null,
    ) : NormalizedEvent()

    @Serializable
    @SerialName("turn_end")
    data class TurnEnd(val stopReason: String) : NormalizedEvent()

    @Serializable
    @SerialName("error")
    data class Error(val code: String? = null, val message: String, val terminal: Boolean? = null) : NormalizedEvent()

    @Serializable
    @SerialName("permission_request")
    data class PermissionRequest(
        val permissionId: String,
        val toolName: String,
        val toolInput: JsonElement? = null,
        val status: String? = null,
    ) : NormalizedEvent()

    @Serializable
    @SerialName("question")
    data class Question(
        val toolUseId: String,
        val questions: List<QuestionDto> = emptyList(),
    ) : NormalizedEvent()
}

/** 一帧 SSE 事件：`{runId, seq, event}`。 */
@Serializable
data class SseFrame(
    val runId: String,
    val seq: Long,
    val event: NormalizedEvent,
)

/** `GET /api/runs/:id/events` 回放响应。 */
@Serializable
data class EventsResponse(
    val runId: String,
    val events: List<SseFrame> = emptyList(),
)

/** `POST /api/chat` 请求体。 */
@Serializable
data class ChatRequest(
    val prompt: String,
    val sessionId: String? = null,
    val workspaceId: String? = null,
    val claudeSessionId: String? = null,
    val model: String? = null,
    val runtime: String? = null,
    val permissionMode: String? = null,
    /**
     * 幂等键：同一次「发送」重试时带同一个 id，daemon 会重连到它已经起的那个 run，
     * 而不是起第二个——让「请求刚发出就断、run id 都没拿到」能自动重试。
     */
    val commandId: String? = null,
)

/** `POST /api/permissions/:id/decision` 请求体。 */
@Serializable
data class PermissionDecisionRequest(
    val decision: String,
    val reason: String? = null,
    /** UserInput answers: returned to the provider, not saved in history. */
    val response: JsonElement? = null,
)
