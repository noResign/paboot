package com.noresign.paboot.model.chat

/** 聊天页里一条可渲染的消息（用户 / 助手）。 */
sealed interface ChatUiMessage {
    data class User(val text: String) : ChatUiMessage

    data class Assistant(
        val blocks: List<ContentBlock> = emptyList(),
        val usage: UsageInfo? = null,
        val error: String? = null,
        val done: Boolean = false,
    ) : ChatUiMessage
}
