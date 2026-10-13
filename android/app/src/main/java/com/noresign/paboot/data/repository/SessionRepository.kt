package com.noresign.paboot.data.repository

import com.noresign.paboot.network.daemon.PabootApi
import com.noresign.paboot.network.daemon.PabootClient
import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.network.http.safeApiCall
import com.noresign.paboot.network.daemon.dto.SessionDto
import com.noresign.paboot.network.daemon.dto.RenameRequest
import com.noresign.paboot.network.daemon.dto.SessionPermissionsResponse
import com.noresign.paboot.network.daemon.dto.UpdateSessionPermissionsRequest

class SessionRepository(
    private val settings: SettingsStore = SettingsStore,
) {

    private fun api(): PabootApi? {
        val url = settings.baseUrl ?: return null
        val token = settings.token ?: return null
        return PabootClient.create(url, token)
    }

    suspend fun listSessions(workspaceId: String? = null): NetworkResult<List<SessionDto>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.sessions(workspaceId) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.sessions)
            is NetworkResult.Error -> r
        }
    }

    suspend fun renameSession(id: String, title: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.renameSession(id, RenameRequest(title)) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    suspend fun deleteSession(id: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.deleteSession(id) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    suspend fun permissions(id: String): NetworkResult<SessionPermissionsResponse> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall { api.sessionPermissions(id) }
    }

    suspend fun updatePermissionMode(id: String, mode: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.updateSessionPermissions(id, UpdateSessionPermissionsRequest(mode)) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    suspend fun deletePermissionGrant(id: String, toolName: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.deletePermissionGrant(id, toolName) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    suspend fun deletePermissionGrants(id: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.deletePermissionGrants(id) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }
}
