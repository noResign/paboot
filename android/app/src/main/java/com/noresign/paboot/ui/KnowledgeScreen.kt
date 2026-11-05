package com.noresign.paboot.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.activity.compose.BackHandler
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.noresign.paboot.network.daemon.dto.KnowledgeDocDetailDto
import com.noresign.paboot.network.daemon.dto.KnowledgeDocDto
import com.noresign.paboot.ui.theme.CodeBody
import com.noresign.paboot.viewmodel.KnowledgeListUiState
import com.noresign.paboot.viewmodel.KnowledgeViewModel
import kotlinx.coroutines.delay

private data class KnowledgeFilter(
    val label: String,
    val status: String? = null,
    val verified: Boolean? = null,
)

private val KNOWLEDGE_FILTERS = listOf(
    KnowledgeFilter("全部"),
    KnowledgeFilter("未核验", verified = false),
    KnowledgeFilter("已核验", verified = true),
    KnowledgeFilter("缺失", status = "missing"),
)

private fun isVerified(doc: KnowledgeDocDto): Boolean = doc.authority == "curated"

private fun verificationLabel(doc: KnowledgeDocDto): String = when {
    doc.reviewStatus == "missing" -> "文件缺失"
    isVerified(doc) -> "已核验"
    else -> "未核验"
}

private fun kindLabel(kind: String): String = when (kind) {
    "workspace_context" -> "工作区总览"
    "convention" -> "规范"
    "requirement" -> "需求"
    "tech_doc" -> "技术文档"
    "adr" -> "ADR"
    "decision" -> "决策"
    "gotcha" -> "踩坑"
    "contract" -> "契约"
    "runbook" -> "Runbook"
    "note" -> "笔记"
    else -> kind
}

/**
 * K0 知识（Android：自动收录，移动端只做核验标记；编辑留在桌面端）。
 * 未核验的条目仍会注入，但指针里会带「未核验」标记。
 *
 * Full navigation destination: top-bar back returns detail → list → previous.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KnowledgeScreen(
    workspaceId: String,
    onBack: () -> Unit,
    viewModel: KnowledgeViewModel = viewModel(),
) {
    val listState by viewModel.listState.collectAsState()
    val detail by viewModel.detail.collectAsState()
    val detailLoading by viewModel.detailLoading.collectAsState()
    val submitting by viewModel.submitting.collectAsState()
    val message by viewModel.message.collectAsState()

    var filter by remember { mutableStateOf(KNOWLEDGE_FILTERS[0]) }
    var query by remember { mutableStateOf("") }

    LaunchedEffect(workspaceId, filter, query) {
        if (query.isNotBlank()) delay(200)
        viewModel.load(
            workspaceId = workspaceId,
            status = filter.status,
            verified = filter.verified,
            q = query.trim().ifEmpty { null },
        )
    }
    LaunchedEffect(message) {
        if (message != null) {
            delay(2600)
            viewModel.clearMessage()
        }
    }

    BackHandler(enabled = detail != null) { viewModel.closeDetail() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (detail != null) "知识详情" else "知识") },
                navigationIcon = {
                    IconButton(
                        onClick = {
                            if (detail != null) viewModel.closeDetail() else onBack()
                        },
                    ) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "知识会自动收录并进入新会话的指针；未核验的条目会标注。移动端只做核验标记。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            message?.let {
                Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            }

            val current = detail
            if (current != null) {
                KnowledgeDetail(
                    detail = current,
                    loading = detailLoading,
                    submitting = submitting,
                    onSetVerified = { verified -> viewModel.setVerified(verified) },
                )
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    KNOWLEDGE_FILTERS.forEach { option ->
                        FilterChip(
                            selected = filter == option,
                            onClick = { filter = option },
                            label = { Text(option.label, style = MaterialTheme.typography.labelSmall) },
                        )
                    }
                }
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("搜索标题、摘要、标签、正文") },
                    singleLine = true,
                )
                when (val state = listState) {
                    is KnowledgeListUiState.Loading -> CircularProgressIndicator(
                        modifier = Modifier.padding(vertical = 24.dp),
                    )
                    is KnowledgeListUiState.Error -> Text(
                        state.message,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    is KnowledgeListUiState.Content -> {
                        if (state.documents.isEmpty()) {
                            Text(
                                "没有匹配的知识文档。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                state.documents.forEach { doc ->
                                    KnowledgeRow(doc) { viewModel.open(doc.id) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun KnowledgeRow(doc: KnowledgeDocDto, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                doc.title,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    verificationLabel(doc),
                    style = MaterialTheme.typography.labelSmall,
                    color = when {
                        doc.reviewStatus == "missing" -> MaterialTheme.colorScheme.error
                        isVerified(doc) -> MaterialTheme.colorScheme.primary
                        else -> MaterialTheme.colorScheme.tertiary
                    },
                )
                Text(
                    kindLabel(doc.kind) + (doc.endId?.let { " · $it" } ?: ""),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                doc.path,
                style = CodeBody,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun KnowledgeDetail(
    detail: KnowledgeDocDetailDto,
    loading: Boolean,
    submitting: Boolean,
    onSetVerified: (Boolean) -> Unit,
) {
    if (loading) {
        CircularProgressIndicator(modifier = Modifier.padding(vertical = 24.dp))
        return
    }
    val verified = detail.authority == "curated"
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(detail.title, style = MaterialTheme.typography.titleMedium)
        Text(
            (if (detail.reviewStatus == "missing") "文件缺失" else if (verified) "已核验" else "未核验") +
                " · " + kindLabel(detail.kind) +
                (detail.endId?.let { " · $it" } ?: ""),
            style = MaterialTheme.typography.labelSmall,
            color = when {
                detail.reviewStatus == "missing" -> MaterialTheme.colorScheme.error
                verified -> MaterialTheme.colorScheme.primary
                else -> MaterialTheme.colorScheme.tertiary
            },
        )
        Text(
            detail.path,
            style = CodeBody,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (!verified && detail.reviewStatus != "missing") {
            Text(
                "未核验：这条知识是自动收录的，会被注入但会带「未核验」标记；看完可以标记核验。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.tertiary,
            )
        }
        Text(
            detail.body.ifEmpty { "（正文为空）" },
            style = MaterialTheme.typography.bodyMedium,
            fontFamily = FontFamily.Monospace,
        )
        if (detail.reviewStatus != "missing") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (verified) {
                    OutlinedButton(enabled = !submitting, onClick = { onSetVerified(false) }) {
                        Text("取消核验")
                    }
                } else {
                    Button(enabled = !submitting, onClick = { onSetVerified(true) }) {
                        Text("标记已核验")
                    }
                }
            }
        }
    }
}
