package com.noresign.paboot.network.daemon.dto

import kotlinx.serialization.Serializable

/**
 * K0 知识文档 wire 模型。与 `daemon/src/types/api.ts` 的 KnowledgeDocDto /
 * KnowledgeDocDetailDto 对齐；移动端只读 + 核验标记，编辑留在桌面端。
 */

@Serializable
data class KnowledgeDocDto(
    val id: String,
    val workspaceId: String = "",
    /** null = 工作区级知识；否则属于某个端。 */
    val endId: String? = null,
    val kind: String = "note",
    val title: String = "",
    val summary: String? = null,
    val tags: List<String> = emptyList(),
    val origin: String = "user",
    val authority: String = "derived",
    /** confirmed | missing（pending/rejected 为旧值，读取时仍兼容） */
    val reviewStatus: String = "confirmed",
    val path: String = "",
    val contentHash: String = "",
    val updatedAt: Long = 0,
    val lastEditedBy: String = "scan",
)

@Serializable
data class KnowledgeDocDetailDto(
    val id: String,
    val workspaceId: String = "",
    val endId: String? = null,
    val kind: String = "note",
    val title: String = "",
    val summary: String? = null,
    val tags: List<String> = emptyList(),
    val origin: String = "user",
    val authority: String = "derived",
    val reviewStatus: String = "confirmed",
    val path: String = "",
    val contentHash: String = "",
    val updatedAt: Long = 0,
    val lastEditedBy: String = "scan",
    val body: String = "",
    val absolutePath: String = "",
)

@Serializable
data class KnowledgeDocsResponse(
    val documents: List<KnowledgeDocDto> = emptyList(),
)

@Serializable
data class KnowledgeDocResponse(
    val document: KnowledgeDocDetailDto? = null,
)

@Serializable
data class KnowledgeVerifyRequest(
    val verified: Boolean,
)

@Serializable
data class KnowledgeVerifyResponse(
    val document: KnowledgeDocDto? = null,
)
