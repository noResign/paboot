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

/**
 * 根目录会话里「最近」与「更早」的分界：超过这么久没活动就收进折叠分组。
 *
 * 只作用于根目录平铺列表——子目录分组本来就默认折叠，不必再套一层。为的是别让翻不到
 * 的历史一直把当前在用的会话往下挤。
 */
const val SESSION_RECENT_WINDOW_MS: Long = 3L * 24 * 60 * 60 * 1000

/**
 * 会话列表的最终展示结构：当前 workspace 根目录的会话平铺（近期的在上、更早的折叠成一段），
 * 子目录会话分组。
 */
data class SessionListModel(
    val rootSessions: List<SessionDto>,
    /** 根目录里超过 [SESSION_RECENT_WINDOW_MS] 没活动的会话，界面上默认折叠。 */
    val olderRootSessions: List<SessionDto>,
    val subGroups: List<WorkspaceGroup>,
    /** 绑定过定时任务、或本身就是任务配置会话的会话，单独成组。 */
    val taskSessions: List<SessionDto> = emptyList(),
) {
    /**
     * 平铺后的全部会话（删除 / 重命名做乐观更新时要把列表拼回来）。放在这里而不是让
     * 调用方自己拼 `rootSessions + subGroups`：折叠段每加一处，那种写法就会漏一处。
     */
    val allSessions: List<SessionDto>
        get() = rootSessions + olderRootSessions + subGroups.flatMap { it.sessions } + taskSessions
}

private fun isTaskRelated(session: SessionDto): Boolean =
    session.scheduledTaskCount > 0 || session.purpose == "task_config"

/**
 * 把会话按 cwd 拆分：cwd 等于 [workspacePath] 的会话平铺进 [SessionListModel.rootSessions]
 * （按 [SESSION_RECENT_WINDOW_MS] 再切成「近期 / 更早」两段）；其余（workspace 内子目录，
 * 例如历史数据里的导入会话）按 cwd 分组进 [SessionListModel.subGroups]。各段内部都按
 * lastActiveAt 倒序，子目录组间按「组内最近活跃」倒序。
 *
 * [now] 只用于判定「更早」，注入是为了可测。
 */
fun groupByCwd(
    sessions: List<SessionDto>,
    workspacePath: String?,
    now: Long = System.currentTimeMillis(),
): SessionListModel {
    val sorted = sessions.sortedByDescending { it.lastActiveAt }
    // Task-bound sessions (and the per-workspace authoring chat) get their own
    // section so they do not interleave with normal conversations.
    val (taskSessions, normalSessions) = sorted.partition(::isTaskRelated)
    if (workspacePath.isNullOrBlank()) {
        // 未选中 workspace 时兜底：全部按 cwd 分组（保持旧行为）。
        val groups = normalSessions
            .groupBy { it.cwd.ifBlank { "默认工作目录" } }
            .map { (cwd, list) -> WorkspaceGroup(cwd, cwd, list) }
            .sortedByDescending { group -> group.sessions.maxOf { it.lastActiveAt } }
        return SessionListModel(emptyList(), emptyList(), groups, taskSessions)
    }
    val (recent, older) = normalSessions
        .filter { normalize(it.cwd) == normalize(workspacePath) }
        .partition { it.lastActiveAt >= now - SESSION_RECENT_WINDOW_MS }
    val subGroups = normalSessions
        .filter { normalize(it.cwd) != normalize(workspacePath) }
        .groupBy { it.cwd.ifBlank { "默认工作目录" } }
        .map { (cwd, list) -> WorkspaceGroup(cwd, relativeTo(cwd, workspacePath), list) }
        .sortedByDescending { group -> group.sessions.maxOf { it.lastActiveAt } }
    return SessionListModel(recent, older, subGroups, taskSessions)
}

private fun normalize(path: String): String = path.trimEnd('/')

private fun relativeTo(path: String, workspacePath: String): String {
    val base = workspacePath.trimEnd('/')
    val p = path.trimEnd('/')
    val prefix = "$base/"
    return if (p.startsWith(prefix)) p.removePrefix(prefix) else path
}
