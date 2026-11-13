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
    /** 唯一内置的「个人空间」工作区；不可删/不可停用，但可作为默认。 */
    val isBuiltin: Boolean = false,
    /** `dev` | `life`；旧 daemon 不发时按 dev 处理。 */
    val family: String = "dev",
    /** `off` | `portable` | `full`；只有 life 有意义。 */
    val profileMode: String = "portable",
    /** dev 专用：life 是否可单向读；默认关。 */
    val lifeReadable: Boolean = false,
    /** 新建会话默认 runtime；null = 跟随全局（claude）。 */
    val defaultRuntime: String? = null,
    /** 新建会话默认权限模式；null = 跟随全局。 */
    val defaultPermissionMode: String? = null,
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
    val defaultRuntime: String? = null,
    val defaultPermissionMode: String? = null,
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

@Serializable
data class EndDto(
    val id: String = "",
    val workspaceId: String = "",
    val family: String = "dev",
    val kind: String = "android",
    val name: String = "",
    val status: String = "draft",
    val roots: List<String> = emptyList(),
    val createdAt: Long = 0L,
    val archivedAt: Long? = null,
    val summary: String = "",
    val notes: String = "",
)

@Serializable
data class SessionEndDto(
    val id: String = "",
    val workspaceId: String = "",
    val family: String = "dev",
    val kind: String = "android",
    val name: String = "",
    val status: String = "active",
    val roots: List<String> = emptyList(),
    val createdAt: Long = 0L,
    val archivedAt: Long? = null,
    val summary: String = "",
    val notes: String = "",
    val role: String = "active",
)

@Serializable
data class SessionEndsResponse(
    val primaryEndId: String? = null,
    val ends: List<SessionEndDto> = emptyList(),
)

@Serializable
data class EndsResponse(
    val ends: List<EndDto> = emptyList(),
)
