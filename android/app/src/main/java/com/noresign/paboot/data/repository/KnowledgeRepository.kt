package com.noresign.paboot.data.repository

import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.network.daemon.PabootApi
import com.noresign.paboot.network.daemon.PabootClient
import com.noresign.paboot.network.daemon.dto.KnowledgeDocDetailDto
import com.noresign.paboot.network.daemon.dto.KnowledgeDocDto
import com.noresign.paboot.network.daemon.dto.KnowledgeVerifyRequest
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.network.http.safeApiCall

/** K0 知识文档：自动收录，移动端只做人工核验标记。 */
class KnowledgeRepository(
    private val settings: SettingsStore = SettingsStore,
) {

    private fun api(): PabootApi? {
        val url = settings.baseUrl ?: return null
        val token = settings.token ?: return null
        return PabootClient.create(url, token)
    }

    suspend fun list(
        workspaceId: String,
        status: String? = null,
        verified: Boolean? = null,
        q: String? = null,
    ): NetworkResult<List<KnowledgeDocDto>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (
            val r = safeApiCall { api.knowledge(workspaceId, status = status, verified = verified, q = q) }
        ) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.documents)
            is NetworkResult.Error -> r
        }
    }

    suspend fun detail(workspaceId: String, id: String): NetworkResult<KnowledgeDocDetailDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.knowledgeDoc(workspaceId, id) }) {
            is NetworkResult.Success -> r.data.document?.let { NetworkResult.Success(it) }
                ?: NetworkResult.Error(-2, "daemon 未返回文档")
            is NetworkResult.Error -> r
        }
    }

    suspend fun setVerified(
        workspaceId: String,
        id: String,
        verified: Boolean,
    ): NetworkResult<KnowledgeDocDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (
            val r = safeApiCall { api.verifyKnowledgeDoc(workspaceId, id, KnowledgeVerifyRequest(verified)) }
        ) {
            is NetworkResult.Success -> r.data.document?.let { NetworkResult.Success(it) }
                ?: NetworkResult.Error(-2, "daemon 未返回文档")
            is NetworkResult.Error -> r
        }
    }
}
