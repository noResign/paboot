package com.noresign.paboot.data.repository

import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.network.daemon.PabootApi
import com.noresign.paboot.network.daemon.PabootClient
import com.noresign.paboot.network.daemon.dto.MemoryClaimDto
import com.noresign.paboot.network.daemon.dto.MemoryCorrectClaimRequest
import com.noresign.paboot.network.daemon.dto.MemoryDisputeDto
import com.noresign.paboot.network.daemon.dto.MemoryDuplicateDto
import com.noresign.paboot.network.daemon.dto.MemoryEntityDto
import com.noresign.paboot.network.daemon.dto.MemoryFeedbackRequest
import com.noresign.paboot.network.daemon.dto.MemoryLoopActionRequest
import com.noresign.paboot.network.daemon.dto.MemoryLoopDto
import com.noresign.paboot.network.daemon.dto.MemoryStatusDto
import com.noresign.paboot.network.daemon.dto.MemoryTimelineItemDto
import com.noresign.paboot.network.daemon.dto.WorkspaceMemoryDto
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.network.http.safeApiCall

/** Memory：生活记忆的只读列表 + 改正 / 忘记 / 反馈 / 跟进项审核。整理配置留在桌面 / daemon。 */
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

    suspend fun duplicates(workspaceId: String): NetworkResult<List<MemoryDuplicateDto>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.memoryDuplicates(scope(workspaceId)) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.duplicates)
            is NetworkResult.Error -> r
        }
    }

    suspend fun disputes(workspaceId: String): NetworkResult<List<MemoryDisputeDto>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.memoryDisputes(scope(workspaceId)) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.disputes)
            is NetworkResult.Error -> r
        }
    }

    suspend fun entities(workspaceId: String): NetworkResult<List<MemoryEntityDto>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.memoryEntities(scope(workspaceId)) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.entities)
            is NetworkResult.Error -> r
        }
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

    /** D38: open loops plus the auto-detected "maybe finished" candidates. */
    suspend fun loops(workspaceId: String): NetworkResult<List<MemoryLoopDto>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.memoryLoops(scope(workspaceId)) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.loops)
            is NetworkResult.Error -> r
        }
    }

    suspend fun resolveLoop(
        workspaceId: String,
        id: String,
        confirm: Boolean,
    ): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        val body = MemoryLoopActionRequest(action = if (confirm) "confirm" else "reopen")
        return when (val r = safeApiCall { api.resolveMemoryLoop(id, scope(workspaceId), body) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    suspend fun feedback(
        workspaceId: String,
        claimId: String,
        action: String,
    ): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        val body = MemoryFeedbackRequest(targetId = claimId, action = action)
        return when (val r = safeApiCall { api.memoryFeedback(scope(workspaceId), body) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    private fun scope(workspaceId: String): String = "workspace:$workspaceId"
}
