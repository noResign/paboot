package com.noresign.paboot.network.asr

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** DeepSeek `POST /v1/tools/asr` 响应；外部 API，不属于 daemon 协议。 */
@Serializable
data class AsrTranscriptionDto(
    val text: String = "",
    @SerialName("duration_ms") val durationMs: Long = 0,
)
