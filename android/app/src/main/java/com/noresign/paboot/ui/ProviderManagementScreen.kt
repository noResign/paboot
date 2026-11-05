package com.noresign.paboot.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.noresign.paboot.network.daemon.dto.ProviderDto
import com.noresign.paboot.viewmodel.ProviderDraft
import com.noresign.paboot.viewmodel.ProviderUiState
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

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("模型 Provider") },
            navigationIcon = { TextButton(onClick = onBack) { Text("返回") } },
        )
    }) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "builtin runtime 与 Memory 共用这份配置。API key 只写入 daemon 本机，不会回传客户端。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(
                onClick = {
                    editorTarget = null
                    editorOpen = true
                    viewModel.clearMessages()
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("新增 Provider") }

            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            state.notice?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
            if (state.loading) CircularProgressIndicator()
            state.providers.forEach { provider ->
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
                Text("删除「${provider.label.ifBlank { provider.id }}」？历史会话保留，但后续使用该模型的 run 会失败。")
            },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.delete(provider)
                    deleteTarget = null
                }) { Text("删除") }
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
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    provider.label.ifBlank { provider.id },
                    style = MaterialTheme.typography.titleMedium,
                )
                Spacer(modifier = Modifier.weight(1f))
                if (provider.builtin) {
                    Text("内置", style = MaterialTheme.typography.labelSmall)
                }
            }
            Text(
                provider.id,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                provider.baseUrl,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                buildString {
                    append(if (provider.hasApiKey) "Key 已配置" else "未配置 Key")
                    provider.apiKeySource?.let { append(" · $it") }
                    append(" · ${provider.models.size} 个模型")
                },
                style = MaterialTheme.typography.bodySmall,
                color = if (provider.hasApiKey) MaterialTheme.colorScheme.onSurfaceVariant
                else MaterialTheme.colorScheme.error,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onEdit, enabled = !busy) { Text("编辑") }
                OutlinedButton(onClick = onTest, enabled = !busy && provider.hasApiKey) { Text("测试") }
                OutlinedButton(onClick = onRefresh, enabled = !busy && provider.hasApiKey) { Text("刷新") }
                if (!provider.builtin) {
                    OutlinedButton(onClick = onDelete, enabled = !busy) { Text("删除") }
                }
            }
        }
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
        title = { Text(if (provider == null) "新增 Provider" else "编辑 Provider") },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = id,
                    onValueChange = { id = it },
                    enabled = provider == null,
                    label = { Text("ID") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { kind = "openai" }) {
                        Text(if (kind == "openai") "✓ OpenAI-compatible" else "OpenAI-compatible")
                    }
                    OutlinedButton(onClick = { kind = "anthropic" }) {
                        Text(if (kind == "anthropic") "✓ Anthropic" else "Anthropic")
                    }
                }
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
                    label = { Text(if (provider?.hasApiKey == true) "API Key（留空不变）" else "API Key") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (provider?.hasApiKey == true) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Switch(checked = clearKey, onCheckedChange = {
                            clearKey = it
                            if (it) apiKey = ""
                        })
                        Text("清除已保存的 Key")
                    }
                }
                OutlinedTextField(
                    value = modelIds,
                    onValueChange = { modelIds = it },
                    label = { Text("模型 ID（每行一个）") },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "已有模型的 tools / 图片 / 上下文配置会按 id 保留；新模型默认支持 tools、不支持图片。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
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
