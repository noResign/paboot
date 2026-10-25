package com.noresign.paboot.data

/** 新建会话时选择的配置（工作区 / runtime / 权限模式）。 */
data class NewSessionConfig(
    val runtime: String? = null,
    val workspaceId: String? = null,
    val permissionMode: String? = null,
)

/**
 * 「新建会话」Sheet 与聊天页之间的临时传递：Sheet 写入 → 导航到新会话 → 聊天页读取并清空。
 */
object PendingNewSession {
    @Volatile
    private var config: NewSessionConfig? = null

    fun set(
        runtime: String? = null,
        workspaceId: String? = null,
        permissionMode: String? = null,
    ) {
        config = NewSessionConfig(
            runtime = runtime,
            workspaceId = workspaceId,
            permissionMode = permissionMode,
        )
    }

    fun take(): NewSessionConfig? {
        val c = config
        config = null
        return c
    }
}
