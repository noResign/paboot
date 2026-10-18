package com.noresign.paboot.network.daemon.dto

import kotlinx.serialization.Serializable

/** paboot daemon wire 模型——agent（后端插件化 runtime）。与 `daemon/src/types/api.ts` 对齐。 */

/**
 * `GET /api/agents` 的一项（后端插件化 runtime）。
 *
 * [available] 是 daemon 探测 `--version` 的结果。默认 `true` 是刻意的：旧 daemon 不发这个
 * 字段，缺省成「不可用」会把所有 Agent 都置灰。
 */
@Serializable
data class AgentDto(
    val id: String,
    val name: String = "",
    val bin: String = "",
    val available: Boolean = true,
)

@Serializable
data class AgentsResponse(
    val agents: List<AgentDto> = emptyList(),
)

@Serializable
data class ModelParameterValueDto(
    val id: String,
    val label: String = "",
)

/** 模型自带的可调参数（如 reasoningEffort）；客户端按描述符动态渲染。 */
@Serializable
data class ModelParameterDto(
    val id: String,
    val label: String = "",
    val values: List<ModelParameterValueDto> = emptyList(),
    val defaultId: String? = null,
)

/** `GET /api/agents/:id/models` 的一项。 */
@Serializable
data class ModelOptionDto(
    val id: String,
    val label: String = "",
    val parameters: List<ModelParameterDto> = emptyList(),
)

@Serializable
data class AgentModelsResponse(
    val models: List<ModelOptionDto> = emptyList(),
)
