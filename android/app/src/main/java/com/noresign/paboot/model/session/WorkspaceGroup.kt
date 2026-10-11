package com.noresign.paboot.model.session

import com.noresign.paboot.network.daemon.dto.SessionDto

/** 会话列表按 cwd 分组后的结果（docs/ui/mobile/pages/sessions.md §6.2）。 */
data class WorkspaceGroup(
    /** 完整 cwd，用作分组的唯一 key。 */
    val cwd: String,
    /** 展示用路径：相对当前 workspace 的子目录名，兜底为完整路径。 */
    val displayName: String,
    val sessions: List<SessionDto>,
)

/** 会话列表的最终展示结构：当前 workspace 根目录的会话平铺，子目录会话分组。 */
data class SessionListModel(
    val rootSessions: List<SessionDto>,
    val subGroups: List<WorkspaceGroup>,
)

/**
 * 把会话按 cwd 拆分：cwd 等于 [workspacePath] 的会话平铺进 rootSessions；其余
 * （workspace 内子目录，通常来自续接本机会话）按 cwd 分组进 subGroups。根目录列表
 * 与组内都按 lastActiveAt 倒序，子目录组间按「组内最近活跃」倒序。
 */
fun groupByCwd(sessions: List<SessionDto>, workspacePath: String?): SessionListModel {
    val sorted = sessions.sortedByDescending { it.lastActiveAt }
    if (workspacePath.isNullOrBlank()) {
        // 未选中 workspace 时兜底：全部按 cwd 分组（保持旧行为）。
        val groups = sorted
            .groupBy { it.cwd.ifBlank { "默认工作目录" } }
            .map { (cwd, list) -> WorkspaceGroup(cwd, cwd, list) }
            .sortedByDescending { group -> group.sessions.maxOf { it.lastActiveAt } }
        return SessionListModel(emptyList(), groups)
    }
    val root = sorted.filter { normalize(it.cwd) == normalize(workspacePath) }
    val subGroups = sorted
        .filter { normalize(it.cwd) != normalize(workspacePath) }
        .groupBy { it.cwd.ifBlank { "默认工作目录" } }
        .map { (cwd, list) -> WorkspaceGroup(cwd, relativeTo(cwd, workspacePath), list) }
        .sortedByDescending { group -> group.sessions.maxOf { it.lastActiveAt } }
    return SessionListModel(root, subGroups)
}

private fun normalize(path: String): String = path.trimEnd('/')

private fun relativeTo(path: String, workspacePath: String): String {
    val base = workspacePath.trimEnd('/')
    val p = path.trimEnd('/')
    val prefix = "$base/"
    return if (p.startsWith(prefix)) p.removePrefix(prefix) else path
}
