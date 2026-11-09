package com.noresign.paboot.data.repository

import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.network.daemon.PabootApi
import com.noresign.paboot.network.daemon.PabootClient
import com.noresign.paboot.network.daemon.dto.MemoryClaimDto
import com.noresign.paboot.network.daemon.dto.MemoryCorrectClaimRequest
import com.noresign.paboot.network.daemon.dto.MemoryStatusDto
import com.noresign.paboot.network.daemon.dto.MemoryTimelineItemDto
import com.noresign.paboot.network.daemon.dto.WorkspaceMemoryDto
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.network.http.safeApiCall

/** Memory M0：生活记忆的只读列表 + 改正 / 忘记。整理配置留在桌面 / daemon。 */
class MemoryRepository(
    private val settings: SettingsStore = SettingsStore,
) {

    private fun api(): PabootApi? {
        val url = settings.baseUrl ?: return null
        val token = settings.token ?: return null
        return PabootClient.create(url, token)
    }

    suspend fun list(workspaceId: String): NetworkResult<List<MemoryClaimDto>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.memoryClaims(scope(workspaceId)) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.claims)
            is NetworkResult.Error -> r
        }
    }

    suspend fun status(workspaceId: String): NetworkResult<MemoryStatusDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall { api.memoryStatus(scope(workspaceId)) }
    }

    suspend fun settings(workspaceId: String): NetworkResult<WorkspaceMemoryDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall { api.workspaceMemory(workspaceId) }
    }

    suspend fun timeline(workspaceId: String): NetworkResult<List<MemoryTimelineItemDto>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.memoryTimeline(scope(workspaceId)) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.items)
            is NetworkResult.Error -> r
        }
    }

    suspend fun correct(
        workspaceId: String,
        id: String,
        summary: String,
        objectText: String,
    ): NetworkResult<MemoryClaimDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (
            val r = safeApiCall {
                api.correctMemoryClaim(
                    id,
                    scope(workspaceId),
                    MemoryCorrectClaimRequest(
                        summary = summary.ifBlank { null },
                        objectText = objectText.ifBlank { null },
                    ),
                )
            }
        ) {
            is NetworkResult.Success -> r.data.claim?.let { NetworkResult.Success(it) }
                ?: NetworkResult.Error(-2, "daemon 未返回记忆")
            is NetworkResult.Error -> r
        }
    }

    suspend fun forget(workspaceId: String, id: String): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.forgetMemoryClaim(id, scope(workspaceId)) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    private fun scope(workspaceId: String): String = "workspace:$workspaceId"
}
