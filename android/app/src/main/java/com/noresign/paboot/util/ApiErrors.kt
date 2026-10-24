package com.noresign.paboot.util

import com.noresign.paboot.network.http.NetworkResult

/**
 * daemon 错误 → 可直接展示的中文文案。
 *
 * 优先按 `apiCode`（daemon `ApiError.code`）做精确映射，未命中再退回 HTTP 状态码 / 网络层
 * 错误码。各 ViewModel 统一走这里，不要再各写一份 `when (code)`。
 */
fun friendlyError(error: NetworkResult.Error, fallbackPrefix: String = "请求失败"): String =
    friendlyMessage(error.apiCode, error.code, error.message, fallbackPrefix)

/**
 * 同一张表的原始字段入口。
 *
 * SSE 失败路径拿不到 [NetworkResult.Error]（见 `ChatStreamEvent.Failed`），只有
 * `(apiCode, httpCode, message)`；两边文案必须一致，所以共用这一个 `when`。
 *
 * `/api/chat` 的前置校验全部在 SSE 响应头之前返回，只能以非 2xx 正文的形式到达客户端，
 * 所以下面这组 code 是聊天页最常见的失败原因。
 *
 * @param httpCode HTTP 状态码；网络不可达为 -1，其他异常为 -2。
 */
fun friendlyMessage(
    apiCode: String?,
    httpCode: Int?,
    message: String,
    fallbackPrefix: String = "请求失败",
): String = when (apiCode) {
    // 工作区
    "workspace_exists" -> "该目录已经是工作区了"
    "workspace_not_empty" -> "该工作区还有会话，请勾选「同时删除会话」后再删"
    "workspace_is_default" -> "默认工作区不能删除，请先把另一个工作区设为默认"
    "workspace_disabled" -> "该工作区已停用"
    "directory_not_found" -> "目录不存在或已被删除"
    "not_a_directory" -> "所选路径不是文件夹"
    "directory_not_accessible" -> "目录无法访问（权限不足）"
    "shortcut_exists" -> "该目录已经在 tab 上了"
    "dir_exists" -> "该目录已在本工作区的附加目录里"
    "primary_dir" -> "该目录已经是工作区主目录了"

    // 会话与 runtime
    "runtime_unavailable" -> "该 Agent 未安装或不在 PATH 上，请在电脑端确认"
    "unknown_runtime" -> "未知的 Agent 类型"
    "runtime_mismatch" -> "该会话属于另一个 Agent，不能换 Agent 继续"
    "session_not_found" -> "会话不存在或已被删除"
    "workspace_not_found" -> "工作区不存在或已被删除"
    "cwd_not_allowed" -> "会话目录不在当前工作区内"
    "claude_session_not_found" -> "找不到该 Claude 本机会话"
    "prompt_required" -> "请输入内容"
    "internal_error" -> "daemon 内部错误，请查看 daemon 日志"
    // 审批
    "bad_response" -> "回答不符合要求：$message"
    "permission_resolved" -> "该请求已经处理过了"
    "permission_not_found" -> "该请求已失效，可能已超时或运行已结束"
    "bad_decision" -> "无效的审批决定"

    // 定时任务
    "schedule_invalid" -> "定时计划无效：$message"
    "task_limit_reached" -> "定时任务数量已达上限"
    "task_not_found" -> "定时任务不存在或已被删除"
    "session_busy" -> "该会话正在运行，请稍后再试"
    "session_deleted" -> "绑定的会话已删除，请重新创建任务"
    "recursion_blocked" -> "定时触发的运行不能再创建定时任务"
    "disabled" -> "任务已停用"

    else -> when (httpCode) {
        401 -> "token 无效或未授权（401）"
        -1 -> "无法连接 daemon，请检查网络与地址"
        else -> "$fallbackPrefix：$message"
    }
}
