package com.noresign.paboot.data.repository

import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.network.daemon.PabootApi
import com.noresign.paboot.network.daemon.PabootClient
import com.noresign.paboot.network.daemon.dto.AgentProfileDetailDto
import com.noresign.paboot.network.daemon.dto.AgentProfileRequest
import com.noresign.paboot.network.daemon.dto.AgentProfileDto
import com.noresign.paboot.network.daemon.dto.SessionAgentsResponse
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.network.http.safeApiCall
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 会话里的 agent（可复用的助手定义）。
 *
 * 与 [MetaRepository.agents] 区分：那个列的是「后端插件的 runtime」，这个管的是
 * 「房间里干活的那个助手」——名字、简介、目录、权限上限，以及它在本会话的对话。
 *
 * 端点是新的（`/api/agent-profiles`），老 daemon 上会 404 —— 调用方据此把 agent 相关
 * 入口藏起来，而不是当成错误弹给用户。
 */
class AgentRepository(
    private val settings: SettingsStore = SettingsStore,
) {

    private fun api(): PabootApi? {
        val url = settings.baseUrl ?: return null
        val token = settings.token ?: return null
        return PabootClient.create(url, token)
    }

    suspend fun listByWorkspace(workspaceId: String): NetworkResult<List<AgentProfileDto>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.workspaceAgents(workspaceId) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.agents)
            is NetworkResult.Error -> r
        }
    }

    suspend fun create(workspaceId: String, body: AgentProfileRequest): NetworkResult<AgentProfileDetailDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.createAgentProfile(workspaceId, body) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.agent)
            is NetworkResult.Error -> r
        }
    }

    suspend fun detail(agentId: String): NetworkResult<AgentProfileDetailDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.agentProfile(agentId) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.agent)
            is NetworkResult.Error -> r
        }
    }

    suspend fun update(agentId: String, body: AgentProfileRequest): NetworkResult<AgentProfileDetailDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.updateAgentProfile(agentId, body) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.agent)
            is NetworkResult.Error -> r
        }
    }

    /** 删除 agent。是 leader 的会拿到 409 `leader_required`，要先换 leader。 */
    suspend fun delete(agentId: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.deleteAgentProfile(agentId) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    suspend fun sessionAgents(sessionId: String): NetworkResult<SessionAgentsResponse> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall { api.sessionAgents(sessionId) }
    }

    suspend fun addToSession(sessionId: String, agentId: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        val body = JsonObject(mapOf("agentId" to JsonPrimitive(agentId)))
        return when (val r = safeApiCall { api.addSessionAgent(sessionId, body) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    suspend fun removeFromSession(sessionId: String, agentId: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.removeSessionAgent(sessionId, agentId) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    suspend fun setLeader(sessionId: String, agentId: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        val body = JsonObject(mapOf("agentId" to JsonPrimitive(agentId)))
        return when (val r = safeApiCall { api.setSessionLeader(sessionId, body) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    /**
     * 重置某个 agent 在本会话的对话。
     *
     * 只清 paboot 侧的 thread 绑定。runtime 自己存的记忆（例如 Claude 的项目记忆）
     * 不在我们控制范围内 —— 所以这里叫「重置对话」而不是「清空上下文」。
     */
    suspend fun resetContext(sessionId: String, agentId: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.resetAgentContext(sessionId, agentId) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }
}
