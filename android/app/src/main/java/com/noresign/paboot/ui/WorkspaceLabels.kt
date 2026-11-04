package com.noresign.paboot.ui

import com.noresign.paboot.network.daemon.dto.WorkspaceDto

/**
 * 用户可见的工作区名称：life 必须渲染成「生活」（内置除外），dev fallback 不暴露路径，
 * 其余用名称、名称空时用主目录。
 */
fun workspaceDisplayName(workspace: WorkspaceDto?): String? {
    if (workspace == null) return null
    if (workspace.family == "life") return workspace.name.ifBlank { "生活" }
    if (workspace.isBuiltin) return "内置工作区"
    return workspace.name.ifBlank { workspace.path }
}
