package com.noresign.paboot.network.daemon.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** paboot daemon wire 模型——paboot 会话与 run。与 `daemon/src/types/api.ts` 对齐。 */

/** `GET /api/sessions` / `GET /api/sessions/:id` 的会话对象。 */
@Serializable
data class SessionDto(
    val id: String,
    val runtime: String = "",
    val workspaceId: String? = null,
    val permissionMode: String = "ask",
    /** 建会话时选择的模型；`null` 表示沿用电脑端 Agent 默认配置。 */
    val model: String? = null,
    /** 模型参数（如 `reasoningEffort`）；`null` = 全部用默认。 */
    val modelParameters: Map<String, String>? = null,
    val cwd: String = "",
    val title: String? = null,
    val createdAt: Long = 0,
    val lastActiveAt: Long = 0,
    val running: Boolean = false,
    val runningRunId: String? = null,
    /** 绑定在该会话上的定时任务数量（旧 daemon 不发则为 0）。 */
    val scheduledTaskCount: Int = 0,
    /** `task_config` 表示每 workspace 复用的 AI 任务配置会话。 */
    val purpose: String? = null,
    /** normal | no_injection | off（旧 daemon 可能缺省） */
    val memoryMode: String? = null,
)

@Serializable
data class SessionsResponse(
    val sessions: List<SessionDto> = emptyList(),
)

@Serializable
data class SessionDetailResponse(
    val session: SessionDto,
    val messages: List<MessageDto> = emptyList(),
    val runs: List<RunDto> = emptyList(),
)

/** 消息（`GET /api/sessions/:id` 返回，后端字段为 snake_case）。 */
@Serializable
data class MessageDto(
    val id: Long = 0,
    @SerialName("session_id") val sessionId: String = "",
    val role: String = "",
    val content: String = "",
    @SerialName("created_at") val createdAt: Long = 0,
    /** 谁说的；null = 用户消息或老 daemon 的数据。 */
    @SerialName("agent_id") val agentId: String? = null,
    /** 时间线位置（提交时刻），与 `id`（插入顺序）不同。 */
    @SerialName("committed_seq") val committedSeq: Long? = null,
)

@Serializable
data class RunDto(
    val id: String,
    val sessionId: String = "",
    val workspaceId: String? = null,
    val runtime: String = "",
    val model: String? = null,
    val status: String = "",
    val prompt: String = "",
    /** Image attachment ids sent with this run. */
    val attachmentIds: List<String> = emptyList(),
    val startedAt: Long = 0,
    val endedAt: Long? = null,
    val exitCode: Long? = null,
    val error: String? = null,
    /** 定时任务触发时带上任务 id。 */
    val taskId: String? = null,
    /** `user` | `scheduled` | `run_now` */
    val trigger: String? = null,
    val permissionMode: String? = null,
    /** 产生这次 run 的 agent；老 daemon 没有这个字段。 */
    val agentId: String? = null,
    /** 群聊任务所属的 turn；同一 turn 的多个 run 共享一条用户消息。 */
    val turnId: String? = null,
    /** 命令任务的聚合输出（尾部截断）。 */
    val output: String? = null,
)

/** `PATCH /api/sessions/:id/model`；`null` 表示回到默认。 */
@Serializable
data class UpdateSessionModelRequest(
    // 不设默认值：kotlinx.serialization 会省略等于默认值的字段，
    // 那样 `{"model":null}` 会变成 `{}`，daemon 无法区分「清空」和「没传」。
    val model: String?,
    val modelParameters: Map<String, String>?,
)

@Serializable
data class SessionResponse(
    val ok: Boolean = true,
    val session: SessionDto,
)

/** `GET /api/runs`（当前运行中的 run 列表）。 */
@Serializable
data class RunsResponse(
    val runs: List<RunDto> = emptyList(),
)

/**
 * `GET /api/sessions/:id/events` 的会话级提示流。
 *
 * 与 run 事件流不同：不带 `{runId, seq}` 信封、不落库；重连以 `state` 快照为准。
 */
@Serializable
sealed class SessionEventDto {

    @Serializable
    @SerialName("state")
    data class State(val session: SessionDto) : SessionEventDto()

    @Serializable
    @SerialName("run_started")
    data class RunStarted(val sessionId: String, val run: SessionRunBriefDto) : SessionEventDto()

    @Serializable
    @SerialName("run_finished")
    data class RunFinished(val sessionId: String, val run: SessionRunBriefDto) : SessionEventDto()

    @Serializable
    @SerialName("session_updated")
    data class SessionUpdated(val sessionId: String, val title: String? = null) : SessionEventDto()
}

/** 会话提示流里一条 run 的最小快照。 */
@Serializable
data class SessionRunBriefDto(
    val id: String,
    val prompt: String,
    val attachmentIds: List<String> = emptyList(),
    val startedAt: Long = 0,
    val status: String = "",
)
