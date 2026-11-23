package com.noresign.paboot.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.noresign.paboot.model.chat.TodoItem

/**
 * agent 自己的任务清单（TodoWrite），不进对话流。
 *
 * 有未完成项时它会一直挂着——agent 跑一小时就挂一小时，哪怕用户早就不看这段对话了。
 * 所以给一个关闭按钮：用户能主动收起来，不用等 agent 干完；只有清单内容变了才会再出现。
 *
 * @param dismissedSignature 用户收起的那份清单（[todoSignature] 的返回值）；
 *   与当前清单一致时整条隐藏。
 * @param onDismiss 收起当前清单。
 */
@Composable
internal fun TodoListPanel(
    todos: List<TodoItem>,
    running: Boolean,
    expanded: Boolean,
    onToggle: () -> Unit,
    dismissedSignature: String? = null,
    onDismiss: () -> Unit = {},
) {
    if (!showTodoPanel(todos, dismissedSignature)) return
    val completed = todos.count { it.status == "completed" }
    Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
        Column {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
            ) {
                // 除最右边的 ✕ 之外，整条都能点：点它就展开/收起明细。
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .weight(1f)
                        .clickable(onClick = onToggle)
                        .padding(vertical = 8.dp),
                ) {
                    Text(
                        text = "任务列表",
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        text = "$completed/${todos.size}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    // 只用一个箭头表示还能展开/收起，不写字：这一条本来就窄。
                    Icon(
                        imageVector = if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                        contentDescription = if (expanded) "收起明细" else "展开明细",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp),
                    )
                }
                // 与展开是两件事：这个把整条拿走，收起后只有清单内容变了才会再出现。
                IconButton(onClick = onDismiss) {
                    Icon(
                        imageVector = Icons.Rounded.Close,
                        contentDescription = "收起这条待办",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
            if (expanded) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 16.dp, end = 16.dp, bottom = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    todos.forEach { item -> TodoRow(item, running) }
                }
            }
        }
    }
}

@Composable
internal fun TodoRow(item: TodoItem, running: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        when (item.status) {
            "completed" -> Text("✓", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
            "in_progress" -> if (running) {
                CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
            } else {
                Text("●", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
            }
            else -> Text("○", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = item.content,
            style = when (item.status) {
                "completed" -> MaterialTheme.typography.bodyMedium.copy(
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textDecoration = TextDecoration.LineThrough,
                )
                "in_progress" -> MaterialTheme.typography.bodyMedium.copy(
                    fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                )
                else -> MaterialTheme.typography.bodyMedium
            },
        )
    }
}

/**
 * 一份清单的身份 = 它记下的内容，不看每项的状态。
 *
 * 只取 content 是有意的：agent 勾掉一项时用户不想让它又冒出来，
 * 那正是他收起整条的原因；而 agent 换了一份清单才是新信息。
 */
internal fun todoSignature(todos: List<TodoItem>): String = todos.joinToString("\n") { it.content }

/** 这条待办该不该显示。纯函数，便于单测。 */
internal fun showTodoPanel(todos: List<TodoItem>, dismissedSignature: String?): Boolean {
    if (todos.isEmpty()) return false
    // 全完成 = 历史噪音，挂在输入框上方永远说「已完成」。
    if (todos.all { it.status == "completed" }) return false
    if (dismissedSignature != null && dismissedSignature == todoSignature(todos)) return false
    return true
}
