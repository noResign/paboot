package com.noresign.paboot.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import com.noresign.paboot.ui.identity.permissionModeOptions
import com.noresign.paboot.util.maskAddress
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.noresign.paboot.BuildConfig
import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.data.update.AppUpdater
import com.noresign.paboot.notify.NotificationPermission
import com.noresign.paboot.notify.RunWatchCenter
import com.noresign.paboot.ui.update.UpdateHost
import com.noresign.paboot.viewmodel.DirectoryPickerUiState
import com.noresign.paboot.viewmodel.SettingsUiState
import com.noresign.paboot.viewmodel.SettingsViewModel
import com.noresign.paboot.viewmodel.UpdateUiState
import com.noresign.paboot.viewmodel.UpdateViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onReconnect: () -> Unit,
    onManageWorkspaces: () -> Unit,
    bottomOverlayPadding: Dp = 0.dp,
    viewModel: SettingsViewModel = viewModel(),
    updateViewModel: UpdateViewModel = viewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val updateState by updateViewModel.uiState.collectAsState()
    val selectedWorkspaceId by viewModel.selectedWorkspaceId.collectAsState()
    val permissionModeError by viewModel.permissionModeError.collectAsState()
    val baseUrl = SettingsStore.baseUrl ?: ""
    val token = SettingsStore.token ?: ""
    val daemonVersion = (uiState as? SettingsUiState.Ready)?.version

    val context = LocalContext.current
    var notificationsEnabled by remember { mutableStateOf(SettingsStore.backgroundNotifications) }
    var notificationsGranted by remember { mutableStateOf(NotificationPermission.isGranted(context)) }
    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { notificationsGranted = NotificationPermission.isGranted(context) }

    // 从系统通知设置页返回时刷新授权状态（用户在那边开关了通知）
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                notificationsGranted = NotificationPermission.isGranted(context)
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    fun applyNotifications(enabled: Boolean) {
        notificationsEnabled = enabled
        RunWatchCenter.setEnabled(context, enabled)
        if (!enabled || NotificationPermission.isGranted(context)) return
        val permission = NotificationPermission.requiredPermission
        if (permission != null && !SettingsStore.notificationPromptShown) {
            SettingsStore.notificationPromptShown = true
            notificationPermissionLauncher.launch(permission)
        } else {
            NotificationPermission.openSettings(context)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(title = { Text("设置") })
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, top = 20.dp, end = 20.dp, bottom = 20.dp + bottomOverlayPadding),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            SectionTitle("连接")
            val name = SettingsStore.name
            InfoRow(
                "名称",
                when {
                    !name.isNullOrBlank() -> maskAddress(name)
                    baseUrl.isBlank() -> "未配置"
                    else -> "未命名"
                },
            )
            InfoRow("服务器地址", maskAddress(baseUrl).ifBlank { "未配置" }, monospace = true)
            InfoRow("token", if (token.isBlank()) "未配置" else "••••••••")
            OutlinedButton(onClick = onReconnect, modifier = Modifier.fillMaxWidth()) {
                Text("重新连接")
            }

            when (val state = uiState) {
                is SettingsUiState.Loading -> CircularProgressIndicator()
                is SettingsUiState.Error -> {
                    Text(state.message, color = MaterialTheme.colorScheme.error)
                    OutlinedButton(onClick = viewModel::load) { Text("重试") }
                }
                is SettingsUiState.Ready -> {
                    SectionTitle("工作区")
                    val currentWorkspace = state.workspaces.find { it.id == selectedWorkspaceId }
                    InfoRow(
                        "当前工作区",
                        currentWorkspace?.path ?: "未选择",
                        monospace = true,
                    )
                    OutlinedButton(
                        onClick = onManageWorkspaces,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("管理工作区") }

                    SectionTitle("新会话默认权限")
                    permissionModeOptions(null).forEach { (mode, desc) ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { viewModel.setDefaultPermissionMode(mode) }
                                .padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = state.defaultPermissionMode == mode,
                                onClick = { viewModel.setDefaultPermissionMode(mode) },
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

                    permissionModeError?.let {
                        Text(
                            text = it,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }

                    SectionTitle("通知")
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .toggleable(
                                    value = notificationsEnabled && notificationsGranted,
                                    role = Role.Switch,
                                    onValueChange = { applyNotifications(it) },
                                ),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                "后台任务提醒",
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.weight(1f),
                            )
                            Spacer(modifier = Modifier.width(12.dp))
                            Switch(
                                checked = notificationsEnabled && notificationsGranted,
                                onCheckedChange = null,
                                modifier = Modifier.scale(0.7f),
                            )
                        }
                        Text(
                            "任务完成、失败或需要审批时，若你不在该会话页就弹系统通知",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (notificationsEnabled && !notificationsGranted) {
                            Text(
                                text = "系统通知未授权，点击前往设置开启",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { NotificationPermission.openSettings(context) }
                                    .padding(vertical = 8.dp),
                            )
                        }
                    }

                    // 没有配置更新通道（公开构建）时不显示入口
                    if (AppUpdater.enabled) {
                        SectionTitle("客户端更新")
                        val checking = updateState is UpdateUiState.Checking
                        OutlinedButton(
                            onClick = { updateViewModel.check() },
                            enabled = !checking,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            if (checking) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text("正在检查…")
                            } else {
                                Text("检查更新")
                            }
                        }
                    }
                }
            }

            SectionTitle("关于")
            InfoRow("App 版本", BuildConfig.VERSION_NAME)
            InfoRow("daemon 版本", daemonVersion ?: "未知")
        }
    }

    UpdateHost(
        state = updateState,
        onDownload = updateViewModel::download,
        onInstall = updateViewModel::install,
        onRetry = updateViewModel::retry,
        onDismiss = updateViewModel::dismiss,
    )
}

