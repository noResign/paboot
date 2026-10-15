package com.noresign.paboot.model.connect

/**
 * 连通性检查的组合结果：daemon 可达（health ok）且 token 有效（sessions 拉取成功）。
 * 非线上 DTO，仅用于连接页内部。
 */
data class ConnectResponse(
    val service: String,
    val version: String,
    val sessionCount: Int,
    val workspace: String? = null,
    /** daemon 的身份（`/api/health` 的 `serverId`）；老 daemon 为 null。 */
    val serverId: String? = null,
)
