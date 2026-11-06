package com.noresign.paboot.network.daemon.dto

import kotlinx.serialization.Serializable

/** Optional list price for a provider model, in USD per million tokens. */
@Serializable
data class ProviderModelPriceDto(
    val inputPerMTok: Double,
    val outputPerMTok: Double,
)

/** LLM provider catalog wire models; plaintext API keys never appear here. */
@Serializable
data class ProviderModelDto(
    val id: String,
    val label: String? = null,
    val contextWindow: Int? = null,
    val maxOutput: Int? = null,
    val supportsTools: Boolean? = null,
    val supportsImages: Boolean? = null,
    val enabled: Boolean? = null,
    val price: ProviderModelPriceDto? = null,
)

@Serializable
data class ProviderDto(
    val id: String,
    val kind: String = "openai",
    val label: String = "",
    val baseUrl: String = "",
    val models: List<ProviderModelDto> = emptyList(),
    val hasApiKey: Boolean = false,
    val apiKeySource: String? = null,
    val builtin: Boolean = false,
)

@Serializable
data class ProvidersResponse(
    val providers: List<ProviderDto> = emptyList(),
)

@Serializable
data class ProviderResponse(
    val ok: Boolean = false,
    val provider: ProviderDto? = null,
)

@Serializable
data class ProviderTestResponse(
    val ok: Boolean = false,
    val status: Int = 0,
    val latencyMs: Long = 0,
    val modelCount: Int? = null,
)
