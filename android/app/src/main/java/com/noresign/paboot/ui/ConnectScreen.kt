package com.noresign.paboot.ui

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.noresign.paboot.data.SavedConnection
import com.noresign.paboot.ui.theme.Brand
import com.noresign.paboot.ui.theme.BrandGlyph
import com.noresign.paboot.util.maskAddress
import com.noresign.paboot.viewmodel.ConnectUiState
import com.noresign.paboot.viewmodel.ConnectViewModel
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import kotlin.math.roundToInt

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
                .consumeWindowInsets(innerPadding)
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
                        imageVector = BrandGlyph,
                        contentDescription = null,
                        tint = Color.White,
                        // 占盒子 70%，与桌面端 BrandMark 一致
                        modifier = Modifier.size(50.dp),
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

            OutlinedTextField(
                value = baseUrl,
                onValueChange = viewModel::onBaseUrlChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("地址") },
                placeholder = { Text("192.168.1.2:4780", maxLines = 1, overflow = TextOverflow.Ellipsis) },
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
                label = { Text("Token") },
                placeholder = { Text("从 ~/.paboot/token 读取", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                singleLine = true,
                visualTransformation = if (tokenVisible) VisualTransformation.None else PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Next
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

            OutlinedTextField(
                value = name,
                onValueChange = viewModel::onNameChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("名称（可选）") },
                placeholder = { Text("这台电脑的名字", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { viewModel.connect() }),
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
                    onSelect = viewModel::fillSaved,
                    onEdit = viewModel::updateSaved,
                    onForget = viewModel::forgetSaved,
                )
            }

            Text(
                text = "token 等同于在电脑上执行命令的权限，请只在可信网络或隧道中使用。" +
                    "在电脑上执行 cat ~/.paboot/token 可获取 token。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/** 「最近连接」列表：点击回填表单，左滑露出「编辑 / 删除」（与 iOS 一致）。 */
@Composable
private fun SavedConnectionsSection(
    connections: List<SavedConnection>,
    onSelect: (SavedConnection) -> Unit,
    onEdit: (SavedConnection, String, String, String) -> Boolean,
    onForget: (String) -> Unit,
) {
    // 同一时刻只允许一张滑开。
    var revealedUrl by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<SavedConnection?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "最近连接",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        connections.forEach { connection ->
            SwipeRevealConnectionRow(
                connection = connection,
                revealed = revealedUrl == connection.baseUrl,
                onRevealChange = { open ->
                    revealedUrl = if (open) connection.baseUrl else revealedUrl.takeUnless { it == connection.baseUrl }
                },
                onSelect = { onSelect(connection) },
                onEdit = {
                    revealedUrl = null
                    editing = connection
                },
                onDelete = { onForget(connection.baseUrl) },
            )
        }
    }

    editing?.let { connection ->
        EditSavedConnectionDialog(
            connection = connection,
            onDismiss = { editing = null },
            onSave = { name, baseUrl, token -> onEdit(connection, name, baseUrl, token) },
        )
    }
}

/**
 * 卡片默认不显示动作；左滑后停在滑开位置露出「编辑 / 删除」，点卡片本身收起。
 * 不用 M3 的 `SwipeToDismissBox`：那个松手即触发动作、停不在中间，而这里要的是「滑开 → 再点」。
 */
@Composable
private fun SwipeRevealConnectionRow(
    connection: SavedConnection,
    revealed: Boolean,
    onRevealChange: (Boolean) -> Unit,
    onSelect: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    val actionWidth = 80.dp
    val actionPx = with(LocalDensity.current) { (actionWidth * 2).toPx() }
    var offsetX by remember(connection.baseUrl) { mutableFloatStateOf(0f) }
    // 每次拖拽结束 +1：即使滑开状态没变（滑一点点又放开），也要补间回锚点。
    var settle by remember(connection.baseUrl) { mutableIntStateOf(0) }

    LaunchedEffect(revealed, settle, actionPx) {
        animate(
            initialValue = offsetX,
            targetValue = if (revealed) -actionPx else 0f,
            animationSpec = tween(180),
        ) { value, _ -> offsetX = value }
    }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium),
    ) {
        // 底下的动作：卡片被推开后露出来。
        Box(
            modifier = Modifier.matchParentSize(),
            contentAlignment = Alignment.CenterEnd,
        ) {
            Row(modifier = Modifier.fillMaxHeight()) {
                Box(
                    modifier = Modifier
                        .width(actionWidth)
                        .fillMaxHeight()
                        .background(MaterialTheme.colorScheme.primary)
                        .clickable(onClick = onEdit),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "编辑",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                }
                Box(
                    modifier = Modifier
                        .width(actionWidth)
                        .fillMaxHeight()
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
        }
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .offset { IntOffset(offsetX.roundToInt(), 0) }
                .draggable(
                    orientation = Orientation.Horizontal,
                    state = rememberDraggableState { delta ->
                        offsetX = (offsetX + delta).coerceIn(-actionPx, 0f)
                    },
                    onDragStopped = { velocity ->
                        val open = when {
                            velocity < -800f -> true
                            velocity > 800f -> false
                            else -> offsetX < -actionPx / 2f
                        }
                        onRevealChange(open)
                        settle += 1
                    },
                )
                .clickable {
                    if (revealed) onRevealChange(false) else onSelect()
                }
                // 滑动手势对 TalkBack 不可用，额外提供编辑 / 删除的无障碍动作。
                .semantics {
                    customActions = listOf(
                        CustomAccessibilityAction("编辑") {
                            onEdit()
                            true
                        },
                        CustomAccessibilityAction("删除") {
                            onDelete()
                            true
                        },
                    )
                },
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = connection.displayName,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = maskAddress(connection.baseUrl),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/** 编辑最近连接：名称 / 地址 / token；保存时写回列表（地址与 token 必填）。 */
@Composable
private fun EditSavedConnectionDialog(
    connection: SavedConnection,
    onDismiss: () -> Unit,
    onSave: (String, String, String) -> Boolean,
) {
    var name by remember(connection.baseUrl) { mutableStateOf(connection.name) }
    var baseUrl by remember(connection.baseUrl) { mutableStateOf(connection.baseUrl) }
    var token by remember(connection.baseUrl) { mutableStateOf(connection.token) }
    var tokenVisible by remember(connection.baseUrl) { mutableStateOf(false) }
    val canSave = baseUrl.isNotBlank() && token.isNotBlank()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("编辑连接") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("名称（可选）") },
                    singleLine = true,
                )
                OutlinedTextField(
                    value = baseUrl,
                    onValueChange = { baseUrl = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("地址") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Token") },
                    singleLine = true,
                    visualTransformation = if (tokenVisible) {
                        VisualTransformation.None
                    } else {
                        PasswordVisualTransformation()
                    },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
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
                    },
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    if (onSave(name, baseUrl, token)) onDismiss()
                },
                enabled = canSave,
            ) { Text("保存") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
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
