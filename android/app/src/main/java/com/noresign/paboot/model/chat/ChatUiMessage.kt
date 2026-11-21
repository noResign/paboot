package com.noresign.paboot.model.chat

/** 聊天页里一条可渲染的消息（用户 / 助手）。 */
sealed interface ChatUiMessage {
    /** [at] is the send time (epoch ms); 0 when an old history has none. */
    data class User(
        val text: String,
        val at: Long = 0,
        val attachmentIds: List<String> = emptyList(),
    ) : ChatUiMessage

    data class Assistant(
        val blocks: List<ContentBlock> = emptyList(),
        val usage: UsageInfo? = null,
        val error: String? = null,
        val done: Boolean = false,
        /**
         * 谁说的。`null` = 未知（老 daemon 的历史消息，或单聊里唯一的那个）。
         *
         * 群聊里同一个会话有多个助手，时间线靠它区分发言人 —— 不分栏、不分标签页
         * （时间线是唯一事实，切开会打断因果）。
         */
        val agentId: String? = null,
        /** 显示用的名字；由会话成员列表解析，避免每条消息带一份。 */
        val agentName: String? = null,
    ) : ChatUiMessage
}
