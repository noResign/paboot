package com.noresign.paboot.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.noresign.paboot.network.daemon.dto.MemoryClaimDto
import com.noresign.paboot.network.daemon.dto.MemoryDisputeDto
import com.noresign.paboot.network.daemon.dto.MemoryDuplicateDto
import com.noresign.paboot.network.daemon.dto.MemoryEntityDto
import com.noresign.paboot.network.daemon.dto.MemoryStatusDto
import com.noresign.paboot.network.daemon.dto.MemoryTimelineItemDto
import com.noresign.paboot.network.daemon.dto.WorkspaceMemoryDto
import com.noresign.paboot.viewmodel.MemoryUiState
import com.noresign.paboot.viewmodel.MemoryViewModel
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private data class MemoryGroup(
    val kind: String,
    val label: String,
    val claims: List<MemoryClaimDto>,
)

private val MEMORY_GROUPS = listOf(
    "fact" to "关于你",
    "preference" to "偏好",
    "relation" to "关系",
    "profile" to "画像",
)

private fun kindLabel(kind: String): String =
    MEMORY_GROUPS.firstOrNull { it.first == kind }?.second ?: kind

private fun shortClaimId(id: String): String = id.replace("-", "").take(4)

private fun authorityLabel(claim: MemoryClaimDto): String =
    if (claim.authority == "user_confirmed") "你已确认" else "自动整理"

private fun dateLabel(timestamp: Long?): String {
    if (timestamp == null || timestamp <= 0) return "—"
    return SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date(timestamp))
}

/** validFrom = 事实开始生效；validTo 为空表示仍然有效。 */
private fun validityLabel(claim: MemoryClaimDto): String {
    val from = claim.validFrom?.takeIf { it > 0 }
    val to = claim.validTo?.takeIf { it > 0 }
    return when {
        from == null && to == null -> "未知"
        from != null && to != null -> "${dateLabel(from)} – ${dateLabel(to)}"
        from != null -> "${dateLabel(from)} 起"
        else -> "至 ${dateLabel(to)}"
    }
}

private fun matchesQuery(claim: MemoryClaimDto, query: String): Boolean {
    if (query.isBlank()) return true
    val needle = query.trim().lowercase()
    val haystack = buildString {
        append(claim.summary.lowercase())
        append('\n')
        append(claim.objectText.orEmpty().lowercase())
        append('\n')
        append(claim.predicate.lowercase())
        claim.evidence.forEach {
            append('\n')
            append(it.quote.orEmpty().lowercase())
        }
    }
    return haystack.contains(needle)
}

private fun grouped(claims: List<MemoryClaimDto>, query: String): List<MemoryGroup> =
    MEMORY_GROUPS.mapNotNull { (kind, label) ->
        val rows = claims
            .filter { it.kind == kind && matchesQuery(it, query) }
            .sortedWith(
                compareByDescending<MemoryClaimDto> { it.authority == "user_confirmed" }
                    .thenByDescending { it.importance }
                    .thenByDescending { it.updatedAt }
            )
        if (rows.isEmpty()) null else MemoryGroup(kind, label, rows)
    }

