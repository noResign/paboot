package com.noresign.paboot.ui

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import kotlin.math.roundToInt
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.History
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import com.noresign.paboot.data.PendingNewSession
import com.noresign.paboot.data.WorkspaceSelection
import com.noresign.paboot.network.daemon.dto.SessionDto
import com.noresign.paboot.model.session.SessionListModel
import com.noresign.paboot.ui.component.AgentBadge
import com.noresign.paboot.ui.component.PullToRefreshContainer
import com.noresign.paboot.ui.component.RunningIndicator
import com.noresign.paboot.ui.theme.CodeBody
import com.noresign.paboot.util.relativeTime
import com.noresign.paboot.viewmodel.SessionListUiState
import com.noresign.paboot.viewmodel.SessionListViewModel

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun SessionListScreen(
    onOpenSession: (String) -> Unit,
    onNewSession: () -> Unit,
    onReconnect: () -> Unit,
    bottomOverlayPadding: Dp = 0.dp,
    viewModel: SessionListViewModel = viewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val message by viewModel.message.collectAsState()
    val renameSubmitting by viewModel.renameSubmitting.collectAsState()
    val renameError by viewModel.renameError.collectAsState()
    val refreshing by viewModel.refreshing.collectAsState()
    val workspacePath by WorkspaceSelection.selectedPath.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var pendingRename by remember { mutableStateOf<SessionDto?>(null) }
    var renameTitle by remember { mutableStateOf("") }
    var pendingDelete by remember { mutableStateOf<SessionDto?>(null) }
    var showNewSession by remember { mutableStateOf(false) }

    LifecycleResumeEffect(Unit) {
        viewModel.refreshSilently()
        onPauseOrDispose { }
    }

    LaunchedEffect(message) {
        message?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.consumeMessage()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("会话")
                        workspacePath?.let {
                            Text(
                                it,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { showNewSession = true },
                modifier = Modifier.padding(bottom = bottomOverlayPadding),
            ) {
                Icon(Icons.Rounded.Add, contentDescription = "新建会话")
            }
        },
    ) { innerPadding ->
        // 整页跟手（见 PullToRefreshContainer）。空态 / 错误态的内容不是可滚动组件，
        // 下拉手势未必触发——所以错误态的「重试」按钮不能省。
        PullToRefreshContainer(
            isRefreshing = refreshing,
            onRefresh = viewModel::pullRefresh,
            modifier = Modifier.fillMaxSize().padding(innerPadding),
        ) {
            when (val state = uiState) {
                is SessionListUiState.Loading -> {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                }
                is SessionListUiState.Error -> {
                    Column(
                        modifier = Modifier.align(Alignment.Center),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Text(state.message, style = MaterialTheme.typography.bodyMedium)
                        OutlinedButton(onClick = viewModel::refresh) { Text("重试") }
                        // 连接层面的错（token 失效 / 地址变了）重试是没用的，给一条明确的出路
                        OutlinedButton(onClick = onReconnect) { Text("重新连接") }
                    }
                }
                is SessionListUiState.Content -> {
                    if (state.model.rootSessions.isEmpty() && state.model.subGroups.isEmpty()) {
                        Column(
                            modifier = Modifier.align(Alignment.Center),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            Text("还没有会话", style = MaterialTheme.typography.bodyMedium)
                            OutlinedButton(onClick = { showNewSession = true }) { Text("新建会话") }
                        }
                    } else {
                        SessionGroupedList(
                            model = state.model,
                            bottomOverlayPadding = bottomOverlayPadding,
                            onOpenSession = onOpenSession,
                            onRename = { session ->
                                viewModel.clearRenameError()
                                renameTitle = session.title.orEmpty()
                                pendingRename = session
                            },
                            onDelete = { pendingDelete = it },
                        )
                    }
                }
            }
        }
    }

    pendingRename?.let { session ->
        val focusRequester = remember(session.id) { FocusRequester() }
        AlertDialog(
            onDismissRequest = { if (!renameSubmitting) pendingRename = null },
            title = { Text("重命名会话") },
            text = {
                OutlinedTextField(
                    value = renameTitle,
                    onValueChange = {
                        renameTitle = it
                        viewModel.clearRenameError()
                    },
                    modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
                    label = { Text("会话名称") },
                    singleLine = true,
                    enabled = !renameSubmitting,
                    isError = renameError != null,
                    supportingText = { renameError?.let { Text(it) } },
                )
                LaunchedEffect(session.id) { focusRequester.requestFocus() }
            },
            confirmButton = {
                TextButton(
                    enabled = renameTitle.isNotBlank() && !renameSubmitting,
                    onClick = {
                        viewModel.rename(session.id, renameTitle) { pendingRename = null }
                    },
                ) { Text(if (renameSubmitting) "保存中…" else "保存") }
            },
            dismissButton = {
                TextButton(enabled = !renameSubmitting, onClick = { pendingRename = null }) { Text("取消") }
            },
        )
    }

    pendingDelete?.let { session ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("删除会话") },
            text = { Text("确定删除「${session.title ?: "未命名会话"}」吗？此操作不可恢复。") },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.delete(session.id)
                    pendingDelete = null
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("取消") }
            },
        )
    }

    if (showNewSession) {
        NewSessionSheet(
            onDismiss = { showNewSession = false },
            onCreate = { config ->
                PendingNewSession.set(
                    claudeSessionId = config.claudeSessionId,
                    runtime = config.runtime,
                    workspaceId = config.workspaceId,
                    permissionMode = config.permissionMode,
                )
                showNewSession = false
                onNewSession()
            },
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionGroupedList(
    model: SessionListModel,
    bottomOverlayPadding: Dp,
    onOpenSession: (String) -> Unit,
    onRename: (SessionDto) -> Unit,
    onDelete: (SessionDto) -> Unit,
) {
    val collapsed = remember { mutableStateMapOf<String, Boolean>() }
    // 「更早」默认折叠，展开状态和子目录分组一样只活在本次 composition 里（见 docs）。
    var olderCollapsed by remember { mutableStateOf(true) }
    val listState = rememberLazyListState()
    var revealedId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(listState.isScrollInProgress) {
        if (listState.isScrollInProgress) revealedId = null
    }
    val reveal: (String?) -> Unit = { revealedId = it }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
            start = 16.dp,
            top = 16.dp,
            end = 16.dp,
            bottom = 16.dp + bottomOverlayPadding,
        ),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        sessionCards(model.rootSessions, revealedId, reveal, onOpenSession, onRename, onDelete)
        if (model.olderRootSessions.isNotEmpty()) {
            stickyHeader(key = "older") {
                CollapsibleHeader(
                    label = "更早",
                    count = model.olderRootSessions.size,
                    collapsed = olderCollapsed,
                    onToggle = { olderCollapsed = !olderCollapsed },
                    icon = Icons.Rounded.History,
                    labelStyle = MaterialTheme.typography.labelLarge,
                )
            }
            if (!olderCollapsed) {
                sessionCards(model.olderRootSessions, revealedId, reveal, onOpenSession, onRename, onDelete)
            }
        }
        model.subGroups.forEach { group ->
            val isCollapsed = collapsed[group.cwd] ?: true
            stickyHeader(key = "cwd-${group.cwd}") {
                CollapsibleHeader(
                    label = group.displayName,
                    count = group.sessions.size,
                    collapsed = isCollapsed,
                    onToggle = { collapsed[group.cwd] = !isCollapsed },
                    icon = Icons.Rounded.Folder,
                    // 目录名是路径，用等宽；「更早」不是路径，所以样式由调用方给。
                    labelStyle = CodeBody.copy(color = MaterialTheme.colorScheme.onSurfaceVariant),
                )
            }
            if (!isCollapsed) {
                sessionCards(group.sessions, revealedId, reveal, onOpenSession, onRename, onDelete)
            }
        }
    }
}

