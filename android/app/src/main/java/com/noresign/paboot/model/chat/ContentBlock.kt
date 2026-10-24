package com.noresign.paboot.model.chat

import com.noresign.paboot.network.daemon.dto.QuestionDto
import kotlinx.serialization.json.JsonElement

/** 助手消息里的一段有序内容块，按 Claude 实际返回的顺序排列。 */
sealed interface ContentBlock {
    /**
     * 思考卡片。运行时不下发思考正文，所以卡片只保留「正在思考」状态：
     * [active] 为 true 时标题行转圈，展开后没有内容。
     */
    data class Thinking(val active: Boolean = true) : ContentBlock

    data class Text(val text: String) : ContentBlock

    data class ToolUse(
        val id: String,
        val name: String,
        val input: JsonElement? = null,
        val result: String? = null,
        val isError: Boolean = false,
        /** 工具没跑完 run 就结束了（取消 / 崩溃 / 空闲超时），与"失败"区分展示。 */
        val interrupted: Boolean = false,
        val running: Boolean = true,
    ) : ContentBlock

    data class Question(
        val toolUseId: String,
        val questions: List<QuestionDto>,
        val answered: Boolean = false,
    ) : ContentBlock
}
