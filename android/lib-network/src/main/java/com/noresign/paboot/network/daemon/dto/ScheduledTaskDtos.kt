package com.noresign.paboot.network.daemon.dto

import kotlinx.serialization.Serializable

/** 定时任务 wire 模型——与 `daemon/src/types/api.ts` 对齐。 */

@Serializable
data class SchedulePresetDto(
    val preset: String = "daily",
    /** `HH:MM`，daily / weekdays / weekly 使用。 */
    val time: String? = null,
    /** 0=周日 … 6=周六，weekly 使用。 */
    val days: List<Int>? = null,
    /** every_minutes / every_hours 的 N。 */
    val every: Int? = null,
)

@Serializable
data class ScheduleDto(
    val cron: String = "",
    val timezone: String = "",
    val preset: SchedulePresetDto? = null,
    /** daemon 生成的人类可读摘要，例如「每天 09:00」。 */
    val label: String = "",
)

@Serializable
data class ScheduledTaskDto(
    val id: String,
    val name: String = "",
    /** `ai` | `command` */
    val type: String = "ai",
    /** `existing` | `new` | `internal` */
    val sessionMode: String = "existing",
    val sessionId: String? = null,
    val sessionTitle: String? = null,
    val workspaceId: String = "",
    val runtime: String = "",
    val prompt: String? = null,
    val command: String? = null,
    val permissionMode: String = "bypass",
    val schedule: ScheduleDto = ScheduleDto(),
    val nextRunAt: Long? = null,
    val lastFireAt: Long? = null,
    val lastRunAt: Long? = null,
    /** never | running | succeeded | failed | cancelled | interrupted | skipped_busy | skipped_missed */
    val lastStatus: String = "never",
    val lastError: String? = null,
    val lastRunId: String? = null,
    val runCount: Int = 0,
    val enabled: Boolean = true,
    val disabledReason: String? = null,
    /** `user` | `mcp` */
    val createdBy: String = "user",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

@Serializable
data class ScheduledTasksResponse(
    val tasks: List<ScheduledTaskDto> = emptyList(),
)

@Serializable
data class ScheduledTaskDetailResponse(
    val task: ScheduledTaskDto,
    val runs: List<RunDto> = emptyList(),
)

@Serializable
data class ScheduledTaskResponse(
    val ok: Boolean = true,
    val task: ScheduledTaskDto,
)

@Serializable
data class RunNowResponse(
    val ok: Boolean = true,
    val runId: String = "",
    val sessionId: String = "",
)

@Serializable
data class DeletedScheduledTaskResponse(
    val ok: Boolean = true,
    val id: String = "",
)

@Serializable
data class TaskConfigSessionResponse(
    val ok: Boolean = true,
    val sessionId: String = "",
    val runId: String? = null,
    val busy: Boolean = false,
)
