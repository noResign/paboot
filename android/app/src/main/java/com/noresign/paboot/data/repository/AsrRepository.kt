package com.noresign.paboot.data.repository

import com.noresign.paboot.data.local.SecretStore
import com.noresign.paboot.network.asr.AsrHttpException
import com.noresign.paboot.network.asr.AsrTranscriptionDto
import com.noresign.paboot.network.asr.DeepSeekAsrClient
import com.noresign.paboot.network.http.NetworkResult
import java.io.IOException

/** 语音识别：客户端直连 DeepSeek，key 来自设置页（见 [SecretStore]）。 */
class AsrRepository(
    private val secrets: SecretStore = SecretStore,
) {

    suspend fun transcribe(wav: ByteArray): NetworkResult<AsrTranscriptionDto> {
        val key = secrets.asrApiKey?.trim().orEmpty()
        if (key.isEmpty()) {
            return NetworkResult.Error(-2, "语音识别未配置", "asr_not_configured")
        }
        return try {
            NetworkResult.Success(DeepSeekAsrClient.transcribe(key, wav))
        } catch (error: AsrHttpException) {
            NetworkResult.Error(error.status, "语音识别失败", apiCodeFor(error.status))
        } catch (error: IOException) {
            NetworkResult.Error(-1, error.message ?: "网络连接失败", "asr_network")
        } catch (error: Exception) {
            NetworkResult.Error(-2, error.message ?: "语音识别失败", "asr_upstream_error")
        }
    }

    private fun apiCodeFor(status: Int): String = when (status) {
        400 -> "asr_bad_audio"
        401, 403 -> "asr_invalid_key"
        402 -> "asr_insufficient_balance"
        413 -> "asr_too_large"
        429 -> "asr_rate_limited"
        else -> "asr_upstream_error"
    }
}
