package com.noresign.paboot.ui

import com.noresign.paboot.network.daemon.dto.WorkspaceDto

/**
 * 用户可见的工作区名称：life 固定渲染成「个人空间」，其余用名称、名称空时用主目录。
 */
fun workspaceDisplayName(workspace: WorkspaceDto?): String? {
    if (workspace == null) return null
    if (workspace.family == "life") return workspace.name.ifBlank { "个人空间" }
    return workspace.name.ifBlank { workspace.path }
}
