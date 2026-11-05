package com.noresign.paboot.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.noresign.paboot.network.daemon.dto.ProviderDto
import com.noresign.paboot.ui.theme.LocalSemanticColors
import com.noresign.paboot.viewmodel.ProviderDraft
import com.noresign.paboot.viewmodel.ProviderViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProviderManagementScreen(
    onBack: () -> Unit,
    viewModel: ProviderViewModel = viewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    var editorTarget by remember { mutableStateOf<ProviderDto?>(null) }
    var editorOpen by remember { mutableStateOf(false) }
    var deleteTarget by remember { mutableStateOf<ProviderDto?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("模型 Provider") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    TextButton(
                        onClick = {
                            editorTarget = null
                            editorOpen = true
                            viewModel.clearMessages()
                        },
                    ) { Text("+ 新增") }
                },
            )
        },
    ) { padding ->
        if (state.loading && state.providers.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator() }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(start = 16.dp, top = 10.dp, end = 16.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item {
                    Text(
                        "builtin runtime 与 Memory 共用这份配置。API key 只写入 daemon 本机，不会回传客户端。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 4.dp),
                    )
                }
                state.error?.let { message ->
                    item {
                        Text(
                            message,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
                state.notice?.let { message ->
                    item {
                        Text(
                            message,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
                if (state.providers.isEmpty()) {
                    item {
                        Box(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 48.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                "还没有 Provider，点右上角「+ 新增」添加一个。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                items(state.providers, key = { it.id }) { provider ->
                    ProviderCard(
                        provider = provider,
                        busy = state.busy,
                        onEdit = {
                            editorTarget = provider
                            editorOpen = true
                            viewModel.clearMessages()
                        },
                        onTest = { viewModel.test(provider) },
                        onRefresh = { viewModel.refreshModels(provider) },
                        onDelete = { deleteTarget = provider },
                    )
                }
            }
        }
    }

    if (editorOpen) {
        ProviderEditorDialog(
            provider = editorTarget,
            busy = state.busy,
            onDismiss = { editorOpen = false },
            onSave = { draft ->
                viewModel.save(editorTarget, draft)
                editorOpen = false
            },
        )
    }
    deleteTarget?.let { provider ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("删除 Provider") },
            text = {
                Text("删除「${provider.label.ifBlank { provider.id }}」？历史会话保留，但之后使用该模型的 run 会失败。")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.delete(provider)
                        deleteTarget = null
                    },
                ) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun ProviderCard(
    provider: ProviderDto,
    busy: Boolean,
    onEdit: () -> Unit,
    onTest: () -> Unit,
    onRefresh: () -> Unit,
    onDelete: () -> Unit,
) {
    val enabledModels = provider.models.count { it.enabled != false }
    val supportsImages = provider.models.any { it.supportsImages == true }
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shape = RoundedCornerShape(12.dp),
    ) {
        Column(
            modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = 13.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Row(verticalAlignment = Alignment.Top) {
                Column(modifier = Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            provider.label.ifBlank { provider.id },
                            style = MaterialTheme.typography.titleSmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(modifier = Modifier.width(7.dp))
                        ProviderBadge(
                            text = providerKindLabel(provider.kind),
                            containerColor = MaterialTheme.colorScheme.surfaceVariant,
                            contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (provider.builtin) {
                            Spacer(modifier = Modifier.width(5.dp))
                            ProviderBadge(
                                text = "内置",
                                containerColor = MaterialTheme.colorScheme.primaryContainer,
                                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                            )
                        }
                    }
                    if (showProviderId(provider)) {
                        Text(
                            provider.id,
                            style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                KeyStatus(provider)
            }
            Text(
                provider.baseUrl,
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                StatChip("${provider.models.size} 个模型")
                StatChip("$enabledModels 已启用")
                if (supportsImages) StatChip("图片")
            }
            HorizontalDivider(
                modifier = Modifier.padding(top = 3.dp),
                color = MaterialTheme.colorScheme.outlineVariant,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onEdit, enabled = !busy) { Text("编辑") }
                TextButton(onClick = onTest, enabled = !busy && provider.hasApiKey) { Text("测试") }
                TextButton(onClick = onRefresh, enabled = !busy && provider.hasApiKey) { Text("刷新") }
                Spacer(modifier = Modifier.weight(1f))
                if (!provider.builtin) {
                    TextButton(onClick = onDelete, enabled = !busy) {
                        Text("删除", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }
}

@Composable
private fun KeyStatus(provider: ProviderDto) {
    val colors = LocalSemanticColors.current
    val color = if (provider.hasApiKey) colors.success else colors.warning
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(color.copy(alpha = 0.10f))
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(
            modifier = Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(color),
        )
        Text(
            text = if (provider.hasApiKey) {
                "Key 已配置${provider.apiKeySource?.let { " · $it" } ?: ""}"
            } else {
                "未配置 Key"
            },
            style = MaterialTheme.typography.labelSmall,
            color = color,
        )
    }
}

@Composable
private fun ProviderBadge(text: String, containerColor: Color, contentColor: Color) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(containerColor)
            .padding(horizontal = 7.dp, vertical = 2.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelSmall, color = contentColor)
    }
}

@Composable
private fun StatChip(text: String) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ProviderEditorDialog(
    provider: ProviderDto?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (ProviderDraft) -> Unit,
) {
    var id by remember(provider) { mutableStateOf(provider?.id ?: "") }
    var kind by remember(provider) { mutableStateOf(provider?.kind ?: "openai") }
    var label by remember(provider) { mutableStateOf(provider?.label ?: "") }
    var baseUrl by remember(provider) { mutableStateOf(provider?.baseUrl ?: "") }
    var apiKey by remember(provider) { mutableStateOf("") }
    var clearKey by remember(provider) { mutableStateOf(false) }
    var modelIds by remember(provider) {
        mutableStateOf(provider?.models?.joinToString("\n") { it.id } ?: "")
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(if (provider == null) "新增 Provider" else "编辑 Provider")
                Text(
                    provider?.let { it.label.ifBlank { it.id } } ?: "填写连接信息和模型目录",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("协议类型", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(
                        selected = kind == "openai",
                        onClick = { kind = "openai" },
                        label = { Text("OpenAI-compatible") },
                    )
                    FilterChip(
                        selected = kind == "anthropic",
                        onClick = { kind = "anthropic" },
                        label = { Text("Anthropic") },
                    )
                }
                OutlinedTextField(
                    value = id,
                    onValueChange = { id = it },
                    enabled = provider == null,
                    label = { Text("ID") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = label,
                    onValueChange = { label = it },
                    label = { Text("显示名称") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = baseUrl,
                    onValueChange = { baseUrl = it },
                    label = { Text("Base URL") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = apiKey,
                    onValueChange = {
                        apiKey = it
                        clearKey = false
                    },
                    label = {
                        Text(
                            when {
                                provider?.hasApiKey == true -> "API Key（留空不修改）"
                                provider == null -> "API Key（可选）"
                                else -> "API Key"
                            },
                        )
                    },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (provider?.hasApiKey == true) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Switch(
                            checked = clearKey,
                            onCheckedChange = {
                                clearKey = it
                                if (it) apiKey = ""
                            },
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("清除已保存的 Key", style = MaterialTheme.typography.bodySmall)
                    }
                }
                OutlinedTextField(
                    value = modelIds,
                    onValueChange = { modelIds = it },
                    label = { Text("模型 ID") },
                    supportingText = { Text("每行一个。已有模型会保留 Tools / 图片 / 上下文配置。") },
                    minLines = 2,
                    maxLines = 5,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = {
                    onSave(
                        ProviderDraft(
                            id = id.trim(),
                            kind = kind,
                            label = label.trim(),
                            baseUrl = baseUrl.trim(),
                            apiKey = apiKey.trim(),
                            clearKey = clearKey,
                            modelIds = modelIds,
                        ),
                    )
                },
            ) { Text(if (busy) "保存中…" else "保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

private fun providerKindLabel(kind: String): String =
    if (kind == "anthropic") "Anthropic" else "OpenAI-compatible"

private fun normalizedProviderLabel(value: String): String =
    value.replace(Regex("[\\s_-]+"), "").lowercase()

private fun showProviderId(provider: ProviderDto): Boolean =
    normalizedProviderLabel(provider.id) != normalizedProviderLabel(provider.label.ifBlank { provider.id })
