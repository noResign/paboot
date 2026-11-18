package com.noresign.paboot.network.daemon

import com.noresign.paboot.network.daemon.dto.SessionEventDto

/**
 * `GET /api/sessions/:id/events` 的业务事件。流本身不持久化；重连后以
 * [SessionEventDto.State] 快照为准，所以这里不需要 `seq` 游标。
 */
sealed interface SessionWatchEvent {
    data class Event(val event: SessionEventDto) : SessionWatchEvent

    /** 连接/协议失败；[httpCode] 为 null 表示传输层失败（断网、超时）。 */
    data class Failed(
        val message: String,
        val httpCode: Int? = null,
        val apiCode: String? = null,
    ) : SessionWatchEvent

    /** 服务端正常结束（会话被删 / daemon 关闭）。 */
    data object Closed : SessionWatchEvent
}
