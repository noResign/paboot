package com.noresign.paboot.network.asr

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** 上游返回非 2xx；[body] 留作业务层映射错误码，不直接展示。 */
class AsrHttpException(val status: Int, val body: String) : IOException("ASR HTTP $status")

/**
 * 直连 DeepSeek ASR，不经过 daemon。key 由用户在设置页填写，随请求以 Bearer 发出；
 * 这个客户端独立于 daemon token，也不记录请求内容。
 */
object DeepSeekAsrClient {
    private const val ENDPOINT = "https://api.deepseek.com/v1/tools/asr"
    private const val WAV = "audio/wav"
    private val json = Json { ignoreUnknownKeys = true }

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()
    }

    suspend fun transcribe(apiKey: String, wav: ByteArray): AsrTranscriptionDto {
        val multipart = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", "audio.wav", wav.toRequestBody(WAV.toMediaType()))
            .build()
        val request = Request.Builder()
            .url(ENDPOINT)
            .header("Authorization", "Bearer $apiKey")
            .post(multipart)
            .build()

        return client.newCall(request).await().use { response ->
            val raw = response.body?.bytes() ?: ByteArray(0)
            val text = raw.decodeToString()
            if (!response.isSuccessful) throw AsrHttpException(response.code, text)
            try {
                json.decodeFromString<AsrTranscriptionDto>(text)
            } catch (error: Exception) {
                throw IOException("语音识别响应解析失败", error)
            }
        }
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { cancel() }
        enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                if (continuation.isActive) continuation.resumeWithException(error)
            }

            override fun onResponse(call: Call, response: Response) {
                if (continuation.isActive) continuation.resume(response) else response.close()
            }
        })
    }
}
