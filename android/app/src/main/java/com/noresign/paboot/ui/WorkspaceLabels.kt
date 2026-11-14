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

/**
 * 界面上可以展示的工作区路径。个人空间的主目录是内部实现细节
 * （`<dataDir>/life`），任何页面都不展示它。
 */
fun workspaceVisiblePath(workspace: WorkspaceDto?): String? {
    if (workspace == null || workspace.family == "life") return null
    return workspace.path
}
