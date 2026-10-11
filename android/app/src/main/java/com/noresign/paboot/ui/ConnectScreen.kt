package com.noresign.paboot.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.noresign.paboot.data.SavedConnection
import com.noresign.paboot.ui.theme.Brand
import com.noresign.paboot.viewmodel.ConnectUiState
import com.noresign.paboot.viewmodel.ConnectViewModel
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowDropDown
import androidx.compose.material.icons.rounded.SmartToy
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow

@Composable
fun ConnectScreen(
    onConnectSuccess: (String) -> Unit = {},
    viewModel: ConnectViewModel = viewModel()
) {
    val uiState by viewModel.uiState.collectAsState()
    val baseUrl by viewModel.baseUrl.collectAsState()
    val token by viewModel.token.collectAsState()
    val savedConnections by viewModel.savedConnections.collectAsState()
    val name by viewModel.name.collectAsState()

    // 连接成功即直接进入会话；失败才留在本页让 StatusCard 展示原因
    LaunchedEffect(uiState) {
        val success = uiState as? ConnectUiState.Success ?: return@LaunchedEffect
        onConnectSuccess(success.baseUrl)
    }

    Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box(
                    modifier = Modifier
                        .size(72.dp)
                        .background(Brand.Gradient, RoundedCornerShape(22.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Rounded.SmartToy,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(38.dp),
                    )
                }
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    text = "paboot",
                    style = MaterialTheme.typography.headlineMedium,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "一个客户端，操纵你所有的 agent",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            var nameMenuOpen by remember { mutableStateOf(false) }
            BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
                val menuWidth = maxWidth
                OutlinedTextField(
                    value = name,
                    onValueChange = viewModel::onNameChange,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("名称") },
                    // placeholder 必须锁成一行：singleLine 只约束输入文本，长 placeholder 换行会把输入框撑高
                    placeholder = { Text("如：家里的 Mac mini", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                    trailingIcon = {
                        if (savedConnections.isNotEmpty()) {
                            IconButton(onClick = { nameMenuOpen = true }) {
                                Icon(
                                    imageVector = Icons.Rounded.ArrowDropDown,
                                    contentDescription = "选择已保存的连接",
                                )
                            }
                        }
                    },
                )
                DropdownMenu(
                    expanded = nameMenuOpen,
                    onDismissRequest = { nameMenuOpen = false },
                    // 和输入框等宽
                    modifier = Modifier.width(menuWidth),
                    // 默认是灰色 surfaceContainer + tonalElevation，改成干净的 surface
                    containerColor = MaterialTheme.colorScheme.surface,
                    tonalElevation = 0.dp,
                    shadowElevation = 6.dp,
                    shape = RoundedCornerShape(12.dp),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                ) {
                    savedConnections.forEach { connection ->
                        // 用自定义 Row 而不是 DropdownMenuItem：后者的默认行高偏大
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    nameMenuOpen = false
                                    viewModel.fillSaved(connection)
                                }
                                .padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = connection.name.ifBlank { connection.baseUrl },
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }

            OutlinedTextField(
                value = baseUrl,
                onValueChange = viewModel::onBaseUrlChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("daemon 地址") },
                placeholder = { Text("http://192.168.1.5:4780", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Next
                )
            )

            var tokenVisible by remember { mutableStateOf(false) }
            OutlinedTextField(
                value = token,
                onValueChange = viewModel::onTokenChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("token") },
                placeholder = { Text("粘贴 ~/.paboot/token 的内容", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                singleLine = true,
                visualTransformation = if (tokenVisible) VisualTransformation.None else PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Done
                ),
                trailingIcon = {
                    IconButton(onClick = { tokenVisible = !tokenVisible }) {
                        Icon(
                            imageVector = if (tokenVisible) {
                                Icons.Rounded.VisibilityOff
                            } else {
                                Icons.Rounded.Visibility
                            },
                            contentDescription = if (tokenVisible) "隐藏 token" else "显示 token",
                        )
                    }
                }
            )

            Button(
                onClick = viewModel::connect,
                modifier = Modifier.fillMaxWidth(),
                enabled = uiState !is ConnectUiState.Connecting
            ) {
                if (uiState is ConnectUiState.Connecting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp
                    )
                    Spacer(modifier = Modifier.size(8.dp))
                }
                Text(if (uiState is ConnectUiState.Connecting) "连接中…" else "连接")
            }

            StatusCard(uiState = uiState)

            if (savedConnections.isNotEmpty()) {
                SavedConnectionsSection(
                    connections = savedConnections,
                    onSelect = viewModel::selectSaved,
                    onForget = viewModel::forgetSaved,
                )
            }

            Text(
                text = "提示：在运行 daemon 的电脑上执行 cat ~/.paboot/token 可获取 token；daemon 默认监听 0.0.0.0:4780。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/** 「最近连接」列表：点击即填入并连接，长按可移除。 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SavedConnectionsSection(
    connections: List<SavedConnection>,
    onSelect: (SavedConnection) -> Unit,
    onForget: (String) -> Unit,
) {
    var pendingForget by remember { mutableStateOf<SavedConnection?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "最近连接",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        connections.forEach { connection ->
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .combinedClickable(
                        onClick = { onSelect(connection) },
                        onLongClick = { pendingForget = connection },
                    ),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    Text(
                        text = connection.name.ifBlank { connection.baseUrl },
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = connection.baseUrl,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }

    pendingForget?.let { connection ->
        AlertDialog(
            onDismissRequest = { pendingForget = null },
            title = { Text("移除记录") },
            text = { Text("确定移除「${connection.name.ifBlank { connection.baseUrl }}」吗？") },
            confirmButton = {
                TextButton(onClick = {
                    onForget(connection.baseUrl)
                    pendingForget = null
                }) { Text("移除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingForget = null }) { Text("取消") }
            },
        )
    }
}

/** 连接失败时的原因卡片；成功会直接跳会话，不在这里展示。 */
@Composable
private fun StatusCard(uiState: ConnectUiState) {
    if (uiState !is ConnectUiState.Error) return

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(
                    shape = MaterialTheme.shapes.small,
                    color = MaterialTheme.colorScheme.error
                ) {
                    Text(
                        text = "连接失败",
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onError
                    )
                }
            }
            Spacer(modifier = Modifier.height(8.dp))
            Text(text = uiState.message, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
