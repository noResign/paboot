package com.noresign.paboot.ui.identity

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Build
import androidx.compose.material.icons.rounded.SmartToy
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import com.noresign.paboot.ui.theme.DesignColors
import com.noresign.paboot.network.daemon.dto.AgentDto

/**
 * 一个 runtime（agent）的 UI 身份：图标 + 主题色 + 展示名（docs/ui/shared/design-principles.md §5.2）。
 * 新增 agent 只需在 [RuntimeIdentities] 的 table 里加一行，不改布局。
 */
data class RuntimeIdentity(
    val id: String,
    val displayName: String,
    val icon: ImageVector,
    val color: Color,
)

object RuntimeIdentities {

    private val table = mapOf(
        "claude" to RuntimeIdentity(
            id = "claude",
            displayName = "Claude Code",
            icon = Icons.Rounded.SmartToy,
            color = DesignColors.ClaudeOrange,
        ),
        // 图标用 §5.1 已有的 `terminal` 语义名，和 Claude 的 `smart_toy` 区分开——
        // 两个 agent 同图标时，选择器里只剩颜色可分辨。
        "codex" to RuntimeIdentity("codex", "Codex", Icons.Rounded.Terminal, Color(0xFF10A37F)),
    )

    /** 未知 id 兜底：build 图标 + 中性色 + 直接展示后端 name（§5.2）。 */
    private val neutralFallback = Color(0xFF8A949E)

    fun of(id: String): RuntimeIdentity = table[id] ?: RuntimeIdentity(
        id = id,
        displayName = id.ifBlank { "agent" },
        icon = Icons.Rounded.Build,
        color = neutralFallback,
    )
}


/**
 * 新建会话时默认选中的 Agent：第一个**装了**的。
 *
 * 不能直接取 `first()`——列表顺序来自 daemon 注册顺序，第一个很可能是没装的那个，
 * 用户一进来就选中一个发不出去的 Agent。一个都没装时返回 null，让发送时的 daemon
 * 错误去解释原因。
 */
internal fun defaultAgentId(agents: List<AgentDto>): String? =
    agents.firstOrNull { it.available }?.id

/** The same saved mode has different execution semantics in each runtime. */
internal fun permissionModeOptions(runtime: String?): List<Pair<String, String>> = when (runtime) {
    "codex" -> listOf(
        "ask" to "工作区沙箱；不受信任的命令需要审批，工作区编辑可能自动执行",
        "acceptEdits" to "工作区沙箱内的命令和编辑可自动执行；提权由 Codex 请求审批",
        "bypass" to "关闭沙箱并跳过工具审批（高风险）",
    )
    "claude" -> listOf(
        "ask" to "修改类操作询问",
        "acceptEdits" to "编辑自动放行，Bash 仍询问",
        "bypass" to "全部通过（高风险）",
    )
    else -> listOf(
        "ask" to "按 Agent 默认规则审批，具体范围见新建会话页",
        "acceptEdits" to "减少审批；部分 Agent 也会自动执行命令",
        "bypass" to "跳过工具审批（高风险）",
    )
}