@Composable
internal fun DirectoryPickerDialog(
    state: DirectoryPickerUiState,
    onDismiss: () -> Unit,
    onBrowse: (String) -> Unit,
    onToggleHidden: () -> Unit,
    onSelect: () -> Unit,
    title: String = "选择工作区目录",
    selectLabel: String? = null,
    selectEnabled: Boolean? = null,
) {
    when (state) {
        is DirectoryPickerUiState.Loading -> {
            AlertDialog(
                onDismissRequest = onDismiss,
                title = { Text(title) },
                text = { CircularProgressIndicator() },
                confirmButton = {},
                dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
            )
        }
        is DirectoryPickerUiState.Error -> {
            AlertDialog(
                onDismissRequest = onDismiss,
                title = { Text("目录加载失败") },
                text = { Text(state.message, color = MaterialTheme.colorScheme.error) },
                confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
            )
        }
        is DirectoryPickerUiState.Ready -> {
            // 默认文案面向「新增工作区」；浏览根等其它用途可覆盖（见 FilesScreen）。
            val label = selectLabel ?: if (state.isWorkspace) "已是工作区" else "选择当前文件夹"
            val enabled = selectEnabled ?: !state.isWorkspace
            AlertDialog(
                onDismissRequest = onDismiss,
                title = { Text(title) },
                text = {
                    Column(modifier = Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                        Text(
                            state.path,
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        state.parent?.let { parent ->
                            TextButton(onClick = { onBrowse(parent) }) { Text("返回上一级") }
                        }
                        TextButton(onClick = onToggleHidden) {
                            Text(if (state.showHidden) "隐藏隐藏目录" else "显示隐藏目录")
                        }
                        state.entries.forEach { entry ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { onBrowse(entry.path) }
                                    .padding(vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    "📁 ${entry.name}",
                                    style = MaterialTheme.typography.bodyMedium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                                if (entry.isWorkspace) {
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Text(
                                        "已是工作区",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                },
                confirmButton = {
                    TextButton(onClick = onSelect, enabled = enabled) { Text(label) }
                },
                dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
            )
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium)
}

@Composable
private fun InfoRow(label: String, value: String, monospace: Boolean = false) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            value,
            style = if (monospace) {
                MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace)
            } else {
                MaterialTheme.typography.bodyMedium
            },
            maxLines = if (monospace) 3 else 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
