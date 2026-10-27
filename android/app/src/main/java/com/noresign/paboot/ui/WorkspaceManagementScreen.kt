package com.noresign.paboot.ui

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import androidx.lifecycle.viewmodel.compose.viewModel
import com.noresign.paboot.network.daemon.dto.WorkspaceDto
import com.noresign.paboot.viewmodel.SettingsUiState
import com.noresign.paboot.viewmodel.SettingsViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceManagementScreen(
    onBack: () -> Unit,
    viewModel: SettingsViewModel = viewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val selectedWorkspaceId by viewModel.selectedWorkspaceId.collectAsState()
    val directoryPicker by viewModel.directoryPicker.collectAsState()
    val dirTargetWorkspaceId by viewModel.dirTargetWorkspaceId.collectAsState()

    var renameTarget by remember { mutableStateOf<WorkspaceDto?>(null) }
    var renameText by remember { mutableStateOf("") }
    var deleteTarget by remember { mutableStateOf<WorkspaceDto?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("工作区") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    // 方法引用不套用默认参数，这里必须用 lambda 才能落到「新增工作区」。
                    TextButton(onClick = { viewModel.openDirectoryPicker() }) { Text("+ 新增") }
                },
            )
        },
    ) { innerPadding ->
        when (val state = uiState) {
            is SettingsUiState.Loading -> Box(
                Modifier.fillMaxSize().padding(innerPadding),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator() }
            is SettingsUiState.Error -> Column(
                modifier = Modifier.fillMaxSize().padding(innerPadding).padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(state.message, color = MaterialTheme.colorScheme.error)
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedButton(onClick = viewModel::load) { Text("重试") }
            }
            is SettingsUiState.Ready -> {
                // 内置 fallback 仍参与会话/文件的 id 解析，但不是用户可管理的工作区。
                val shownWorkspaces = state.workspaces.filter { !it.isBuiltin }
                if (shownWorkspaces.isEmpty()) {
                    Box(
                        modifier = Modifier.fillMaxSize().padding(innerPadding).padding(20.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "还没有添加工作区，点右上角「+ 新增」添加一个。",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                } else {
                    val listState = rememberLazyListState()
                    // 同时只允许一张卡滑开；列表一滚就收起，免得半开的卡片跟着跑。
                    var openedId by remember { mutableStateOf<String?>(null) }
                    LaunchedEffect(listState.isScrollInProgress) {
                        if (listState.isScrollInProgress) openedId = null
                    }
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize().padding(innerPadding),
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(shownWorkspaces, key = { it.id }) { workspace ->
                            val revealed = openedId == workspace.id
                            SwipeRevealCard(
                                revealed = revealed,
                                onRevealChange = { openedId = if (it) workspace.id else null },
                                onDelete = {
                                    openedId = null
                                    deleteTarget = workspace
                                },
                            ) {
                                WorkspaceCard(
                                    workspace = workspace,
                                    selected = workspace.id == selectedWorkspaceId,
                                    // 滑开时点卡片是「收起」，不是切换当前工作区。
                                    onSelect = {
                                        if (revealed) openedId = null else viewModel.selectWorkspace(workspace.id)
                                    },
                                    onToggleEnabled = { viewModel.setWorkspaceEnabled(workspace.id, !workspace.enabled) },
                                    onRename = {
                                        renameTarget = workspace
                                        renameText = workspace.name
                                    },
                                    onAddDir = { viewModel.openDirectoryPicker(workspace.id) },
                                    onRemoveDir = { path -> viewModel.removeWorkspaceDir(workspace.id, path) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    directoryPicker?.let { state ->
        // 落点是「附加目录」时不禁用「已是工作区」——同一个目录也可以被工作区引用。
        val addingDir = dirTargetWorkspaceId != null
        DirectoryPickerDialog(
            state = state,
            onDismiss = viewModel::closeDirectoryPicker,
            onBrowse = { viewModel.loadDirectories(it) },
            onToggleHidden = viewModel::toggleDirectoryHidden,
            onSelect = viewModel::confirmDirectoryPick,
            title = if (addingDir) "选择附加目录" else "选择工作区目录",
            selectLabel = if (addingDir) "添加此文件夹" else null,
            selectEnabled = if (addingDir) true else null,
        )
    }

    renameTarget?.let { workspace ->
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text("重命名工作区") },
            text = {
                OutlinedTextField(
                    value = renameText,
                    onValueChange = { renameText = it },
                    singleLine = true,
                    label = { Text("名称") },
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.renameWorkspace(workspace.id, renameText)
                        renameTarget = null
                    },
                ) { Text("保存") }
            },
            dismissButton = {
                TextButton(onClick = { renameTarget = null }) { Text("取消") }
            },
        )
    }

    deleteTarget?.let { workspace ->
        // 每个工作区一份独立的勾选态，换目标时重置。
        var cascade by remember(workspace.id) { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("删除工作区") },
            text = {
                Column {
                    Text("确定删除「${workspace.name.ifBlank { workspace.path }}」吗？")
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        "只会删掉工作区本身，磁盘上的目录和文件不受影响。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (workspace.sessionCount > 0) {
                        Spacer(modifier = Modifier.height(12.dp))
                        Row(
                            verticalAlignment = Alignment.Top,
                            modifier = Modifier.fillMaxWidth().clickable { cascade = !cascade },
                        ) {
                            Checkbox(checked = cascade, onCheckedChange = { cascade = it })
                            Spacer(modifier = Modifier.width(4.dp))
                            Column {
                                Text("同时删除该工作区下的 ${workspace.sessionCount} 个会话")
                                Spacer(modifier = Modifier.height(2.dp))
                                Text(
                                    "聊天记录、运行事件与会话级授权一并删除；" +
                                        "电脑上的 Claude Code 会话记录不受影响，同一个目录重新加回来仍能续接。",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.deleteWorkspace(workspace.id, cascade)
                        deleteTarget = null
                    },
                    // 有会话又不勾级联，daemon 一定 409，所以直接禁用并让用户去勾。
                    enabled = workspace.sessionCount == 0 || cascade,
                ) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text("取消") }
            },
        )
    }
}

/**
 * 一行可能被省略号截断的路径：点一下在它**上方**弹出一条完整路径的浮条（可换行、白底细描边），
 * 再点一次收起，点浮条本身也收起。主目录那行不带 [prefix] 和 [trailing]，附加目录带「＋」前缀
 * 和「移除」按钮。
 *
 * 展开状态由调用方持有，好让同一张卡里只有一个路径是展开的。
 */
@Composable
private fun ExpandablePath(
    path: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    prefix: String = "",
    trailing: (@Composable () -> Unit)? = null,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        if (expanded) {
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp).clickable(onClick = onToggle),
            ) {
                Text(
                    path,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "$prefix$path",
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).clickable(onClick = onToggle),
            )
            trailing?.invoke()
        }
    }
}

/**
 * 左滑卡片露出「删除」并**停在滑开位置**，再点露出的按钮才走删除流程；点卡片本身收起。
 * 同一时刻只允许一张滑开、列表滚动时收起，由调用方持有的 [revealed] 决定。
 *
 * 没用 M3 的 `SwipeToDismissBox`：那个松手即触发动作、停不在中间，而这里要的是「滑开 → 再点」。
 */
@Composable
private fun SwipeRevealCard(
    revealed: Boolean,
    onRevealChange: (Boolean) -> Unit,
    onDelete: () -> Unit,
    content: @Composable () -> Unit,
) {
    val actionWidth = 88.dp
    val actionPx = with(LocalDensity.current) { actionWidth.toPx() }
    var offsetX by remember { mutableFloatStateOf(0f) }
    // 每次拖拽结束 +1：即使滑开状态没变（滑一点点又放开），也要补间回锚点。
    var settle by remember { mutableIntStateOf(0) }

    LaunchedEffect(revealed, settle, actionPx) {
        val target = if (revealed) -actionPx else 0f
        animate(initialValue = offsetX, targetValue = target, animationSpec = tween(180)) { value, _ ->
            offsetX = value
        }
    }

    Box {
        // 底下的删除动作：卡片被推开后露出来，形状跟着卡片（12dp 圆角）。
        Box(modifier = Modifier.matchParentSize(), contentAlignment = Alignment.CenterEnd) {
            Box(
                modifier = Modifier
                    .width(actionWidth)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.error)
                    .clickable(onClick = onDelete),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "删除",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onError,
                )
            }
        }
        Box(
            modifier = Modifier
                .offset { IntOffset(offsetX.roundToInt(), 0) }
                .draggable(
                    orientation = Orientation.Horizontal,
                    state = rememberDraggableState { delta ->
                        offsetX = (offsetX + delta).coerceIn(-actionPx, 0f)
                    },
                    onDragStopped = { velocity ->
                        onRevealChange(offsetX < -actionPx / 2f || velocity < -800f)
                        settle += 1
                    },
                ),
        ) { content() }
    }
}

@Composable
private fun WorkspaceCard(
    workspace: WorkspaceDto,
    selected: Boolean,
    onSelect: () -> Unit,
    onToggleEnabled: () -> Unit,
    onRename: () -> Unit,
    onAddDir: () -> Unit,
    onRemoveDir: (String) -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onSelect),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            },
        ),
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = selected, onClick = onSelect)
                Spacer(modifier = Modifier.width(8.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            workspace.name.ifBlank { workspace.path },
                            style = MaterialTheme.typography.titleSmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (!workspace.enabled) {
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                "已禁用",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                    // 主目录和附加目录的路径都可能被省略号截断：点一下在它**上方**弹出完整路径的
                    // 浮条（可换行），再点收起。两者共用一个展开态，所以同一时刻只有一条是展开的。
                    var expandedPath by remember(workspace.id) { mutableStateOf<String?>(null) }
                    ExpandablePath(
                        path = workspace.path,
                        expanded = expandedPath == workspace.path,
                        onToggle = {
                            expandedPath = if (expandedPath == workspace.path) null else workspace.path
                        },
                    )
                    Text(
                        "${workspace.sessionCount} 个会话",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    // 附加目录是这个工作区所有会话共用的可达目录；这里是唯一的增删入口。
                    workspace.dirs.forEach { dir ->
                        ExpandablePath(
                            path = dir,
                            prefix = "＋ ",
                            expanded = expandedPath == dir,
                            onToggle = { expandedPath = if (expandedPath == dir) null else dir },
                            trailing = { TextButton(onClick = { onRemoveDir(dir) }) { Text("移除") } },
                        )
                    }
                }
            }
            // 固定三个按钮、不横向滚动：左右内边距压到 4dp，这样 320dp 宽的屏也放得下；
            // 「删除」挪到左滑卡片里（见 SwipeRevealCard），不占这一行。
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                val tight = PaddingValues(horizontal = 4.dp)
                TextButton(onClick = onToggleEnabled, contentPadding = tight) {
                    Text(if (workspace.enabled) "禁用" else "启用", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                TextButton(onClick = onRename, contentPadding = tight) {
                    Text("重命名", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                TextButton(onClick = onAddDir, contentPadding = tight) {
                    Text("+ 附加目录", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}
