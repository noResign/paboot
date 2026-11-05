package com.noresign.paboot.data.repository

import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.network.daemon.PabootApi
import com.noresign.paboot.network.daemon.PabootClient
import com.noresign.paboot.network.daemon.dto.ProviderDto
import com.noresign.paboot.network.daemon.dto.ProviderTestResponse
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.network.http.safeApiCall
import kotlinx.serialization.json.JsonObject

class ProviderRepository(
    private val settings: SettingsStore = SettingsStore,
) {
    private fun api(): PabootApi? {
        val url = settings.baseUrl ?: return null
        val token = settings.token ?: return null
        return PabootClient.create(url, token)
    }

    suspend fun list(): NetworkResult<List<ProviderDto>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val result = safeApiCall { api.providers() }) {
            is NetworkResult.Success -> NetworkResult.Success(result.data.providers)
            is NetworkResult.Error -> result
        }
    }

    suspend fun create(body: JsonObject): NetworkResult<ProviderDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val result = safeApiCall { api.createProvider(body) }) {
            is NetworkResult.Success -> result.data.provider?.let { NetworkResult.Success(it) }
                ?: NetworkResult.Error(-2, "daemon 未返回 provider")
            is NetworkResult.Error -> result
        }
    }

    suspend fun update(id: String, body: JsonObject): NetworkResult<ProviderDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val result = safeApiCall { api.updateProvider(id, body) }) {
            is NetworkResult.Success -> result.data.provider?.let { NetworkResult.Success(it) }
                ?: NetworkResult.Error(-2, "daemon 未返回 provider")
            is NetworkResult.Error -> result
        }
    }

    suspend fun delete(id: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val result = safeApiCall { api.deleteProvider(id) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> result
        }
    }

    suspend fun test(id: String): NetworkResult<ProviderTestResponse> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall { api.testProvider(id) }
    }

    suspend fun refreshModels(id: String): NetworkResult<ProviderDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val result = safeApiCall { api.refreshProviderModels(id) }) {
            is NetworkResult.Success -> result.data.provider?.let { NetworkResult.Success(it) }
                ?: NetworkResult.Error(-2, "daemon 未返回 provider")
            is NetworkResult.Error -> result
        }
    }
}
