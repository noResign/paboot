package com.noresign.paboot.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.noresign.paboot.model.chat.ContentBlock
import com.noresign.paboot.network.daemon.dto.QuestionDto

@Composable
internal fun QuestionCard(
    block: ContentBlock.Question,
    streaming: Boolean,
    onAnswer: (String, String) -> Unit,
) {
    // 每个问题的选中状态：问题下标 → 已选 label 集合（流式中也能预选，本地状态）
    val selections = remember(block.toolUseId) { mutableStateMapOf<Int, Set<String>>() }
    // 「其他」：选项都不合适时自己输入，按问题进行。
    val otherActive = remember(block.toolUseId) { mutableStateMapOf<Int, Boolean>() }
    val otherTexts = remember(block.toolUseId) { mutableStateMapOf<Int, String>() }

    fun selected(i: Int): Set<String> = selections[i] ?: emptySet()
    fun isOtherActive(i: Int): Boolean = otherActive[i] == true
    fun otherText(i: Int): String = otherTexts[i]?.trim().orEmpty()

    val allAnswered = block.questions.indices.all { i ->
        selected(i).isNotEmpty() || (isOtherActive(i) && otherText(i).isNotEmpty())
    }
    val anyOtherActive = block.questions.indices.any { isOtherActive(it) }

    // 只有「纯选项」才自动提交；出现「其他」时必须点按钮，避免边输入边发送。
    // builtin 的阻塞式提问在 run 运行中就要回答（permissionId 非空）；
    // Claude 等 headless runtime 必须等本轮结束，答案才能作为下一条消息发出。
    val blocking = block.permissionId != null
    LaunchedEffect(streaming, allAnswered, anyOtherActive, block.answered, blocking) {
        if (allAnswered && !anyOtherActive && !block.answered && (blocking || !streaming)) {
            onAnswer(
                block.toolUseId,
                buildAnswerText(block.questions, selections, otherActive, otherTexts),
            )
        }
    }

    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            block.questions.forEachIndexed { i, q ->
                QuestionItem(
                    question = q,
                    selected = selected(i),
                    enabled = !block.answered,
                    otherActive = isOtherActive(i),
                    otherText = otherTexts[i].orEmpty(),
                    onToggle = { label ->
                        val cur = selected(i)
                        selections[i] = if (q.multiSelect) {
                            if (label in cur) cur - label else cur + label
                        } else {
                            otherActive[i] = false
                            setOf(label)
                        }
                    },
                    onToggleOther = {
                        if (q.multiSelect) {
                            otherActive[i] = !isOtherActive(i)
                        } else {
                            selections[i] = emptySet()
                            otherActive[i] = true
                        }
                    },
                    onOtherTextChange = { otherTexts[i] = it },
                )
            }
            if (block.answered) {
                Text(
                    text = "已发送答案",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else if (anyOtherActive) {
                OutlinedButton(
                    onClick = {
                        onAnswer(
                            block.toolUseId,
                            buildAnswerText(block.questions, selections, otherActive, otherTexts),
                        )
                    },
                    enabled = allAnswered,
                ) { Text("发送答案") }
                if (!allAnswered) {
                    Text(
                        text = "请先填写或选择每个问题的答案",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else if (block.questions.size > 1 && !allAnswered) {
                Text(
                    text = "还有问题未选择",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
internal fun QuestionItem(
    question: QuestionDto,
    selected: Set<String>,
    enabled: Boolean,
    otherActive: Boolean,
    otherText: String,
    onToggle: (String) -> Unit,
    onToggleOther: () -> Unit,
    onOtherTextChange: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val header = question.header
        if (!header.isNullOrBlank()) {
            Text(
                text = header,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        Text(
            text = question.question,
            style = MaterialTheme.typography.titleSmall,
        )
        question.options.forEach { opt ->
            OptionRow(
                label = opt.label,
                description = opt.description,
                checked = opt.label in selected,
                multiSelect = question.multiSelect,
                enabled = enabled,
                onClick = { onToggle(opt.label) },
            )
        }
        OptionRow(
            label = "其他",
            description = "自己输入答案",
            checked = otherActive,
            multiSelect = question.multiSelect,
            enabled = enabled,
            onClick = onToggleOther,
        )
        if (otherActive) {
            OutlinedTextField(
                value = otherText,
                onValueChange = onOtherTextChange,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 48.dp),
                enabled = enabled,
                placeholder = { Text("输入你的答案") },
                maxLines = 4,
            )
        }
    }
}

@Composable
internal fun OptionRow(
    label: String,
    description: String?,
    checked: Boolean,
    multiSelect: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick),
    ) {
        if (multiSelect) {
            Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        } else {
            RadioButton(selected = checked, onClick = null, enabled = enabled)
        }
        OptionLabel(label, description)
    }
}

@Composable
internal fun OptionLabel(label: String, description: String?) {
    Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        if (!description.isNullOrBlank()) {
            Text(
                text = description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

internal fun buildAnswerText(
    questions: List<QuestionDto>,
    selections: Map<Int, Set<String>>,
    otherActive: Map<Int, Boolean> = emptyMap(),
    otherTexts: Map<Int, String> = emptyMap(),
): String =
    questions.mapIndexed { i, q ->
        val parts = (selections[i] ?: emptySet()).toMutableList()
        if (otherActive[i] == true) {
            val custom = otherTexts[i]?.trim().orEmpty()
            if (custom.isNotEmpty()) parts += "其他：$custom"
        }
        "关于「${q.question}」，我的选择是：${parts.joinToString("、")}"
    }.joinToString("\n")
