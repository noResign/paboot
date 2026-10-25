package com.noresign.paboot.data.repository

import com.noresign.paboot.network.daemon.PabootApi
import com.noresign.paboot.network.daemon.PabootClient
import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.network.daemon.dto.AgentModelsResponse
import com.noresign.paboot.network.daemon.dto.AgentsResponse
import com.noresign.paboot.network.daemon.dto.HealthResponse
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.network.http.safeApiCall

/** Daemon 元数据（agents / 模型目录 / 版本）。 */
class MetaRepository(
    private val settings: SettingsStore = SettingsStore,
) {

    private fun api(): PabootApi? {
        val url = settings.baseUrl ?: return null
        val token = settings.token ?: return null
        return PabootClient.create(url, token)
    }

    suspend fun agents(): NetworkResult<AgentsResponse> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall { api.agents() }
    }

    suspend fun models(agentId: String): NetworkResult<AgentModelsResponse> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall { api.agentModels(agentId) }
    }

    suspend fun health(): NetworkResult<HealthResponse> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall { api.health() }
    }
}
