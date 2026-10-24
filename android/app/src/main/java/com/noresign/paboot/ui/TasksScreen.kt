package com.noresign.paboot.ui

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import com.noresign.paboot.data.WorkspaceSelection
import com.noresign.paboot.model.task.TaskDraft
import com.noresign.paboot.network.daemon.dto.RunDto
import com.noresign.paboot.network.daemon.dto.ScheduledTaskDetailResponse
import com.noresign.paboot.network.daemon.dto.ScheduledTaskDto
import com.noresign.paboot.ui.component.PullToRefreshContainer
import com.noresign.paboot.util.relativeTime
import com.noresign.paboot.viewmodel.ScheduledTasksViewModel
import com.noresign.paboot.viewmodel.SessionTasksViewModel
import com.noresign.paboot.viewmodel.TasksUiState

private val WEEKDAYS = listOf("日", "一", "二", "三", "四", "五", "六")
private val PRESETS = linkedMapOf(
    "daily" to "每天",
    "weekdays" to "工作日",
    "weekly" to "每周指定日",
    "every_minutes" to "每 N 分钟",
    "every_hours" to "每 N 小时",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(
    onOpenSession: (String) -> Unit,
    bottomOverlayPadding: Dp = 0.dp,
    viewModel: ScheduledTasksViewModel = viewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val detail by viewModel.detail.collectAsState()
    val message by viewModel.message.collectAsState()
    val refreshing by viewModel.refreshing.collectAsState()
    val submitting by viewModel.submitting.collectAsState()
    val startingConfig by viewModel.startingConfig.collectAsState()
    val editorError by viewModel.editorError.collectAsState()
    val workspacePath by WorkspaceSelection.selectedPath.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var editingTask by remember { mutableStateOf<ScheduledTaskDto?>(null) }
    var confirmConfig by remember { mutableStateOf(false) }

    LifecycleResumeEffect(Unit) {
        viewModel.refreshSilently()
        onPauseOrDispose { }
    }
    // The tab's ViewModel outlives this composable, so `init`/resume do not rerun
    // when the user switches back from another tab. Refresh on every re-entry so
    // deletions made elsewhere (e.g. deleting a bound session) disappear immediately.
    LaunchedEffect(Unit) {
        viewModel.refreshSilently()
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
                        Text("任务")
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
                onClick = { confirmConfig = true },
                modifier = Modifier.padding(bottom = bottomOverlayPadding),
            ) {
                if (startingConfig) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Rounded.Add, contentDescription = "AI 新建定时任务")
                }
            }
        },
    ) { innerPadding ->
        PullToRefreshContainer(
            isRefreshing = refreshing,
            onRefresh = viewModel::pullRefresh,
            modifier = Modifier.fillMaxSize().padding(innerPadding),
        ) {
            when (val state = uiState) {
                is TasksUiState.Loading -> {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                }
                is TasksUiState.Error -> {
                    Column(
                        modifier = Modifier.align(Alignment.Center),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Text(state.message, style = MaterialTheme.typography.bodyMedium)
                        OutlinedButton(onClick = viewModel::refresh) { Text("重试") }
                    }
                }
                is TasksUiState.Content -> {
                    if (state.tasks.isEmpty()) {
                        Column(
                            modifier = Modifier.align(Alignment.Center),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text("还没有定时任务", style = MaterialTheme.typography.titleMedium)
                            Text(
                                "按计划自动唤醒会话，或在工作区里执行命令。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                                start = 16.dp,
                                end = 16.dp,
                                top = 12.dp,
                                bottom = bottomOverlayPadding + 88.dp,
                            ),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            items(state.tasks, key = { it.id }) { task ->
                                TaskCard(
                                    task = task,
                                    onOpen = { viewModel.openDetail(task.id) },
                                    onToggle = { viewModel.toggle(task) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (confirmConfig) {
        AlertDialog(
            onDismissRequest = { confirmConfig = false },
            title = { Text("用 AI 配置定时任务") },
            text = {
                Text(
                    "将打开「配置定时任务」会话。AI 会先问你想要完成什么任务，分析后给出名称、目标、" +
                        "计划和执行内容，确认后才会创建。",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmConfig = false
                    viewModel.startConfigSession(onOpenSession)
                }) { Text("开始配置") }
            },
            dismissButton = {
                TextButton(onClick = { confirmConfig = false }) { Text("取消") }
            },
        )
    }

    editingTask?.let { task ->
        TaskEditorSheet(
            task = task,
            submitting = submitting,
            error = editorError,
            onDismiss = {
                editingTask = null
                viewModel.clearEditorError()
            },
            onSave = { draft, scheduleEditable ->
                viewModel.updateTask(task, draft, scheduleEditable) { editingTask = null }
            },
        )
    }

    detail?.let {
        TaskDetailSheet(
            detail = it,
            onDismiss = viewModel::closeDetail,
            onRun = { viewModel.runNow(it.task) },
            onToggle = { viewModel.toggle(it.task) },
            onDelete = { viewModel.delete(it.task) },
            onEdit = {
                editingTask = it.task
                viewModel.closeDetail()
            },
        )
    }
}

@Composable
private fun TaskCard(task: ScheduledTaskDto, onOpen: () -> Unit, onToggle: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onOpen)
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    task.name,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    statusText(task),
                    style = MaterialTheme.typography.labelSmall,
                    color = statusColor(task),
                )
                Spacer(modifier = Modifier.width(2.dp))
                Switch(
                    checked = task.enabled,
                    onCheckedChange = { onToggle() },
                    modifier = Modifier.scale(0.7f))
            }
            Text(
                "${task.schedule.label} · 下次 ${task.nextRunAt?.let(::relativeTime) ?: "—"}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                targetText(task) + if (task.createdBy == "mcp") " · AI 创建" else "",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TaskDetailSheet(
    detail: ScheduledTaskDetailResponse,
    onDismiss: () -> Unit,
    onRun: () -> Unit,
    onToggle: () -> Unit,
    onDelete: () -> Unit,
    onEdit: () -> Unit,
) {
    val task = detail.task
    var confirmDelete by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(task.name, style = MaterialTheme.typography.titleLarge)
                    Text(
                        "${task.schedule.label} · ${targetText(task)} · 完全权限" +
                            if (task.createdBy == "mcp") " · AI 创建" else "",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        "下次 ${task.nextRunAt?.let(::relativeTime) ?: "—"} · 上次 ${task.lastRunAt?.let(::relativeTime) ?: "—"} · 已执行 ${task.runCount} 次",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (!task.enabled) {
                item {
                    Text(
                        "已停用${task.disabledReason?.let { "：$it" } ?: ""}",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            task.lastError?.let { error ->
                item {
                    Text(
                        "最近错误：$error",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = onRun) { Text("立即运行") }
                        OutlinedButton(onClick = onToggle) { Text(if (task.enabled) "停用" else "启用") }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = onEdit) { Text("编辑") }
                        OutlinedButton(onClick = { confirmDelete = true }) { Text("删除") }
                    }
                }
            }
            item {
                Text(
                    if (task.type == "command") task.command.orEmpty() else task.prompt.orEmpty(),
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                )
            }
            item { HorizontalDivider() }
            item { Text("执行历史", style = MaterialTheme.typography.titleSmall) }
            if (detail.runs.isEmpty()) {
                item {
                    Text(
                        "还没有执行记录",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            items(detail.runs, key = { it.id }) { run -> RunRow(run) }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("删除定时任务") },
            text = { Text("确定删除「${task.name}」？") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    onDelete()
                }) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun RunRow(run: RunDto) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                relativeTime(run.startedAt),
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
            Text(
                run.status,
                style = MaterialTheme.typography.labelSmall,
                color = if (run.status == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                when (run.trigger) {
                    "scheduled" -> "定时"
                    "run_now" -> "手动"
                    else -> "交互"
                },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        run.output?.takeIf { it.isNotBlank() }?.let { output ->
            Text(
                output,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 8,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TaskEditorSheet(
    task: ScheduledTaskDto,
    submitting: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSave: (TaskDraft, Boolean) -> Unit,
) {
    val presetDto = task.schedule.preset
    // Tasks created through the preset UI always carry preset metadata. A
    // raw-cron task (API-created) keeps its schedule untouched here.
    val scheduleEditable = presetDto != null
    var name by remember { mutableStateOf(task.name) }
    var prompt by remember { mutableStateOf(task.prompt.orEmpty()) }
    var command by remember { mutableStateOf(task.command.orEmpty()) }
    var preset by remember { mutableStateOf(presetDto?.preset ?: "daily") }
    var time by remember { mutableStateOf(presetDto?.time ?: "09:00") }
    var days by remember { mutableStateOf(presetDto?.days ?: listOf(1)) }
    var every by remember { mutableStateOf((presetDto?.every ?: 6).toString()) }
    var localError by remember { mutableStateOf<String?>(null) }
    var presetMenu by remember { mutableStateOf(false) }
    // Hoisted so adding/removing conditional fields (time / days / interval) does
    // not reset the scroll position while the user is editing lower fields.
    val listState = rememberLazyListState()

    fun submit() {
        val trimmed = name.trim()
        localError = when {
            trimmed.isEmpty() -> "请填写任务名称"
            task.type == "ai" && prompt.isBlank() -> "请填写 prompt"
            task.type == "command" && command.isBlank() -> "请填写命令"
            scheduleEditable && preset == "weekly" && days.isEmpty() -> "请至少选择一个星期"
            else -> null
        }
        if (localError != null) return
        onSave(
            TaskDraft(
                name = trimmed,
                type = task.type,
                prompt = prompt.trim(),
                command = command.trim(),
                targetMode = "existing",
                sessionId = task.sessionId,
                runtime = task.runtime,
                preset = preset,
                time = time,
                days = days,
                every = every.toIntOrNull() ?: 6,
            ),
            scheduleEditable,
        )
    }

    val target = when {
        task.type == "command" -> "当前工作区"
        task.sessionTitle != null -> "会话：${task.sessionTitle}"
        task.sessionMode == "new" -> "首次触发时新建会话"
        else -> task.sessionId ?: "未知"
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item(key = "title") { Text("编辑定时任务", style = MaterialTheme.typography.titleLarge) }
            item(key = "meta") {
                Text(
                    "${if (task.type == "command") "命令任务" else "AI 会话任务"} · 目标：$target · 完全权限",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item(key = "name") {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("名称") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
            }
            if (task.type == "command") {
                item(key = "command") {
                    OutlinedTextField(
                        value = command,
                        onValueChange = { command = it },
                        label = { Text("命令（工作区根目录执行）") },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 3,
                    )
                }
            } else {
                item(key = "prompt") {
                    OutlinedTextField(
                        value = prompt,
                        onValueChange = { prompt = it },
                        label = { Text("Prompt") },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 4,
                    )
                }
            }
            if (scheduleEditable) {
                item(key = "preset") {
                    Box {
                        OutlinedButton(onClick = { presetMenu = true }) {
                            Text(PRESETS[preset] ?: preset)
                        }
                        DropdownMenu(expanded = presetMenu, onDismissRequest = { presetMenu = false }) {
                            PRESETS.forEach { (value, label) ->
                                DropdownMenuItem(
                                    text = { Text(label) },
                                    onClick = {
                                        preset = value
                                        presetMenu = false
                                    },
                                )
                            }
                        }
                    }
                }
                if (preset == "daily" || preset == "weekdays" || preset == "weekly") {
                    item(key = "time") {
                        OutlinedTextField(
                            value = time,
                            onValueChange = { time = it },
                            label = { Text("时间 (HH:MM)") },
                            singleLine = true,
                        )
                    }
                }
                if (preset == "weekly") {
                    item(key = "days") {
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            WEEKDAYS.forEachIndexed { index, label ->
                                FilterChip(
                                    selected = days.contains(index),
                                    onClick = {
                                        days = if (days.contains(index)) days - index else days + index
                                    },
                                    label = { Text(label) },
                                )
                            }
                        }
                    }
                }
                if (preset == "every_minutes" || preset == "every_hours") {
                    item(key = "every") {
                        OutlinedTextField(
                            value = every,
                            onValueChange = { every = it.filter(Char::isDigit) },
                            label = { Text(if (preset == "every_minutes") "每几分钟" else "每几小时") },
                            singleLine = true,
                        )
                    }
                }
            } else {
                item(key = "cron") {
                    Text(
                        "该任务使用自定义 cron（${task.schedule.cron}），当前只能编辑名称和内容。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            item(key = "note") {
                Text(
                    "修改从下一次触发开始生效；正在运行的 run 不受影响。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            (localError ?: error)?.let { message ->
                item(key = "error") {
                    Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
            item(key = "submit") {
                Button(
                    onClick = { submit() },
                    enabled = !submitting,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(if (submitting) "保存中…" else "保存") }
            }
        }
    }
}

/**
 * Read-only list of the tasks bound to one session, opened from the chat top bar.
 * Actions live in the Tasks tab; this sheet just answers "what is attached here".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionTasksSheet(
    sessionId: String,
    onDismiss: () -> Unit,
    onManage: () -> Unit,
    viewModel: SessionTasksViewModel = viewModel(),
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(sessionId) { viewModel.load(sessionId) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item(key = "title") {
                Text("本会话的定时任务", style = MaterialTheme.typography.titleLarge)
            }
            when {
                state.loading -> item(key = "loading") {
                    CircularProgressIndicator(modifier = Modifier.padding(vertical = 12.dp))
                }
                state.error != null -> item(key = "error") {
                    Text(
                        state.error.orEmpty(),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                state.tasks.isEmpty() -> item(key = "empty") {
                    Text(
                        "这个会话还没有定时任务。点「在任务页管理」可以新建。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                else -> items(state.tasks, key = { it.id }) { task ->
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                task.name,
                                style = MaterialTheme.typography.titleSmall,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                statusText(task),
                                style = MaterialTheme.typography.labelSmall,
                                color = statusColor(task),
                            )
                        }
                        Text(
                            "${task.schedule.label} · 下次 ${task.nextRunAt?.let(::relativeTime) ?: "—"}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            targetText(task),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    HorizontalDivider()
                }
            }
            item(key = "manage") {
                OutlinedButton(onClick = onManage, modifier = Modifier.fillMaxWidth()) {
                    Text("在任务页管理")
                }
            }
        }
    }
}

private fun statusText(task: ScheduledTaskDto): String {
    if (!task.enabled) return "已停用"
    return when (task.lastStatus) {
        "running" -> "运行中"
        "failed" -> "失败"
        "succeeded" -> "成功"
        "cancelled" -> "已取消"
        "interrupted" -> "已中断"
        "skipped_busy" -> "会话忙"
        "skipped_missed" -> "已错过"
        else -> "未运行"
    }
}

@Composable
private fun statusColor(task: ScheduledTaskDto) = when {
    !task.enabled -> MaterialTheme.colorScheme.onSurfaceVariant
    task.lastStatus == "failed" -> MaterialTheme.colorScheme.error
    task.lastStatus == "running" -> MaterialTheme.colorScheme.primary
    task.lastStatus == "succeeded" -> MaterialTheme.colorScheme.secondary
    task.lastStatus.startsWith("skipped") -> MaterialTheme.colorScheme.tertiary
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

private fun targetText(task: ScheduledTaskDto): String = when {
    task.type == "command" -> "执行命令"
    task.sessionTitle != null -> "会话：${task.sessionTitle}"
    else -> "首次触发时创建会话"
}
