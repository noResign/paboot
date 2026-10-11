package com.noresign.paboot.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    sessionId: String?,
    onBack: () -> Unit,
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
    val reconnecting by viewModel.reconnecting.collectAsState()

    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    var input by remember { mutableStateOf("") }
    var todoExpanded by remember { mutableStateOf(false) }

    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { }

    LaunchedEffect(sessionId) {
        // 人已经进来了，这条会话的旧提醒就没用了
        sessionId?.let { RunNotifications.clear(context, it) }
        viewModel.load(sessionId)
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

    Scaffold(
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
                    TextButton(onClick = viewModel::openSessionPermissions) { Text("权限") }
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
                InputBar(
                    input = input,
                    streaming = streaming,
                    onInputChange = { input = it },
                    onSend = {
                        viewModel.send(input)
                        input = ""
                    },
                    onStop = viewModel::stop,
                    onMic = { scope.launch { snackbarHostState.showSnackbar("语音输入即将上线") } },
                )
            }
        },
    ) { innerPadding ->
        MessageList(
            messages = messages,
            streaming = streaming,
            loading = historyLoading,
            onAnswer = viewModel::answerQuestion,
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .pointerInput(Unit) {
                    detectTapGestures(onTap = {
                        focusManager.clearFocus()
                        keyboardController?.hide()
                    })
                },
        )
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