/** 一段会话卡片。三个地方（根目录近期 / 更早 / 各子目录组）共用，避免同一坨复制三遍。 */
private fun LazyListScope.sessionCards(
    sessions: List<SessionDto>,
    revealedId: String?,
    onReveal: (String?) -> Unit,
    onOpenSession: (String) -> Unit,
    onRename: (SessionDto) -> Unit,
    onDelete: (SessionDto) -> Unit,
) {
    items(sessions, key = { it.id }) { session ->
        SessionCard(
            session = session,
            revealed = revealedId == session.id,
            onRevealChange = { revealed -> onReveal(if (revealed) session.id else null) },
            onClick = { if (revealedId != null) onReveal(null) else onOpenSession(session.id) },
            onRename = {
                onReveal(null)
                onRename(session)
            },
            onDelete = {
                onReveal(null)
                onDelete(session)
            },
        )
    }
}

/**
 * 可折叠的段头。子目录分组与「更早」共用一套外观（图标 + 文案 + 条数徽章 + 箭头），
 * 只有图标与文案样式不同。吸顶时要盖住下面的内容，所以自带不透明背景。
 */
@Composable
private fun CollapsibleHeader(
    label: String,
    count: Int,
    collapsed: Boolean,
    onToggle: () -> Unit,
    icon: ImageVector,
    labelStyle: TextStyle,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .clickable(onClick = onToggle)
            .padding(top = 12.dp, bottom = 4.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(15.dp),
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = label,
            style = labelStyle,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = "$count",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .background(MaterialTheme.colorScheme.surfaceVariant, CircleShape)
                .padding(horizontal = 8.dp, vertical = 2.dp),
        )
        Spacer(modifier = Modifier.width(6.dp))
        Icon(
            imageVector = if (collapsed) Icons.Rounded.ExpandMore else Icons.Rounded.ExpandLess,
            contentDescription = if (collapsed) "展开" else "收起",
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
private fun SessionCard(
    session: SessionDto,
    revealed: Boolean,
    onRevealChange: (Boolean) -> Unit,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    val border = if (session.running) {
        BorderStroke(1.dp, MaterialTheme.colorScheme.primary)
    } else {
        BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)
    }

    SwipeSessionCard(revealed, onRevealChange, onRename, onDelete) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick),
            border = border,
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (session.running) {
                        RunningIndicator()
                        Spacer(modifier = Modifier.width(8.dp))
                    }
                    Text(
                        text = session.title ?: "未命名会话",
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = relativeTime(session.lastActiveAt),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                AgentBadge(runtimeId = session.runtime)
            }
        }
    }
}

