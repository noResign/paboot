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
    /** False when the model cannot accept image input. */
    val supportsImages: Boolean? = null,
)

@Serializable
data class AgentModelsResponse(
    val models: List<ModelOptionDto> = emptyList(),
)

// ── 会话里的 agent（一份可复用的助手定义）──────────────────────────
//
// 与上面的 [AgentDto] 区分：那个是「后端插件的 runtime」（claude / codex），
// 这个是「房间里干活的那个助手」——有名字、简介、自己的目录与权限上限。
// 一个 runtime 可以承载多个 AgentProfile。

/**
 * `GET /api/workspaces/:id/agents` 的一项。
 *
 * 刻意不含机制字段（`readOnly` / `permissionCeiling` / `skills`）：那是创建者的视角，
 * `@` 候选和普通成员不需要看到。详情走 [AgentProfileDetailDto]。
 */
@Serializable
data class AgentProfileDto(
    val id: String,
    val name: String,
    /** 为空时 daemon 已回退到 `name`，客户端可放心直接渲染。 */
    val summary: String = "",
    val avatar: String? = null,
    /** builtin | runtime | peer */
    val kind: String = "builtin",
    /** 实际执行用哪个 backend：builtin / claude / codex / deepseek / peer。 */
    val backend: String = "builtin",
    /** 外部 CLI：群聊里只允许显式 @。 */
    val heavy: Boolean = false,
    val enabled: Boolean = true,
    /** 背后那个东西现在能不能跑（CLI 装了 / key 有 / 对端在线）。 */
    val online: Boolean = true,
    /** enabled ∧ online —— 唯一能真正被 @ 起任务的状态。 */
    val available: Boolean = true,
)

@Serializable
data class AgentProfilesResponse(
    val agents: List<AgentProfileDto> = emptyList(),
)

/** `GET /api/agents/:id` —— 创建者视角，含机制字段。 */
@Serializable
data class AgentProfileDetailDto(
    val id: String,
    val name: String,
    val summary: String = "",
    val avatar: String? = null,
    val kind: String = "builtin",
    val backend: String = "builtin",
    val heavy: Boolean = false,
    val enabled: Boolean = true,
    val online: Boolean = true,
    val available: Boolean = true,
    val workspaceId: String = "",
    val instructions: String = "",
    val model: String? = null,
    val modelParameters: Map<String, String>? = null,
    /** workspace 内的执行目录；null = 主目录。 */
    val cwd: String? = null,
    /** 附加可操作目录，每项都在 workspace 内。 */
    val extraDirs: List<String> = emptyList(),
    val readOnly: Boolean = false,
    /** ask | acceptEdits | bypass —— 这个 agent 的权限上限。 */
    val permissionCeiling: String = "ask",
    val skills: List<String>? = null,
    val version: Int = 1,
    val isImplicit: Boolean = false,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

@Serializable
data class AgentProfileDetailResponse(
    val agent: AgentProfileDetailDto,
    val maxSummaryChars: Int = 40,
)

/** `GET /api/sessions/:id/agents` 的一项：成员身份 + 是否已有对话。 */
@Serializable
data class SessionAgentDto(
    val id: String,
    val name: String,
    val summary: String = "",
    val avatar: String? = null,
    val kind: String = "builtin",
    val backend: String = "builtin",
    val heavy: Boolean = false,
    val enabled: Boolean = true,
    val online: Boolean = true,
    val available: Boolean = true,
    /** leader | member */
    val role: String = "member",
    /** 这个 agent 在本会话是否已有自己的对话（「重置对话」作用的对象）。 */
    val hasContext: Boolean = false,
    /** queued | running；null = 空闲。 */
    val taskStatus: String? = null,
    /** 该状态背后的排队/运行任务 id；用于单独取消。 */
    val taskId: String? = null,
)

/** 房间容量（含 leader）；老 daemon 不发，缺省表示不做上限提示。 */
@Serializable
data class RoomCapacityDto(
    val used: Int = 0,
    val max: Int = 0,
)

@Serializable
data class SessionAgentsResponse(
    val leaderId: String? = null,
    val agents: List<SessionAgentDto> = emptyList(),
    val capacity: RoomCapacityDto? = null,
)

/** 新建 / 编辑 agent 的请求体；字段都可选，daemon 只改传了的。 */
@Serializable
data class AgentProfileRequest(
    val name: String? = null,
    val summary: String? = null,
    val avatar: String? = null,
    val kind: String? = null,
    val runtime: String? = null,
    val instructions: String? = null,
    val model: String? = null,
    val cwd: String? = null,
    val extraDirs: List<String>? = null,
    val readOnly: Boolean? = null,
    val permissionCeiling: String? = null,
    val heavy: Boolean? = null,
    val enabled: Boolean? = null,
)
