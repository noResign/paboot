package com.noresign.paboot.data.repository

import com.noresign.paboot.network.daemon.PabootClient
import com.noresign.paboot.model.connect.ConnectResponse
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.network.http.safeApiCall

class ConnectRepository {

    /**
     * Verifies a daemon connection end-to-end:
     *  1. `GET /api/health` — reachability + daemon version (no auth).
     *  2. `GET /api/sessions` — token validation + session count (bearer auth).
     *
     * A failed health probe means the host/port is wrong or unreachable; a 401
     * on the sessions probe means the token is wrong.
     */
    suspend fun testConnection(baseUrl: String, token: String): NetworkResult<ConnectResponse> {
        val api = try {
            PabootClient.create(baseUrl, token)
        } catch (e: IllegalArgumentException) {
            return NetworkResult.Error(-2, "地址格式不正确：${e.message}")
        }

        val health = safeApiCall { api.health() }
        if (health is NetworkResult.Error) return health
        val healthData = (health as NetworkResult.Success).data
        if (!healthData.ok) {
            return NetworkResult.Error(-2, "daemon 返回异常状态（ok=false）")
        }

        val sessions = safeApiCall { api.sessions() }
        if (sessions is NetworkResult.Error) return sessions
        val sessionsData = (sessions as NetworkResult.Success).data

        return NetworkResult.Success(
            ConnectResponse(
                service = healthData.service ?: "paboot",
                version = healthData.version ?: "unknown",
                sessionCount = sessionsData.sessions.size,
                workspace = healthData.workspace,
                serverId = healthData.serverId,
            )
        )
    }
}
