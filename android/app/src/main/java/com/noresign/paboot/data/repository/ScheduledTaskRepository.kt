package com.noresign.paboot.data.repository

import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.model.task.TaskDraft
import com.noresign.paboot.network.daemon.PabootApi
import com.noresign.paboot.network.daemon.PabootClient
import com.noresign.paboot.network.daemon.dto.ScheduledTaskDetailResponse
import com.noresign.paboot.network.daemon.dto.ScheduledTaskDto
import com.noresign.paboot.network.daemon.dto.TaskConfigSessionResponse
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.network.http.safeApiCall
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

class ScheduledTaskRepository(
    private val settings: SettingsStore = SettingsStore,
) {

    private fun api(): PabootApi? {
        val url = settings.baseUrl ?: return null
        val token = settings.token ?: return null
        return PabootClient.create(url, token)
    }

    suspend fun list(
        workspaceId: String?,
        sessionId: String? = null,
    ): NetworkResult<List<ScheduledTaskDto>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.scheduledTasks(workspaceId, sessionId) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.tasks)
            is NetworkResult.Error -> r
        }
    }

    suspend fun detail(id: String): NetworkResult<ScheduledTaskDetailResponse> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall { api.scheduledTask(id) }
    }

    suspend fun startConfigSession(workspaceId: String?): NetworkResult<TaskConfigSessionResponse> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        val body = buildJsonObject {
            workspaceId?.let { put("workspaceId", it) }
        }
        return safeApiCall { api.startTaskConfigSession(body) }
    }

    suspend fun update(
        id: String,
        draft: TaskDraft,
        scheduleEditable: Boolean,
        retarget: Boolean = false,
    ): NetworkResult<ScheduledTaskDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        val body = buildJsonObject {
            put("name", draft.name)
            if (draft.type == "command") put("command", draft.command) else put("prompt", draft.prompt)
            if (scheduleEditable) put("schedule", scheduleJson(draft))
            // Only when the binding actually changed; omitted means "leave it".
            if (retarget) {
                putJsonObject("target") {
                    val sessionId = draft.sessionId
                    if (sessionId != null) {
                        put("mode", "existing")
                        put("sessionId", sessionId)
                    } else {
                        put("mode", "new")
                    }
                }
            }
        }
        return when (val r = safeApiCall { api.updateScheduledTask(id, body) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.task)
            is NetworkResult.Error -> r
        }
    }

    suspend fun setEnabled(id: String, enabled: Boolean): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        val body = buildJsonObject { put("enabled", enabled) }
        return when (val r = safeApiCall { api.updateScheduledTask(id, body) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    suspend fun runNow(id: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.runScheduledTaskNow(id) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    suspend fun delete(id: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.deleteScheduledTask(id) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    /**
     * Only the fields that belong to the chosen preset are emitted: the daemon
     * treats the presence of `cron` as "raw expression", so a null `cron` would
     * select the wrong branch.
     */
    private fun scheduleJson(draft: TaskDraft): JsonObject = buildJsonObject {
        put("preset", draft.preset)
        when (draft.preset) {
            "every_minutes", "every_hours" -> put("every", draft.every)
            "weekly" -> {
                put("time", draft.time)
                putJsonArray("days") { draft.days.forEach { add(it) } }
            }
            else -> put("time", draft.time)
        }
    }
}
