package com.noresign.paboot.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.noresign.paboot.ui.identity.permissionModeOptions
import com.noresign.paboot.data.NewSessionConfig
import com.noresign.paboot.viewmodel.NewSessionUiState
import com.noresign.paboot.viewmodel.NewSessionViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewSessionSheet(
    onDismiss: () -> Unit,
    onCreate: (NewSessionConfig) -> Unit,
    viewModel: NewSessionViewModel = viewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val selectedAgent by viewModel.selectedAgent.collectAsState()
    val selectedWorkspaceId by viewModel.selectedWorkspaceId.collectAsState()
    val permissionMode by viewModel.permissionMode.collectAsState()

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 24.dp),
        ) {
            LazyColumn(
                // fill = false：内容不足时按内容高度收起，主按钮紧贴其下方；
                // 内容超出时占满剩余高度并内部滚动，主按钮始终留在可见区。
                modifier = Modifier
                    .weight(1f, fill = false)
                    .padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                item { Text("新建会话", style = MaterialTheme.typography.titleLarge) }

                when (val state = uiState) {
                    is NewSessionUiState.Loading -> {
                        item {
                            CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))
                        }
                    }
                    is NewSessionUiState.Error -> {
                        item {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(state.message, color = MaterialTheme.colorScheme.error)
                                OutlinedButton(onClick = viewModel::load) { Text("重试") }
                            }
                        }
                    }
                    is NewSessionUiState.Ready -> {
                        // 会话归属的工作区由「工作区管理」里的当前选择决定，此处只读展示。
                        item {
                            val workspace = state.workspaces.find { it.id == selectedWorkspaceId }
                            val workspaceLabel = workspace?.let {
                                when {
                                    it.isBuiltin -> "内置工作区"
                                    it.name.isBlank() -> it.path
                                    else -> it.name
                                }
                            }
                            Text(
                                text = "工作区：${workspaceLabel ?: "-"}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }

                        item { Text("Agent", style = MaterialTheme.typography.labelLarge) }
                        items(state.agents, key = { it.id }) { agent ->
                            // 没装的 Agent 仍列出来（用户能知道它存在），但置灰不可选：
                            // 选中它只会在发送时换回一个 503。
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable(enabled = agent.available) { viewModel.selectAgent(agent.id) }
                                    .padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(
                                    selected = selectedAgent == agent.id,
                                    onClick = { viewModel.selectAgent(agent.id) },
                                    enabled = agent.available,
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        agent.name.ifBlank { agent.id },
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = if (agent.available) {
                                            MaterialTheme.colorScheme.onSurface
                                        } else {
                                            MaterialTheme.colorScheme.onSurfaceVariant
                                        },
                                    )
                                    if (!agent.available) {
                                        Text(
                                            "未安装",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        }

                        item { Text("模型与推理强度使用电脑端 Agent 默认配置", style = MaterialTheme.typography.bodySmall) }
                        item { Text("权限模式", style = MaterialTheme.typography.labelLarge) }
                        items(permissionModeOptions(selectedAgent)) { (value, desc) ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { viewModel.selectPermissionMode(value) }
                                    .padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(
                                    selected = permissionMode == value,
                                    onClick = { viewModel.selectPermissionMode(value) },
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(value, style = MaterialTheme.typography.bodyMedium)
                                    Text(
                                        desc,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            Button(
                onClick = {
                    onCreate(
                        NewSessionConfig(
                            runtime = selectedAgent,
                            workspaceId = selectedWorkspaceId,
                            permissionMode = permissionMode,
                        ),
                    )
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp)
                    .padding(top = 16.dp),
            ) {
                Text("创建")
            }
        }
    }
}
