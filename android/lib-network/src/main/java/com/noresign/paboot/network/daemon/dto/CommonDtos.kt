package com.noresign.paboot.network.daemon.dto

import kotlinx.serialization.Serializable

/** paboot daemon wire 模型——健康探测与通用请求/响应。与 `daemon/src/types/api.ts` 对齐。 */

/** `GET /api/health` —— 无需鉴权的可达性探测。 */
@Serializable
data class HealthResponse(
    val ok: Boolean = false,
    val service: String? = null,
    val version: String? = null,
    /** daemon 主 workspace 根目录（用于会话列表默认展开当前 workspace）。 */
    val workspace: String? = null,
    /**
     * daemon 自己的稳定身份（首次启动生成、落在它的库里）。
     * 用来判断「同一个地址换了个写法」是不是同一台 daemon：`127.0.0.1:4780` 与局域网 IP 是同一台。
     * 老 daemon 不发这个字段，缺省即「未知」，不能当成「另一台」。
     */
    val serverId: String? = null,
)

/** 通用 `{ok, ...}` 响应（删除/取消/审批等）。 */
@Serializable
data class OkResponse(
    val ok: Boolean = false,
)

@Serializable
data class RenameRequest(
    val title: String,
)

@Serializable
data class RenameResponse(
    val ok: Boolean = false,
    val session: SessionDto? = null,
)
