package com.noresign.paboot.data.repository

import com.noresign.paboot.network.daemon.PabootClient
import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.network.daemon.PabootStream
import com.noresign.paboot.network.daemon.ChatStreamEvent
import com.noresign.paboot.network.daemon.dto.ChatRequest
import com.noresign.paboot.network.daemon.dto.EventsResponse
import com.noresign.paboot.network.daemon.dto.PermissionDecisionRequest
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.network.http.safeApiCall
import com.noresign.paboot.network.daemon.dto.SessionDetailResponse
import kotlinx.serialization.json.JsonElement
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf

class ChatRepository(
    private val settings: SettingsStore = SettingsStore,
    private val stream: PabootStream = PabootStream.default,
) {

    private fun api() = settings.baseUrl?.let { url ->
        settings.token?.let { token -> PabootClient.create(url, token) }
    }

    fun chatStream(
        sessionId: String?,
        prompt: String,
        claudeSessionId: String? = null,
        runtime: String? = null,
        workspaceId: String? = null,
        permissionMode: String? = null,
        commandId: String? = null,
    ): Flow<ChatStreamEvent> {
        val url = settings.baseUrl ?: return flowOf(ChatStreamEvent.Failed("未配置连接"))
        val token = settings.token ?: return flowOf(ChatStreamEvent.Failed("未配置连接"))
        return stream.chat(
            url,
            token,
            ChatRequest(
                prompt = prompt,
                sessionId = sessionId,
                workspaceId = workspaceId,
                claudeSessionId = claudeSessionId,
                runtime = runtime,
                permissionMode = permissionMode,
                commandId = commandId,
            ),
        )
    }

    fun runStream(runId: String, after: Long? = null): Flow<ChatStreamEvent> {
        val url = settings.baseUrl ?: return flowOf(ChatStreamEvent.Failed("未配置连接"))
        val token = settings.token ?: return flowOf(ChatStreamEvent.Failed("未配置连接"))
        return stream.streamRun(url, token, runId, after)
    }

    suspend fun sessionDetail(id: String): NetworkResult<SessionDetailResponse> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall { api.session(id) }
    }

    suspend fun runEvents(runId: String, after: Long? = null): NetworkResult<EventsResponse> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall { api.runEvents(runId, after) }
    }

    /**
     * daemon **内存态**里这个 run 是否仍在运行（`GET /api/runs`）。
     *
     * 用来区分两种「流断了」：run 还活着（继续重连）／run 已消失（收口）——后者覆盖正常结束、
     * daemon 重启、被空闲看门狗取消三种情况。
     *
     * 返回 `null` 表示查询本身失败（断网 / daemon 不可达），此时没有判断依据，调用方应继续重试。
     */
    suspend fun isRunActive(runId: String): Boolean? {
        val api = api() ?: return null
        return when (val r = safeApiCall { api.runs() }) {
            is NetworkResult.Success -> r.data.runs.any { it.id == runId }
            is NetworkResult.Error -> null
        }
    }

    suspend fun decidePermission(permissionId: String, decision: String, reason: String? = null, response: JsonElement? = null): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.decidePermission(permissionId, PermissionDecisionRequest(decision, reason, response)) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    suspend fun cancelRun(runId: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.cancelRun(runId) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }
}
