package com.noresign.paboot.network.daemon.dto

import kotlinx.serialization.Serializable

/** paboot daemon wire 模型——运行期动态配置。与 `daemon/src/types/api.ts` 对齐。 */

@Serializable
data class ConfigWorkspaceDto(
    val id: String,
    val name: String = "",
    val path: String = "",
    val isDefault: Boolean = false,
    val enabled: Boolean = true,
)

@Serializable
data class ServerConfigDto(
    val host: String = "",
    val port: Int = 0,
    val dataDir: String = "",
    val tls: Boolean = false,
    val restartRequired: List<String> = emptyList(),
)

@Serializable
data class ConfigResponse(
    val defaultPermissionMode: String = "ask",
    /** `local` on a personal machine; `server-strict` on a deployment. */
    val securityProfile: String = "local",
    /** Whether the active profile honors `permissionMode=bypass`. */
    val bypassAllowed: Boolean = true,
    val defaultWorkspaceId: String? = null,
    /** `<provider>:<model>`；null = 仅记录。 */
    val memoryModel: String? = null,
    val workspaces: List<ConfigWorkspaceDto> = emptyList(),
    val server: ServerConfigDto = ServerConfigDto(),
)

@Serializable
data class UpdateConfigRequest(
    val defaultPermissionMode: String? = null,
    val defaultWorkspaceId: String? = null,
)

@Serializable
data class ConfigUpdateResponse(
    val ok: Boolean = false,
    val config: ConfigResponse? = null,
)
