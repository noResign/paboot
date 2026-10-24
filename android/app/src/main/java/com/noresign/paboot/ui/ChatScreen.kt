package com.noresign.paboot.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import com.noresign.paboot.ui.identity.permissionModeOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.noresign.paboot.ui.theme.LocalSemanticColors
import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.notify.NotificationPermission
import com.noresign.paboot.notify.RunNotifications
import com.noresign.paboot.notify.ChatVisibility
import com.noresign.paboot.viewmodel.SessionPermissionsUiState
import com.noresign.paboot.ui.chat.InputBar
import com.noresign.paboot.ui.chat.MessageList
import com.noresign.paboot.ui.chat.PermissionDialog
import com.noresign.paboot.ui.chat.TodoListPanel
import com.noresign.paboot.ui.chat.toolLabel
import com.noresign.paboot.model.chat.ContextUsage
import com.noresign.paboot.ui.component.ContextRing
import com.noresign.paboot.util.formatTokens
import com.noresign.paboot.viewmodel.ChatViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    sessionId: String?,
    onBack: () -> Unit,
    onReconnect: () -> Unit,
    onManageWorkspaces: () -> Unit,
    onOpenSession: (String) -> Unit,
    viewModel: ChatViewModel = viewModel(),
) {
    val messages by viewModel.messages.collectAsState()
    val streaming by viewModel.streaming.collectAsState()
    val historyLoading by viewModel.historyLoading.collectAsState()
    val permission by viewModel.permission.collectAsState()
    val error by viewModel.error.collectAsState()
    val title by viewModel.sessionTitle.collectAsState()
    val cwd by viewModel.sessionCwd.collectAsState()
    val runtime by viewModel.sessionRuntime.collectAsState()
    val contextUsage by viewModel.contextUsage.collectAsState()
    val permissionSubmitting by viewModel.permissionSubmitting.collectAsState()
    val permissionInputError by viewModel.permissionInputError.collectAsState()
    val todos by viewModel.todos.collectAsState()
    val sessionPermissions by viewModel.sessionPermissions.collectAsState()
    val sessionPermissionMode by viewModel.sessionPermissionMode.collectAsState()
    val reconnecting by viewModel.reconnecting.collectAsState()
    val activeSessionId by viewModel.activeSessionId.collectAsState()
    val sessionModel by viewModel.sessionModel.collectAsState()
    val sessionModelParameters by viewModel.sessionModelParameters.collectAsState()
    val models by viewModel.models.collectAsState()
    val modelsLoading by viewModel.modelsLoading.collectAsState()
    val modelsError by viewModel.modelsError.collectAsState()
    val currentSessionId = activeSessionId ?: sessionId

    val snackbarHostState = remember { SnackbarHostState() }
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    var input by rememberSaveable { mutableStateOf("") }
    var selectedTab by rememberSaveable { mutableStateOf(MainTab.Sessions) }
    var composerVisible by rememberSaveable { mutableStateOf(true) }
    var showSessionTasks by remember { mutableStateOf(false) }
    // Hoisted so switching Files/Tasks/Settings and back does not reset the
    // transcript scroll and flash the first message before re-attaching to the bottom.
    val messageListState = rememberLazyListState()
    val tabStateHolder = rememberSaveableStateHolder()
    var todoExpanded by remember { mutableStateOf(false) }
    var showModels by remember { mutableStateOf(false) }
    var showSessionMenu by remember { mutableStateOf(false) }

    // The model label is shown in the session menu, beside the permission settings.
    val selectedModelOption = models.find { it.id == sessionModel }
    val explicitParameterLabel = selectedModelOption?.parameters?.firstNotNullOfOrNull { parameter ->
        sessionModelParameters[parameter.id]?.let { valueId ->
            parameter.values.find { it.id == valueId }?.label ?: valueId
        }
    }
    val modelDisplayLabel = listOfNotNull(
        sessionModel?.let { id -> selectedModelOption?.label?.ifBlank { id } ?: id } ?: "默认",
        explicitParameterLabel,
    ).joinToString(" · ")

    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { }

    LaunchedEffect(sessionId) {
        // 人已经进来了，这条会话的旧提醒就没用了
        sessionId?.let { RunNotifications.clear(context, it) }
        viewModel.load(sessionId)
    }
    // The view model remains alive while browsing files or settings, but the conversation
    // is no longer visible and must not suppress run notifications.
    LaunchedEffect(selectedTab, activeSessionId) {
        if (selectedTab == MainTab.Sessions) ChatVisibility.enter(activeSessionId)
        else ChatVisibility.exit(activeSessionId)
    }
    // 任务真的跑起来了才要通知权限：此刻用途最明确，也最不像「一进来就要权限」
    LaunchedEffect(streaming) {
        if (!streaming || SettingsStore.notificationPromptShown) return@LaunchedEffect
        if (NotificationPermission.isGranted(context)) return@LaunchedEffect
        val permission = NotificationPermission.requiredPermission ?: return@LaunchedEffect
        SettingsStore.notificationPromptShown = true
        notificationPermissionLauncher.launch(permission)
    }
    LaunchedEffect(error) {
        error?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.consumeError()
        }
    }

    BackHandler(enabled = selectedTab != MainTab.Sessions) {
        selectedTab = MainTab.Sessions
    }

    if (selectedTab == MainTab.Sessions) Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(title ?: "新会话", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (runtime != null || cwd != null) {
                            Text(
                                text = listOfNotNull(runtime, cwd).joinToString(" · "),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    contextUsage?.let { ContextIndicator(it) }
                    Box {
                        IconButton(onClick = { showSessionMenu = true }) {
                            Icon(Icons.Rounded.Tune, contentDescription = "会话设置")
                        }
                        DropdownMenu(
                            expanded = showSessionMenu,
                            onDismissRequest = { showSessionMenu = false },
                        ) {
                            Text(
                                "权限模式",
                                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            permissionModeOptions(runtime).forEach { (mode, _) ->
                                val label = when (mode) {
                                    "ask" -> "询问"
                                    "acceptEdits" -> "自动接受编辑"
                                    "bypass" -> "绕过审批"
                                    else -> mode
                                }
                                DropdownMenuItem(
                                    text = { Text(label) },
                                    trailingIcon = {
                                        if (sessionPermissionMode == mode) {
                                            Icon(Icons.Rounded.Check, contentDescription = "当前权限模式")
                                        }
                                    },
                                    onClick = {
                                        showSessionMenu = false
                                        viewModel.updateSessionPermissionMode(mode)
                                    },
                                )
                            }
                            HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text("模型：$modelDisplayLabel") },
                                onClick = {
                                    showSessionMenu = false
                                    viewModel.loadModels()
                                    showModels = true
                                },
                            )
                            HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text("定时任务") },
                                enabled = currentSessionId != null,
                                onClick = {
                                    showSessionMenu = false
                                    showSessionTasks = true
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("权限设置") },
                                enabled = activeSessionId != null,
                                onClick = {
                                    showSessionMenu = false
                                    viewModel.openSessionPermissions()
                                },
                            )
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            Column {
                if (todos.isNotEmpty()) {
                    TodoListPanel(
                        todos = todos,
                        running = streaming,
                        expanded = todoExpanded,
                        onToggle = { todoExpanded = !todoExpanded },
                    )
                }
                if (reconnecting) {
                    ReconnectBanner()
                }
                FloatingBottomBar(
                    selected = MainTab.Sessions,
                    onSelect = { tab ->
                        focusManager.clearFocus()
                        keyboardController?.hide()
                        if (tab == MainTab.Sessions) onBack() else selectedTab = tab
                    },
                    composerVisible = composerVisible,
                    onToggle = {
                        if (composerVisible) {
                            focusManager.clearFocus()
                            keyboardController?.hide()
                        }
                        composerVisible = !composerVisible
                    },
                    composer = {
                        InputBar(
                            input = input,
                            streaming = streaming,
                            onInputChange = { input = it },
                            onSend = {
                                viewModel.send(input)
                                input = ""
                            },
                            onStop = viewModel::stop,
                        )
                    },
                )
            }
        },
    ) { innerPadding ->
        MessageList(
            messages = messages,
            streaming = streaming,
            loading = historyLoading,
            onAnswer = viewModel::answerQuestion,
            bottomOverlayPadding = innerPadding.calculateBottomPadding(),
            listState = messageListState,
            modifier = Modifier
                .fillMaxSize()
                .padding(top = innerPadding.calculateTopPadding())
                .consumeWindowInsets(innerPadding)
                .clipToBounds()
                .pointerInput(Unit) {
                    detectTapGestures(onTap = {
                        focusManager.clearFocus()
                        keyboardController?.hide()
                    })
                },
        )
    } else Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            FloatingBottomBar(
                selected = selectedTab,
                onSelect = { selectedTab = it },
            )
        },
    ) { innerPadding ->
        Box(
            Modifier.fillMaxSize()
                .padding(top = innerPadding.calculateTopPadding())
                .consumeWindowInsets(innerPadding)
        ) {
            tabStateHolder.SaveableStateProvider(selectedTab.name) {
                when (selectedTab) {
                    MainTab.Files -> FilesScreen(bottomOverlayPadding = innerPadding.calculateBottomPadding())
                    MainTab.Tasks -> TasksScreen(
                        onOpenSession = onOpenSession,
                        bottomOverlayPadding = innerPadding.calculateBottomPadding(),
                    )
                    MainTab.Settings -> SettingsScreen(
                        onReconnect,
                        onManageWorkspaces,
                        bottomOverlayPadding = innerPadding.calculateBottomPadding(),
                    )
                    MainTab.Sessions -> Unit
                }
            }
        }
    }

    permission?.let { req ->
        PermissionDialog(
            permission = req,
            runtime = runtime,
            submitting = permissionSubmitting,
            inputError = permissionInputError,
            onDecide = viewModel::decidePermission,
        )
    }

    sessionPermissions?.let { state ->
        ModalBottomSheet(onDismissRequest = viewModel::closeSessionPermissions) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
            ) {
                Text("会话权限", style = MaterialTheme.typography.titleLarge)
                Spacer(modifier = Modifier.height(12.dp))
                when (state) {
                    is SessionPermissionsUiState.Loading -> CircularProgressIndicator()
                    is SessionPermissionsUiState.Error -> {
                        Text(state.message, color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = viewModel::closeSessionPermissions) { Text("关闭") }
                    }
                    is SessionPermissionsUiState.Ready -> {
                        permissionModeOptions(runtime).forEach { (mode, desc) ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { viewModel.updateSessionPermissionMode(mode) }
                                    .padding(vertical = 6.dp),
                                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                            ) {
                                RadioButton(
                                    selected = state.mode == mode,
                                    onClick = { viewModel.updateSessionPermissionMode(mode) },
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(mode, style = MaterialTheme.typography.bodyMedium)
                                    Text(
                                        desc,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                        Spacer(modifier = Modifier.height(16.dp))
                        Text("已授权工具", style = MaterialTheme.typography.titleSmall)
                        if (state.grants.isEmpty()) {
                            Text(
                                "暂无",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            state.grants.forEach { grant ->
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 4.dp),
                                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                                ) {
                                    Text(toolLabel(grant.toolName), modifier = Modifier.weight(1f))
                                    TextButton(onClick = { viewModel.revokePermissionGrant(grant.toolName) }) {
                                        Text("撤销")
                                    }
                                }
                            }
                            TextButton(onClick = viewModel::revokeAllPermissionGrants) { Text("全部撤销") }
                        }
                        Text(
                            "权限模式只对后续 Run 生效。撤销授权会重新询问后续请求，但不会撤回已批准的操作；Codex 权限扩展可持续到当前轮结束，需要立即收回时请停止运行。",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }

    if (showModels) {
        ModalBottomSheet(onDismissRequest = { showModels = false }) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
            ) {
                Text("模型", style = MaterialTheme.typography.titleLarge)
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    "切换后从下一轮开始生效；正在运行的任务不受影响。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.height(12.dp))

                if (modelsLoading && models.isEmpty()) {
                    CircularProgressIndicator()
                } else {
                    modelsError?.let { message ->
                        Text(
                            message,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                        TextButton(onClick = { viewModel.loadModels() }) { Text("重试") }
                    }
                    val options = buildList<Pair<String?, String>> {
                        add(null to "默认（沿用电脑端配置）")
                        models.forEach { add(it.id to it.label.ifBlank { it.id }) }
                    }
                    options.forEach { (value, label) ->
                        SelectionRadioRow(
                            label = label,
                            description = value,
                            selected = sessionModel == value,
                            onClick = { viewModel.selectSessionModel(value) },
                        )
                    }

                    // 目录里声明的参数（例如推理强度）。没有声明就不显示。
                    val selectedModel = models.find { it.id == sessionModel }
                    selectedModel?.parameters?.forEach { parameter ->
                        Spacer(modifier = Modifier.height(16.dp))
                        Text(
                            parameterLabel(parameter.id, parameter.label),
                            style = MaterialTheme.typography.labelLarge,
                        )
                        val current = sessionModelParameters[parameter.id]
                        val parameterOptions = buildList<Pair<String?, String>> {
                            add(null to "默认")
                            parameter.values.forEach { add(it.id to it.label.ifBlank { it.id }) }
                        }
                        parameterOptions.forEach { (value, label) ->
                            SelectionRadioRow(
                                label = label,
                                description = value,
                                selected = current == value,
                                onClick = { viewModel.selectSessionParameter(parameter.id, value) },
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(8.dp))
                    TextButton(onClick = { showModels = false }) { Text("完成") }
                }
            }
        }
    }

    if (showSessionTasks && currentSessionId != null) {
        SessionTasksSheet(
            sessionId = currentSessionId,
            onDismiss = { showSessionTasks = false },
            onManage = {
                showSessionTasks = false
                selectedTab = MainTab.Tasks
            },
        )
    }
}

@Composable
private fun SelectionRadioRow(
    label: String,
    description: String?,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Spacer(modifier = Modifier.width(8.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            if (description != null) {
                Text(
                    description,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** 已知参数 id 的中文名；新参数沿用 daemon 给的 fallback label。 */
private fun parameterLabel(id: String, fallback: String): String = when (id) {
    "reasoningEffort" -> "推理强度"
    else -> fallback.ifBlank { id }
}

/**
 * 断线重连中的提示条（设计规范 §7.5 的 `reconnecting` 态：琥珀转圈 + 文案）。
 * run 仍在电脑上跑，所以这里不打断阅读、也不清空消息，只提示"正在续上"。
 */
@Composable
private fun ReconnectBanner() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(14.dp),
            strokeWidth = 2.dp,
            color = LocalSemanticColors.current.warning,
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = "连接断开，正在重连…",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * 顶栏的上下文占用指示（docs/ui/mobile/pages/chat.md §6.3）：平时只占一个圆环，把宽度留给 cwd，
 * 点开才显示具体数值与百分比。
 *
 * 运行时不给窗口大小（Claude）时画不出比例，改用等宽小字显示占用量——一个空圆环会被读成
 * 「0%」，比不画还糟。
 */
@Composable
private fun ContextIndicator(usage: ContextUsage) {
    var expanded by remember { mutableStateOf(false) }
    // percent 是算出来的（自定义 getter），取一次复用，别每处再算一遍。
    val percent = usage.percent
    Box {
        IconButton(
            onClick = { expanded = true },
            modifier = Modifier.semantics { contentDescription = "上下文占用 ${usage.display}" },
        ) {
            if (percent != null) {
                ContextRing(percent = percent)
            } else {
                Text(
                    text = formatTokens(usage.tokens),
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text("上下文 ${usage.display}") },
                onClick = { expanded = false },
            )
        }
    }
}
