package com.noresign.paboot.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.noresign.paboot.network.daemon.dto.AgentProfileDto

/**
 * 新建会话时选「谁来主答」。
 *
 * 只在还没有会话时出现：一旦发出第一条消息，主答就由成员关系决定，改它要进「助手」面板
 * 换 leader —— 两件事分开，避免同一个决定有两个入口。
 *
 * 不可用的 agent 仍然列出来但置灰，并写清原因：直接不显示会让用户以为它被删了。
 */
@Composable
fun AgentPickerDialog(
    agents: List<AgentProfileDto>,
    selectedId: String?,
    onSelect: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("谁来主答") },
        text = {
            if (agents.isEmpty()) {
                Text("这个工作区还没有助手。默认使用工作区的 runtime。")
            } else {
                LazyColumn {
                    item {
                        AgentRow(
                            name = "工作区默认",
                            summary = "用工作区设定的 runtime，不指定助手",
                            selected = selectedId == null,
                            enabled = true,
                            color = MaterialTheme.colorScheme.outline,
                            onClick = {
                                onSelect(null)
                                onDismiss()
                            },
                        )
                    }
                    items(agents, key = { it.id }) { agent ->
                        AgentRow(
                            name = agent.name,
                            summary = agent.summary.ifBlank { agent.backend },
                            selected = selectedId == agent.id,
                            enabled = agent.available,
                            color = if (agent.available) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.outline
                            },
                            note = when {
                                !agent.enabled -> "已停用"
                                !agent.online -> "当前离线"
                                else -> null
                            },
                            onClick = {
                                onSelect(agent.id)
                                onDismiss()
                            },
                        )
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun AgentRow(
    name: String,
    summary: String,
    selected: Boolean,
    enabled: Boolean,
    color: Color,
    note: String? = null,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(if (enabled) color else MaterialTheme.colorScheme.outlineVariant),
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                name,
                style = MaterialTheme.typography.bodyLarge,
                color = if (enabled) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                note ?: summary,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (selected) {
            Text(
                "✓",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}