/** Swipe reveals actions; releasing the card never deletes or renames it. */
@Composable
private fun SwipeSessionCard(
    revealed: Boolean,
    onRevealChange: (Boolean) -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
    content: @Composable () -> Unit,
) {
    val actionWidth = 80.dp
    val actionPx = with(LocalDensity.current) { (actionWidth * 2).toPx() }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var dragging by remember { mutableStateOf(false) }
    var settle by remember { mutableIntStateOf(0) }

    LaunchedEffect(revealed, settle, actionPx, dragging) {
        if (!dragging) {
            animate(offsetX, if (revealed) -actionPx else 0f, animationSpec = tween(180)) { value, _ ->
                offsetX = value
            }
        }
    }

    Box(modifier = Modifier.clip(RoundedCornerShape(12.dp))) {
        if (offsetX < 0f) {
            Row(
                modifier = Modifier.matchParentSize(),
                horizontalArrangement = Arrangement.End,
            ) {
                Box(
                    modifier = Modifier.width(actionWidth).fillMaxHeight()
                        .background(MaterialTheme.colorScheme.primary)
                        .clickable(onClick = onRename),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("重命名", color = MaterialTheme.colorScheme.onPrimary)
                }
                Box(
                    modifier = Modifier.width(actionWidth).fillMaxHeight()
                        .background(MaterialTheme.colorScheme.error)
                        .clickable(onClick = onDelete),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("删除", color = MaterialTheme.colorScheme.onError)
                }
            }
        }
        Box(
            modifier = Modifier.offset { IntOffset(offsetX.roundToInt(), 0) }
                .draggable(
                    orientation = Orientation.Horizontal,
                    state = rememberDraggableState { delta ->
                        offsetX = (offsetX + delta).coerceIn(-actionPx, 0f)
                    },
                    onDragStarted = { dragging = true },
                    onDragStopped = { velocity ->
                        val open = when {
                            velocity < -800f -> true
                            velocity > 800f -> false
                            else -> offsetX < -actionPx / 2f
                        }
                        onRevealChange(open)
                        dragging = false
                        settle += 1
                    },
                ),
        ) { content() }
    }
}
