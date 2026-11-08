package com.noresign.paboot.network.daemon.dto

import kotlinx.serialization.Serializable

/**
 * Memory M0 wire 模型。与 `daemon/src/types/api.ts` 的 MemoryClaimDto /
 * MemoryBriefDto / MemoryStatusDto 对齐；移动端只读 + 改正，不做整理配置。
 */

@Serializable
data class MemoryClaimEvidenceDto(
    val sourceId: String = "",
    val quote: String? = null,
    val relation: String = "supports",
)

@Serializable
data class MemoryClaimDto(
    val id: String = "",
    val scope: String = "",
    val endId: String? = null,
    val predicate: String = "",
    val objectText: String? = null,
    val kind: String = "fact",
    val summary: String = "",
    val authority: String = "derived",
    val validFrom: Long? = null,
    val validTo: Long? = null,
    val timePrecision: String = "unknown",
    val confidence: Double = 0.0,
    val importance: Double = 0.0,
    val sensitivity: String = "normal",
    val status: String = "active",
    val evidence: List<MemoryClaimEvidenceDto> = emptyList(),
    val updatedAt: Long = 0,
)

@Serializable
data class MemoryClaimsResponse(
    val claims: List<MemoryClaimDto> = emptyList(),
)

@Serializable
data class MemoryClaimResponse(
    val claim: MemoryClaimDto? = null,
)

@Serializable
data class MemoryBriefDto(
    val scope: String = "",
    val markdown: String = "",
    val charCount: Int = 0,
    val usedClaimIds: List<String> = emptyList(),
    val truncated: Boolean = false,
    val builtAt: Long = 0,
)

@Serializable
data class MemoryStatusDto(
    val scope: String = "",
    val pendingSources: Int = 0,
    val lastConsolidatedAt: Long? = null,
    val lastSuccessAt: Long? = null,
    val consecutiveFailures: Int = 0,
    val extractionModel: String? = null,
    val modelAvailable: Boolean = false,
    val enabled: Boolean = true,
)

@Serializable
data class MemoryCorrectClaimRequest(
    val summary: String? = null,
    val objectText: String? = null,
)

@Serializable
data class MemorySessionModeRequest(
    val sessionId: String,
    val mode: String,
)

@Serializable
data class MemorySessionModeResponse(
    val sessionId: String = "",
    val mode: String = "normal",
)
