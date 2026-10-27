package com.noresign.paboot.network.daemon.dto

import kotlinx.serialization.Serializable

/** paboot daemon wire 模型——Workspace 与目录选择器。与 `daemon/src/types/api.ts` 对齐。 */

@Serializable
data class WorkspaceDto(
    val id: String,
    val name: String = "",
    /** 主目录，也是新会话的 spawn cwd。 */
    val path: String = "",
    /** 额外授予该工作区的目录；该工作区所有会话都继承。 */
    val dirs: List<String> = emptyList(),
    /**
     * 文件 Tab 的浏览书签。与 [dirs] 不同，它**不授予 agent 任何权限**，
     * 只是多一个可切换的 tab；分开存就是为了不让两者混淆。
     */
    val shortcutDirs: List<String> = emptyList(),
    val isDefault: Boolean = false,
    /** daemon 的内置 fallback（只有它是唯一工作区时才会出现在列表里）；不可删/不可停用。 */
    val isBuiltin: Boolean = false,
    val enabled: Boolean = true,
    val sessionCount: Int = 0,
    val createdAt: Long = 0,
    val lastUsedAt: Long = 0,
)

@Serializable
data class WorkspaceDirsRequest(
    val path: String,
)

@Serializable
data class WorkspaceDirsResponse(
    val ok: Boolean = false,
    val dirs: List<String> = emptyList(),
)

@Serializable
data class WorkspaceShortcutsResponse(
    val ok: Boolean = false,
    val shortcutDirs: List<String> = emptyList(),
)

@Serializable
data class WorkspacesResponse(
    val workspaces: List<WorkspaceDto> = emptyList(),
)

@Serializable
data class CreateWorkspaceRequest(
    val name: String? = null,
    val path: String,
)

@Serializable
data class UpdateWorkspaceRequest(
    val name: String? = null,
    val isDefault: Boolean? = null,
    val enabled: Boolean? = null,
)

@Serializable
data class WorkspaceResponse(
    val ok: Boolean = false,
    val workspace: WorkspaceDto? = null,
)

@Serializable
data class DirectoryEntryDto(
    val name: String,
    val path: String,
    val isWorkspace: Boolean = false,
)

@Serializable
data class DirectoriesResponse(
    val path: String = "",
    val parent: String? = null,
    val entries: List<DirectoryEntryDto> = emptyList(),
)
