package com.noresign.paboot.model.task

/**
 * UI-side draft for creating/editing a scheduled task. Kept runtime-agnostic and
 * free of wire details; [com.noresign.paboot.data.repository.ScheduledTaskRepository]
 * turns it into the daemon's JSON shape.
 */
data class TaskDraft(
    val name: String,
    /** `ai` | `command` */
    val type: String,
    val prompt: String = "",
    val command: String = "",
    /** `existing` | `new` | `workspace` */
    val targetMode: String = "existing",
    val sessionId: String? = null,
    val runtime: String = "claude",
    /** daily | weekdays | weekly | every_minutes | every_hours */
    val preset: String = "daily",
    val time: String = "09:00",
    val days: List<Int> = listOf(1),
    val every: Int = 6,
)
