package com.noresign.paboot.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.noresign.paboot.network.daemon.dto.AgentProfileDto
import com.noresign.paboot.network.daemon.dto.SessionAgentDto

/**
 * 会话的「助手」面板。
 *
 * 三件事，都围绕「这个房间里谁在干活」：
 *   1. 谁是主答（leader）—— 顶栏的品牌、默认发言人、汇总执行者都由它决定；
 *   2. 每个成员现在能不能用、有没有自己的对话；
 *   3. 把主答交给别人、重置某个成员的对话、拉人进来 / 移出去。
 *
 * 机制字段（权限上限 / 只读 / 工具白名单）**不在这里显示** —— 那是 agent 编辑页的事，
 * 混进成员列表只会让人以为是房间级设置。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AssistantSheet(
    agents: List<SessionAgentDto>,
    leaderId: String?,
    workspaceAgents: List<AgentProfileDto>,
    onDismiss: () -> Unit,
    onSetLeader: (String) -> Unit,
    onResetContext: (String) -> Unit,
    onAddAgent: (String) -> Unit,
    onRemoveAgent: (String) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var resetTarget by remember { mutableStateOf<SessionAgentDto?>(null) }
    var showAdd by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Text("助手", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(2.dp))
            Text(
                "${agents.size} 个成员 · 主答是「${agents.firstOrNull { it.id == leaderId }?.name ?: "—"}」",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))

            LazyColumn(Modifier.fillMaxWidth()) {
                items(agents, key = { it.id }) { agent ->
                    val isLeader = agent.id == leaderId
                    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            AgentDot(agent, isLeader)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        agent.name,
                                        style = MaterialTheme.typography.bodyLarge,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    if (isLeader) {
                                        Spacer(Modifier.width(6.dp))
                                        Badge("主答")
                                    }
                                    if (agent.heavy) {
                                        Spacer(Modifier.width(6.dp))
                                        Badge("外部 CLI")
                                    }
                                }
                                Text(
                                    agent.summary.ifBlank { agent.backend },
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        // 不可用要说清原因，否则用户只会看到「它不说话」。
                        if (!agent.available) {
                            Text(
                                if (!agent.enabled) "已停用" else "当前离线",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                        Row(Modifier.padding(start = 22.dp, top = 4.dp)) {
                            if (!isLeader && agent.available) {
                                TextButton(onClick = { onSetLeader(agent.id) }) { Text("让它主答") }
                            }
                            if (agent.hasContext) {
                                TextButton(onClick = { resetTarget = agent }) { Text("重置对话") }
                            }
                            if (!isLeader) {
                                TextButton(onClick = { onRemoveAgent(agent.id) }) { Text("移出") }
                            }
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }

            Spacer(Modifier.height(8.dp))
            val addable = workspaceAgents.filter { candidate -> agents.none { it.id == candidate.id } }
            if (addable.isEmpty()) {
                Text(
                    "工作区里没有可添加的助手。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                TextButton(onClick = { showAdd = true }) { Text("添加助手（${addable.size} 个可选）") }
            }
        }
    }

    if (showAdd) {
        val addable = workspaceAgents.filter { candidate -> agents.none { it.id == candidate.id } }
        AlertDialog(
            onDismissRequest = { showAdd = false },
            title = { Text("添加助手") },
            text = {
                LazyColumn {
                    items(addable, key = { it.id }) { candidate ->
                        TextButton(
                            onClick = {
                                showAdd = false
                                onAddAgent(candidate.id)
                            },
                            enabled = candidate.available,
                        ) {
                            Column(Modifier.fillMaxWidth()) {
                                Text(candidate.name)
                                Text(
                                    candidate.summary.ifBlank { candidate.backend },
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showAdd = false }) { Text("取消") } },
        )
    }

    resetTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { resetTarget = null },
            title = { Text("重置「${target.name}」的对话？") },
            text = {
                Text(
                    "它的历史记录会保留，但下一次发言会从新对话开始。\n\n" +
                        "这不会清掉 runtime 自己保存的记忆（例如 Claude 的项目记忆）—— " +
                        "那部分不归 paboot 管。",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    onResetContext(target.id)
                    resetTarget = null
                }) { Text("重置") }
            },
            dismissButton = { TextButton(onClick = { resetTarget = null }) { Text("取消") } },
        )
    }
}

/** 状态点：主答用主色，离线用灰，其余按名字散列取色（与时间线上的色点一致）。 */
@Composable
private fun AgentDot(agent: SessionAgentDto, isLeader: Boolean) {
    val color = when {
        !agent.available -> MaterialTheme.colorScheme.outline
        isLeader -> MaterialTheme.colorScheme.primary
        else -> colorForAgent(agent.id)
    }
    Box(Modifier.size(12.dp).clip(CircleShape).background(color))
}

@Composable
private fun Badge(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primaryContainer)
            .padding(horizontal = 6.dp, vertical = 1.dp),
    )
}

/**
 * 稳定的散布色：同一个 agent 在任何界面都是同一个颜色。
 *
 * 用 id 而不是名字：改名不该换颜色，否则用户会以为是另一个助手。
 */
private fun colorForAgent(id: String): Color {
    val palette = listOf(
        Color(0xFF5B8DEF), Color(0xFF14B8A6), Color(0xFFF59E0B),
        Color(0xFFEC4899), Color(0xFF8B5CF6), Color(0xFF10B981),
    )
    val hash = id.fold(0) { acc, ch -> (acc * 31 + ch.code) and 0x7FFFFFFF }
    return palette[hash % palette.size]
}
