package com.noresign.paboot.model.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantSegmentTest {
    private fun tool(id: String, name: String = "Bash") = ContentBlock.ToolUse(id = id, name = name)

    private fun kind(segment: AssistantSegment): String = when (segment) {
        is AssistantSegment.Text -> "text"
        is AssistantSegment.Thinking -> "thinking"
        is AssistantSegment.ToolGroup -> "tools"
        is AssistantSegment.Question -> "question"
    }

    @Test
    fun `consecutive tools fold into one group`() {
        val segments = segmentBlocks(listOf(tool("1"), tool("2"), tool("3")))
        assertEquals(1, segments.size)
        val group = segments[0] as AssistantSegment.ToolGroup
        assertEquals(listOf("1", "2", "3"), group.tools.map { it.id })
    }

    @Test
    fun `text and thinking break the group`() {
        val segments = segmentBlocks(
            listOf(
                tool("1"),
                ContentBlock.Text("hi"),
                tool("2"),
                ContentBlock.Thinking(active = false),
                tool("3"),
            ),
        )
        assertEquals(listOf("tools", "text", "tools", "thinking", "tools"), segments.map(::kind))
    }

    @Test
    fun `question breaks the group and is kept whole`() {
        val question = ContentBlock.Question(toolUseId = "q1", questions = emptyList())
        val segments = segmentBlocks(listOf(tool("1"), question))
        assertEquals(listOf("tools", "question"), segments.map(::kind))
        assertEquals(question, (segments[1] as AssistantSegment.Question).block)
    }

    @Test
    fun `empty blocks produce no segments`() {
        assertTrue(segmentBlocks(emptyList()).isEmpty())
    }

    @Test
    fun `describeToolGroup dedupes names and caps at three`() {
        val tools = listOf(
            tool("1", "Write"),
            tool("2", "Bash"),
            tool("3", "Read"),
            tool("4", "Bash"),
            tool("5", "Grep"),
        )
        assertEquals("5 个工具调用 · Write, Bash, Read…", describeToolGroup(tools))
    }
}
