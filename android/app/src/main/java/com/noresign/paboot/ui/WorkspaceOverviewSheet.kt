package com.noresign.paboot.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.noresign.paboot.model.session.WorkspaceDirectory
import com.noresign.paboot.model.session.workspaceDirectoryRows
import com.noresign.paboot.network.daemon.dto.SessionDto
import com.noresign.paboot.network.daemon.dto.WorkspaceDto
import com.noresign.paboot.ui.theme.CodeBody

/**
 * 工作区概览（只读；docs/ui/mobile/pages/sessions.md §6.2）：
 * 主目录 + 附加目录 + 各自的会话数。目录增删只在设置的工作区管理里做，
 * 这里不放任何写操作。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceOverviewSheet(
    workspace: WorkspaceDto,
    /** `null` = 会话列表还没加载完；此时不显示会话数，而不是显示 0。 */
    sessions: List<SessionDto>?,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        val dirs = remember(workspace, sessions) { workspaceDirectoryRows(workspace, sessions) }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("工作区概览", style = MaterialTheme.typography.titleLarge)

            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    workspaceDisplayName(workspace) ?: workspace.path,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    workspace.path,
                    style = CodeBody,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("目录", style = MaterialTheme.typography.labelLarge)
                Spacer(modifier = Modifier.weight(1f))
                Text(
                    "${dirs.size}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            dirs.forEach { dir -> DirectoryRow(dir) }

            Text(
                if (dirs.size > 1) {
                    "附加目录会扩大这个工作区所有会话的可写范围，不是只给当前对话。"
                } else {
                    "还没有附加目录，可以在设置 → 工作区管理里添加。"
                },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            if (workspace.isBuiltin) {
                Text(
                    "内置工作区只是临时目录，建议先在设置里添加真实工作区。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun DirectoryRow(dir: WorkspaceDirectory) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = Icons.Rounded.Folder,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (dir.isPrimary) "主目录" else "附加目录",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (dir.isPrimary) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                    Spacer(modifier = Modifier.weight(1f))
                    Text(
                        dir.sessionCount?.let { "$it 个会话" } ?: "会话数加载中…",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    dir.path,
                    style = CodeBody,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
