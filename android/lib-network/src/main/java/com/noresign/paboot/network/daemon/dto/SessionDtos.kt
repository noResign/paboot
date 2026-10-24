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
    val startedAt: Long = 0,
    val endedAt: Long? = null,
    val exitCode: Long? = null,
    val error: String? = null,
    /** 定时任务触发时带上任务 id。 */
    val taskId: String? = null,
    /** `user` | `scheduled` | `run_now` */
    val trigger: String? = null,
    val permissionMode: String? = null,
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
