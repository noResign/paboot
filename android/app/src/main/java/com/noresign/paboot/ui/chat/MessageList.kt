package com.noresign.paboot.ui.chat

import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.noresign.paboot.model.chat.AssistantSegment
import com.noresign.paboot.model.chat.ChatUiMessage
import com.noresign.paboot.model.chat.ContentBlock
import com.noresign.paboot.model.chat.segmentBlocks
import kotlinx.coroutines.launch

@Composable
internal fun MessageList(
    messages: List<ChatUiMessage>,
    streaming: Boolean,
    loading: Boolean,
    onAnswer: (String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    // 末尾占位 item 的 index，用来「滚到底」（滚到它 = 最后一条消息底部贴屏幕底）
    val bottomIndex = messages.size

    // 跟随状态：true = 在底部跟随，false = 用户上滑离开底部后停止
    var followBottom by remember { mutableStateOf(true) }
    // 是否显示「回到底部」按钮（用户离开底部后显示）
    var showJumpToBottom by remember { mutableStateOf(false) }

    // 只在用户拖动结束（DragInteraction.Stop）时更新状态；跟随动画不产生 DragInteraction。
    // 用 canScrollForward 精确判断在不在最底；差几像素没到底时，靠「回到底部」按钮兜底。
    LaunchedEffect(Unit) {
        listState.interactionSource.interactions.collect { interaction ->
            if (interaction is DragInteraction.Stop) {
                val atBottom = !listState.canScrollForward
                followBottom = atBottom
                showJumpToBottom = !atBottom
            }
        }
    }

    // 新消息（user + assistant 一起追加）→ 跳到底并恢复跟随
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            listState.scrollToItem(bottomIndex)
            followBottom = true
            showJumpToBottom = false
        }
    }

    // 流式内容增长 → 跟随状态下平滑滚到底
    val lastContentLen = (messages.lastOrNull() as? ChatUiMessage.Assistant)?.blocks?.sumOf { block ->
        when (block) {
            is ContentBlock.Text -> block.text.length
            is ContentBlock.Thinking -> block.text.length
            is ContentBlock.ToolUse -> (block.result?.length ?: 0) + 1
            is ContentBlock.Question -> 1
        }
    } ?: 0
    LaunchedEffect(lastContentLen) {
        if (followBottom && messages.isNotEmpty()) {
            listState.animateScrollToItem(bottomIndex)
        }
    }

    Box(modifier = modifier) {
        if (loading && messages.isEmpty()) {
            // 重建历史要按 run 逐个回放事件，会话越长越慢；这段时间别留空白页。
            Column(
                modifier = Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 3.dp)
                Spacer(Modifier.height(12.dp))
                Text(
                    text = "正在加载对话…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LazyColumn(
                state = listState,
                reverseLayout = false,
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(
                    count = messages.size,
                    key = { index -> index },
                ) { index ->
                    when (val message = messages[index]) {
                        is ChatUiMessage.User -> UserBubble(message.text)
                        is ChatUiMessage.Assistant -> AssistantBlock(message, streaming, onAnswer)
                    }
                }
                item(key = "bottom-spacer") {
                    Spacer(Modifier.height(1.dp))
                }
            }
        }
        if (showJumpToBottom) {
            SmallFloatingActionButton(
                onClick = {
                    followBottom = true
                    showJumpToBottom = false
                    scope.launch { listState.scrollToItem(bottomIndex) }
                },
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(16.dp),
            ) {
                Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "回到底部")
            }
        }
    }
}

@Composable
internal fun UserBubble(text: String) {
    Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.widthIn(max = 300.dp),
        ) {
            Text(
                text = text,
                color = MaterialTheme.colorScheme.onPrimary,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            )
        }
    }
}

@Composable
internal fun AssistantBlock(
    message: ChatUiMessage.Assistant,
    streaming: Boolean,
    onAnswer: (String, String) -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val segments = remember(message.blocks) { segmentBlocks(message.blocks) }
        segments.forEach { segment ->
            when (segment) {
                is AssistantSegment.Thinking -> ThinkingBlock(segment.text)
                is AssistantSegment.Text -> TextBlock(segment.text, streaming = !message.done)
                is AssistantSegment.ToolGroup -> ToolGroupView(segment.tools)
                is AssistantSegment.Question -> QuestionCard(segment.block, streaming, onAnswer)
            }
        }
        if (message.error != null) {
            Text(
                text = message.error,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }
        if (message.done && message.blocks.isEmpty() && message.error == null) {
            Text(
                text = "（无回复）",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        message.usage?.let { UsageLine(it) }
    }
}
