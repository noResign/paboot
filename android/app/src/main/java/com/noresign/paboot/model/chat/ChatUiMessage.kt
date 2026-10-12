package com.noresign.paboot.model.chat

/** 聊天页里一条可渲染的消息（用户 / 助手）。 */
sealed interface ChatUiMessage {
    /** [runId] 由这次发送触发的 run；用于把「回滚到这次之前」挂在这条消息上。 */
    data class User(val text: String, val runId: String? = null) : ChatUiMessage

    data class Assistant(
        val blocks: List<ContentBlock> = emptyList(),
        val usage: UsageInfo? = null,
        val error: String? = null,
        val done: Boolean = false,
    ) : ChatUiMessage
}
