package com.noresign.paboot.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.PhoneAndroid
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.noresign.paboot.model.session.WorkspaceDirectory
import com.noresign.paboot.model.session.workspaceDirectoryRows
import com.noresign.paboot.network.daemon.dto.WorkspaceDto
import com.noresign.paboot.ui.theme.CodeBody
import androidx.lifecycle.viewmodel.compose.viewModel
import com.noresign.paboot.viewmodel.CapabilityStatusUiState
import com.noresign.paboot.viewmodel.CapabilityStatusViewModel
import com.noresign.paboot.viewmodel.SessionListUiState
import com.noresign.paboot.viewmodel.SessionListViewModel

/**
 * 工作区概览（只读；docs/ui/mobile/pages/sessions.md §6.2）。
 *
 * A full navigation destination rather than a modal sheet: it shares the main
 * tab's [SessionListViewModel], so the workspace list and session counts are
 * already there and the page never flashes a second loading state. Directory
 * edits stay in Settings → Workspaces.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceOverviewScreen(
    workspaceId: String,
    viewModel: SessionListViewModel,
    onBack: () -> Unit,
    onOpenKnowledge: (String) -> Unit,
    onOpenMemory: (String) -> Unit,
) {
    val uiState by viewModel.uiState.collectAsState()
    val workspaces by viewModel.workspaces.collectAsState()
    val workspace = workspaces.find { it.id == workspaceId }
    val sessions = (uiState as? SessionListUiState.Content)?.model?.allSessions
    val capabilityViewModel: CapabilityStatusViewModel = viewModel()
    val capabilityState by capabilityViewModel.state.collectAsState()
    LaunchedEffect(workspaceId) { capabilityViewModel.load(workspaceId) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("工作区概览") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        when {
            workspace != null -> {
                val dirs = remember(workspace, sessions) { workspaceDirectoryRows(workspace, sessions) }
                val totalSessions = if (dirs.all { it.sessionCount != null }) {
                    dirs.sumOf { it.sessionCount ?: 0 }
                } else {
                    null
                }
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    WorkspaceHero(workspace, dirs, totalSessions)
                    DirectorySection(dirs)
                    if (workspace.family != "life") {
                        KnowledgeCard(workspace, onOpenKnowledge)
                        CapabilityCard(capabilityState)
                    }
                    MemoryCard(workspace, onOpenMemory)
                    if (workspace.isBuiltin && workspace.family != "life") {
                        Text(
                            "内置工作区只是临时目录，建议先在设置里添加真实工作区。",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 4.dp),
                        )
                    }
                }
            }
            workspaces.isEmpty() -> Box(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator()
            }
            else -> Box(
                modifier = Modifier.fillMaxSize().padding(padding).padding(20.dp),
                contentAlignment = Alignment.Center,
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        "工作区不存在或已被删除。",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    OutlinedButton(onClick = onBack) { Text("返回") }
                }
            }
        }
    }
}

@Composable
private fun WorkspaceHero(
    workspace: WorkspaceDto,
    dirs: List<WorkspaceDirectory>,
    totalSessions: Int?,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(42.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(MaterialTheme.colorScheme.primaryContainer),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Rounded.Folder,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier.size(21.dp),
                    )
                }
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            workspaceDisplayName(workspace) ?: workspace.path,
                            style = MaterialTheme.typography.titleLarge,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        WorkspaceKindBadge(workspace)
                    }
                    Text(
                        workspace.path,
                        style = CodeBody,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatChip("${dirs.size} 个目录")
                totalSessions?.let { StatChip("$it 个会话") }
            }
        }
    }
}

@Composable
private fun WorkspaceKindBadge(workspace: WorkspaceDto) {
    val label = when {
        workspace.family == "life" -> "生活"
        workspace.isBuiltin -> "内置"
        else -> null
    }
    if (label != null) {
        Box(
            modifier = Modifier
                .padding(start = 8.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(MaterialTheme.colorScheme.primaryContainer)
                .padding(horizontal = 8.dp, vertical = 2.dp),
        ) {
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        }
    }
}

@Composable
private fun StatChip(text: String) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 9.dp, vertical = 3.dp),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun DirectorySection(dirs: List<WorkspaceDirectory>) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column {
            Row(
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("目录", style = MaterialTheme.typography.titleSmall)
                Spacer(modifier = Modifier.weight(1f))
                Text(
                    "${dirs.size}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            dirs.forEachIndexed { index, dir ->
                if (index > 0) {
                    HorizontalDivider(
                        modifier = Modifier.padding(horizontal = 16.dp),
                        color = MaterialTheme.colorScheme.outlineVariant,
                    )
                }
                DirectoryRow(dir)
            }
            Text(
                if (dirs.size > 1) {
                    "附加目录会扩大这个工作区所有会话的可写范围，不是只给当前对话。"
                } else {
                    "还没有附加目录，可以在设置 → 工作区管理里添加。"
                },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 14.dp),
            )
        }
    }
}

@Composable
private fun DirectoryRow(dir: WorkspaceDirectory) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Rounded.Folder,
            contentDescription = null,
            tint = if (dir.isPrimary) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
            modifier = Modifier.size(19.dp),
        )
        Spacer(modifier = Modifier.width(12.dp))
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                if (dir.isPrimary) "主目录" else "附加目录",
                style = MaterialTheme.typography.labelMedium,
                color = if (dir.isPrimary) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
            Text(
                dir.path,
                style = CodeBody,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        dir.sessionCount?.let { count ->
            Spacer(modifier = Modifier.width(10.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    "$count",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    "会话",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun KnowledgeCard(workspace: WorkspaceDto, onOpenKnowledge: (String) -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onOpenKnowledge(workspace.id) },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(38.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.primaryContainer),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Rounded.Description,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.size(19.dp),
                )
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text("知识", style = MaterialTheme.typography.titleSmall)
                Text(
                    "项目约定、决策与踩坑；自动收录，新会话按路径注入。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(
                Icons.Rounded.ChevronRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun CapabilityCard(state: CapabilityStatusUiState) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(38.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.primaryContainer),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Rounded.PhoneAndroid,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.size(19.dp),
                )
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text("Android 设备（只读）", style = MaterialTheme.typography.titleSmall)
                Text(
                    when (state) {
                        is CapabilityStatusUiState.Loading -> "检查中…"
                        is CapabilityStatusUiState.Unavailable -> "能力状态不可用"
                        is CapabilityStatusUiState.Content ->
                            if (state.activeEndName == null) {
                                "尚未添加 Android 端；请在桌面端添加。"
                            } else {
                                "端：${state.activeEndName} · ${state.onlineDevices} 台设备在线"
                            }
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "镜像 / 点击请在桌面端操作。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun MemoryCard(workspace: WorkspaceDto, onOpenMemory: (String) -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onOpenMemory(workspace.id) },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(38.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.primaryContainer),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Rounded.Person,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.size(19.dp),
                )
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                val life = workspace.family == "life"
                Text(
                    "记忆",
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(
                    if (life) {
                        "生活会话自动整理长期事实；新会话按记忆注入，可改正或忘记。"
                    } else {
                        "默认关闭；打开后可启用记忆、查看时间线、搜索与改正。"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(
                Icons.Rounded.ChevronRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
