package com.noresign.paboot.model.session

import com.noresign.paboot.network.daemon.dto.SessionDto
import com.noresign.paboot.network.daemon.dto.WorkspaceDto

/**
 * 工作区概览里的一行目录（只读；docs/ui/mobile/pages/sessions.md §6.2）：
 * 主目录在前，之后是附加目录，各自带上「cwd 落在这个目录里」的会话数。
 */
data class WorkspaceDirectory(
    val path: String,
    /** 主目录：新会话默认在这里运行，不可移除；其余是附加目录。 */
    val isPrimary: Boolean,
    /**
     * cwd 落在该目录（含子目录）里的会话数；`null` = 会话列表还没加载完。
     * 用可空而不是 0，概览才不会在加载途中显示「0 个会话」误导人。
     */
    val sessionCount: Int?,
)

/** 主目录在前，附加目录去重；顺序与 daemon 返回的 `workspace_dirs` 一致。 */
fun workspaceDirectories(workspace: WorkspaceDto): List<String> =
    listOf(workspace.path) + workspace.dirs.filter { it != workspace.path }

/**
 * 会话属于某个目录 = cwd 就是它、或在它下面。同前缀的兄弟目录（`/repo2` vs `/repo`）
 * 不能命中，所以分隔符要参与比较；旧客户端写入的 cwd 可能混用分隔符，这里统一成 `/` 再比。
 */
fun sessionMatchesDir(cwd: String, dir: String): Boolean {
    val target = normalizeDir(dir)
    if (target.isEmpty()) return false
    val current = normalizeDir(cwd)
    if (current == target) return true
    return current.startsWith(if (target == "/") "/" else "$target/")
}

/** 概览要展示的目录行：主目录 + 附加目录 + 各自会话数。 */
fun workspaceDirectoryRows(
    workspace: WorkspaceDto,
    sessions: List<SessionDto>?,
): List<WorkspaceDirectory> = workspaceDirectories(workspace).mapIndexed { index, path ->
    WorkspaceDirectory(
        path = path,
        isPrimary = index == 0,
        sessionCount = sessions?.count { sessionMatchesDir(it.cwd, path) },
    )
}

private fun normalizeDir(path: String): String {
    val slashed = path.replace('\\', '/')
    val trimmed = slashed.trimEnd('/')
    // 根目录（`/`）不能 trim 成空串，否则拼前缀时会得到 `//`。
    return if (trimmed.isEmpty()) slashed else trimmed
}
