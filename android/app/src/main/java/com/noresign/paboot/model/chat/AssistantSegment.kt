package com.noresign.paboot.model.chat

/**
 * 助手消息里的一段渲染单元。连续的工具调用合成一个 [ToolGroup]——一个 run 常在两句正文之间
 * 打十几个工具调用，逐张卡片渲染会把正文埋掉。断组点是真正插入的正文/提问，不是计时器。
 */
sealed interface AssistantSegment {
    data class Text(val text: String) : AssistantSegment

    data class Thinking(val active: Boolean) : AssistantSegment

    data class ToolGroup(val tools: List<ContentBlock.ToolUse>) : AssistantSegment

    data class Question(val block: ContentBlock.Question) : AssistantSegment
}

/** 把扁平的 blocks 折成段：相邻 ToolUse 归为一组，Text/Thinking/Question 断组。 */
fun segmentBlocks(blocks: List<ContentBlock>): List<AssistantSegment> {
    val segments = mutableListOf<AssistantSegment>()
    val group = mutableListOf<ContentBlock.ToolUse>()

    fun flush() {
        if (group.isEmpty()) return
        segments += AssistantSegment.ToolGroup(group.toList())
        group.clear()
    }

    for (block in blocks) {
        when (block) {
            is ContentBlock.ToolUse -> group += block
            is ContentBlock.Text -> {
                flush()
                segments += AssistantSegment.Text(block.text)
            }
            is ContentBlock.Thinking -> {
                flush()
                segments += AssistantSegment.Thinking(block.active)
            }
            is ContentBlock.Question -> {
                flush()
                segments += AssistantSegment.Question(block)
            }
        }
    }
    flush()
    return segments
}

/** `12 个工具调用 · Write, Bash, Read…` */
fun describeToolGroup(tools: List<ContentBlock.ToolUse>): String {
    val names = mutableListOf<String>()
    for (tool in tools) if (tool.name !in names) names += tool.name
    val shown = names.take(3).joinToString(", ")
    val suffix = if (names.size > 3) "…" else ""
    return "${tools.size} 个工具调用 · $shown$suffix"
}
