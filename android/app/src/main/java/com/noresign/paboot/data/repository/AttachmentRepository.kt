package com.noresign.paboot.data.repository

import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.network.daemon.PabootApi
import com.noresign.paboot.network.daemon.PabootClient
import com.noresign.paboot.network.daemon.dto.AttachmentDto
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.network.http.safeApiCall
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

class AttachmentRepository(
    private val settings: SettingsStore = SettingsStore,
) {

    private fun api(): PabootApi? {
        val url = settings.baseUrl ?: return null
        val token = settings.token ?: return null
        return PabootClient.create(url, token)
    }

    suspend fun upload(bytes: ByteArray, contentType: String): NetworkResult<AttachmentDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall {
            api.uploadAttachment(contentType, bytes.toRequestBody(contentType.toMediaType()))
        }
    }

    suspend fun bytes(id: String): NetworkResult<ByteArray> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val result = safeApiCall { api.attachment(id) }) {
            is NetworkResult.Success -> try {
                NetworkResult.Success(result.data.bytes())
            } catch (error: Exception) {
                NetworkResult.Error(-1, error.message ?: "读取附件失败")
            }
            is NetworkResult.Error -> result
        }
    }
}