/** Memory M0「关于你」：按类型分组的紧凑列表 + 详情 sheet。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemoryScreen(
    workspaceId: String,
    onBack: () -> Unit,
    viewModel: MemoryViewModel = viewModel(),
) {
    val state by viewModel.state.collectAsState()
    val busy by viewModel.busy.collectAsState()
    val message by viewModel.message.collectAsState()

    var editing by remember { mutableStateOf<MemoryClaimDto?>(null) }
    var editSummary by remember { mutableStateOf("") }
    var editObject by remember { mutableStateOf("") }
    var forgetting by remember { mutableStateOf<MemoryClaimDto?>(null) }
    var selected by remember { mutableStateOf<MemoryClaimDto?>(null) }
    var query by remember { mutableStateOf("") }
    var collapsed by remember { mutableStateOf(setOf<String>()) }

    LaunchedEffect(workspaceId) { viewModel.load(workspaceId) }
    LaunchedEffect(message) {
        if (message != null) {
            delay(2600)
            viewModel.clearMessage()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("记忆") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        when (val current = state) {
            is MemoryUiState.Loading -> Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                CircularProgressIndicator()
                Spacer(modifier = Modifier.size(12.dp))
                Text(
                    "加载记忆…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            is MemoryUiState.Error -> Surface(
                modifier = Modifier
                    .padding(padding)
                    .padding(20.dp),
                shape = RoundedCornerShape(14.dp),
                color = MaterialTheme.colorScheme.errorContainer,
            ) {
                Text(
                    current.message,
                    modifier = Modifier.padding(16.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
            }

            is MemoryUiState.Content -> {
                val groups = remember(current.claims, query) { grouped(current.claims, query) }
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentPadding = PaddingValues(start = 20.dp, top = 12.dp, end = 20.dp, bottom = 28.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    message?.let {
                        item(key = "notice") { NoticeBanner(it) }
                    }
                    item(key = "status") { StatusCard(current.status, current.claims.size) }
                    item(key = "settings") { MemorySettingsCard(current.settings) }
                    if (current.settings?.enabled == false) {
                        item(key = "disabled-hint") {
                            Text(
                                "记忆未启用；请在桌面端打开这个工作区的记忆。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    if (current.timeline.isNotEmpty()) {
                        item(key = "timeline") { MemoryTimelineCard(current.timeline.take(6)) }
                    }
                    if (current.disputes.isNotEmpty()) {
                        item(key = "disputes") { MemoryDisputesCard(current.disputes.take(3)) }
                    }
                    if (current.duplicates.isNotEmpty()) {
                        item(key = "duplicates") { MemoryDuplicatesCard(current.duplicates.take(5)) }
                    }
                    if (current.entities.isNotEmpty()) {
                        item(key = "entities") { MemoryEntitiesCard(current.entities.take(6)) }
                    }
                    item(key = "search") {
                        SearchField(query = query, onQueryChange = { query = it })
                    }

                    if (current.claims.isEmpty()) {
                        item(key = "empty") {
                            EmptyState(
                                icon = Icons.Rounded.Person,
                                title = "还没有记忆",
                                hint = "在「生活」里正常聊天即可，消息会在后台自动整理。",
                            )
                        }
                    } else if (groups.isEmpty()) {
                        item(key = "no-match") {
                            EmptyState(
                                icon = Icons.Rounded.Search,
                                title = "没有匹配的记忆",
                                hint = "换一个摘要、内容或来源原话里的关键词试试。",
                            )
                        }
                    }

                    groups.forEach { group ->
                        val isCollapsed = collapsed.contains(group.kind)
                        item(key = "header-${group.kind}") {
                            GroupHeader(
                                label = group.label,
                                count = group.claims.size,
                                collapsed = isCollapsed,
                                onToggle = {
                                    collapsed = if (isCollapsed) {
                                        collapsed - group.kind
                                    } else {
                                        collapsed + group.kind
                                    }
                                },
                            )
                        }
                        if (!isCollapsed) {
                            item(key = "group-${group.kind}") {
                                GroupCard(group.claims) { selected = it }
                            }
                        }
                    }
                }
            }
        }
    }

    selected?.let { claim ->
        ModalBottomSheet(
            onDismissRequest = { selected = null },
            containerColor = MaterialTheme.colorScheme.surface,
        ) {
            MemoryDetail(
                claim = claim,
                onEdit = {
                    selected = null
                    editing = claim
                    editSummary = claim.summary
                    editObject = claim.objectText.orEmpty()
                },
                onForget = {
                    selected = null
                    forgetting = claim
                },
            )
        }
    }

    editing?.let { claim ->
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("改正记忆") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = editSummary,
                        onValueChange = { editSummary = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("摘要") },
                        shape = RoundedCornerShape(12.dp),
                    )
                    OutlinedTextField(
                        value = editObject,
                        onValueChange = { editObject = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("内容") },
                        shape = RoundedCornerShape(12.dp),
                    )
                    Text(
                        "改正后这条记忆标记为「你已确认」，自动抽取不会覆盖。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = {
                Button(
                    enabled = !busy && (editSummary.isNotBlank() || editObject.isNotBlank()),
                    shape = RoundedCornerShape(10.dp),
                    onClick = {
                        viewModel.correct(claim.id, editSummary.trim(), editObject.trim())
                        editing = null
                    },
                ) { Text("保存改正") }
            },
            dismissButton = {
                TextButton(onClick = { editing = null }) { Text("取消") }
            },
        )
    }

    forgetting?.let { claim ->
        AlertDialog(
            onDismissRequest = { forgetting = null },
            title = { Text("忘记这条记忆？") },
            text = { Text("会删除这条记忆，并阻止后续从相同原话重新抽取。") },
            confirmButton = {
                Button(
                    enabled = !busy,
                    shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError,
                    ),
                    onClick = {
                        viewModel.forget(claim.id)
                        forgetting = null
                    },
                ) { Text("确认忘记") }
            },
            dismissButton = {
                TextButton(onClick = { forgetting = null }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun NoticeBanner(text: String) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.primaryContainer,
    ) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
        )
    }
}

@Composable
private fun StatusCard(status: MemoryStatusDto?, totalClaims: Int) {
    val model = status?.extractionModel
    val modelAvailable = status?.modelAvailable == true && model != null
    val pending = status?.pendingSources ?: 0
    val statusTitle = when {
        status == null -> "状态暂不可用"
        modelAvailable -> "自动整理中"
        model != null -> "配置不可用"
        else -> "仅记录"
    }
    val statusDetail = when {
        status == null -> "列表仍可浏览，稍后重新进入可重试。"
        modelAvailable -> "$model · 已记 $totalClaims 条"
        model != null -> "$model · 请检查 Provider 的 Key、启用状态和模型目录。"
        else -> "选择记忆模型后自动整理；当前已记 $totalClaims 条。"
    }
    val statusColor = when {
        status == null -> MaterialTheme.colorScheme.onSurfaceVariant
        modelAvailable -> MaterialTheme.colorScheme.primary
        model != null -> MaterialTheme.colorScheme.tertiary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.primaryContainer),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Rounded.Person,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.size(21.dp),
                )
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Text("长期记忆", style = MaterialTheme.typography.titleMedium)
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(statusColor),
                    )
                    Text(
                        statusTitle,
                        style = MaterialTheme.typography.labelSmall,
                        color = statusColor,
                    )
                }
                Text(
                    statusDetail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (pending > 0) {
                Text(
                    "$pending 待整理",
                    modifier = Modifier
                        .background(MaterialTheme.colorScheme.surfaceVariant, CircleShape)
                        .padding(horizontal = 9.dp, vertical = 4.dp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun MemorySettingsCard(settings: WorkspaceMemoryDto?) {
    if (settings == null) return
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("记忆设置（只读）", style = MaterialTheme.typography.titleSmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    if (settings.enabled) "已启用" else "未启用",
                    style = MaterialTheme.typography.labelMedium,
                    color = if (settings.enabled) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
                if (settings.enabled) {
                    Text(
                        if (settings.injectionEnabled) "注入开" else "只记录",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                settings.profileMode?.let {
                    Text(
                        "画像 $it",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                settings.lifeReadable?.let {
                    Text(
                        if (it) "允许生活读取" else "生活不可读",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Text(
                "开关和画像范围请在桌面端修改。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun MemoryTimelineCard(items: List<MemoryTimelineItemDto>) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("最近工作", style = MaterialTheme.typography.titleSmall)
            items.forEach { item ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        item.title,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        "${if (item.kind == "summary") "摘要" else "观察"} · ${dateLabel(item.at)}" +
                            (item.sessionId?.let { " · 会话 ${it.replace("-", "").take(4)}" } ?: "") +
                            if (item.files.isEmpty()) "" else " · ${item.files.size} 个文件",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun MemoryDuplicatesCard(items: List<MemoryDuplicateDto>) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("重复候选（只读）", style = MaterialTheme.typography.titleSmall)
            items.forEach { item ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        item.claimSummary,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        "与「${item.duplicateSummary}」相似 ${(item.score * 100).toInt()}%",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Text(
                "合并 / 忽略请在桌面端处理。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun MemoryDisputesCard(items: List<MemoryDisputeDto>) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("待裁决（只读）", style = MaterialTheme.typography.titleSmall)
            items.forEach { item ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        "新：${item.newClaim.summary}",
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        "旧：${item.oldClaim.summary} · ${item.predicate}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Text(
                "请在桌面端裁决。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun MemoryEntitiesCard(items: List<MemoryEntityDto>) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("实体（只读）", style = MaterialTheme.typography.titleSmall)
            items.forEach { entity ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        entity.canonicalName,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        buildString {
                            append(ENTITY_KIND_LABELS[entity.kind] ?: entity.kind)
                            if (entity.aliases.isNotEmpty()) {
                                append(" · ${entity.aliases.size} 个别名")
                            }
                            append(" · ${entity.claimCount} 条记忆")
                            if (entity.linkCount > 0) append(" · 关联 ${entity.linkCount}")
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Text(
                "合并请在桌面端处理。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private val ENTITY_KIND_LABELS = mapOf(
    "person" to "人物",
    "place" to "地点",
    "org" to "组织",
    "pet" to "宠物",
    "project" to "项目",
    "thing" to "事物",
)

@Composable
private fun SearchField(query: String, onQueryChange: (String) -> Unit) {
    OutlinedTextField(
        value = query,
        onValueChange = onQueryChange,
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        shape = RoundedCornerShape(14.dp),
        textStyle = MaterialTheme.typography.bodyMedium,
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = MaterialTheme.colorScheme.surface,
            unfocusedContainerColor = MaterialTheme.colorScheme.surface,
            focusedBorderColor = MaterialTheme.colorScheme.primary,
            unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
        ),
        leadingIcon = {
            Icon(
                Icons.Rounded.Search,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
        trailingIcon = if (query.isNotEmpty()) {
            {
                IconButton(onClick = { onQueryChange("") }) {
                    Icon(
                        Icons.Rounded.Close,
                        contentDescription = "清空搜索",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        } else {
            null
        },
        placeholder = {
            Text(
                "搜索摘要、内容或来源原话",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
    )
}

@Composable
private fun GroupHeader(
    label: String,
    count: Int,
    collapsed: Boolean,
    onToggle: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .clip(RoundedCornerShape(10.dp))
            .clickable(onClick = onToggle)
            .padding(horizontal = 4.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.weight(1f),
        )
        Text(
            count.toString(),
            modifier = Modifier
                .background(MaterialTheme.colorScheme.surfaceVariant, CircleShape)
                .padding(horizontal = 8.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Icon(
            if (collapsed) Icons.Rounded.ExpandMore else Icons.Rounded.ExpandLess,
            contentDescription = if (collapsed) "展开" else "收起",
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun GroupCard(claims: List<MemoryClaimDto>, onClick: (MemoryClaimDto) -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column {
            claims.forEachIndexed { index, claim ->
                MemoryRow(claim = claim, onClick = { onClick(claim) })
                if (index < claims.lastIndex) {
                    HorizontalDivider(
                        modifier = Modifier.padding(horizontal = 16.dp),
                        thickness = 1.dp,
                        color = MaterialTheme.colorScheme.outlineVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun MemoryRow(claim: MemoryClaimDto, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                claim.summary,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                val confirmed = claim.authority == "user_confirmed"
                MemoryTag(
                    authorityLabel(claim),
                    contentColor = if (confirmed) {
                        MaterialTheme.colorScheme.onPrimaryContainer
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    containerColor = if (confirmed) {
                        MaterialTheme.colorScheme.primaryContainer
                    } else {
                        MaterialTheme.colorScheme.surfaceVariant
                    },
                )
                if (claim.sensitivity == "private") {
                    MemoryTag(
                        "私密",
                        contentColor = MaterialTheme.colorScheme.tertiary,
                        containerColor = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.12f),
                    )
                }
                Text(
                    "更新 ${dateLabel(claim.updatedAt)} · #${shortClaimId(claim.id)}",
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Icon(
            Icons.AutoMirrored.Rounded.KeyboardArrowRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun MemoryTag(text: String, contentColor: Color, containerColor: Color) {
    Text(
        text,
        modifier = Modifier
            .background(containerColor, CircleShape)
            .padding(horizontal = 8.dp, vertical = 2.dp),
        style = MaterialTheme.typography.labelSmall,
        color = contentColor,
    )
}

@Composable
private fun EmptyState(icon: ImageVector, title: String, hint: String) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 30.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(46.dp)
                    .clip(RoundedCornerShape(13.dp))
                    .background(MaterialTheme.colorScheme.primaryContainer),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.size(22.dp),
                )
            }
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(
                hint,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun MemoryDetail(
    claim: MemoryClaimDto,
    onEdit: () -> Unit,
    onForget: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            MemoryTag(
                kindLabel(claim.kind),
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                containerColor = MaterialTheme.colorScheme.primaryContainer,
            )
            val confirmed = claim.authority == "user_confirmed"
            MemoryTag(
                authorityLabel(claim),
                contentColor = if (confirmed) {
                    MaterialTheme.colorScheme.onPrimaryContainer
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                containerColor = if (confirmed) {
                    MaterialTheme.colorScheme.primaryContainer
                } else {
                    MaterialTheme.colorScheme.surfaceVariant
                },
            )
            if (claim.sensitivity == "private") {
                MemoryTag(
                    "私密",
                    contentColor = MaterialTheme.colorScheme.tertiary,
                    containerColor = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.12f),
                )
            }
            Spacer(modifier = Modifier.weight(1f))
            Text(
                "#claim_${shortClaimId(claim.id)}",
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Text(
            claim.summary,
            style = MaterialTheme.typography.titleLarge,
        )

        claim.objectText
            ?.takeIf { it != claim.summary }
            ?.let { objectText ->
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Text(
                        objectText,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MetricTile(
                    label = "置信度",
                    value = "${(claim.confidence * 100).toInt()}%",
                    modifier = Modifier.weight(1f),
                )
                MetricTile(
                    label = "重要度",
                    value = "${(claim.importance * 100).toInt()}%",
                    modifier = Modifier.weight(1f),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MetricTile(
                    label = "更新",
                    value = dateLabel(claim.updatedAt),
                    modifier = Modifier.weight(1f),
                )
                MetricTile(
                    label = "生效",
                    value = validityLabel(claim),
                    modifier = Modifier.weight(1f),
                )
            }
        }

        Text("来源原话", style = MaterialTheme.typography.titleSmall)
        if (claim.evidence.isEmpty()) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
            ) {
                Text(
                    "这条记忆没有可展示的来源。",
                    modifier = Modifier.padding(14.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                claim.evidence.forEach { item ->
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                    ) {
                        Text(
                            "“${item.quote ?: "（无原话）"}”",
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                onClick = onEdit,
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(12.dp),
            ) {
                Icon(Icons.Rounded.Edit, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(modifier = Modifier.width(6.dp))
                Text("改正")
            }
            OutlinedButton(
                onClick = onForget,
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.error.copy(alpha = 0.45f)),
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = MaterialTheme.colorScheme.error,
                ),
            ) {
                Text("忘记")
            }
        }
    }
}

@Composable
private fun MetricTile(label: String, value: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                value,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
