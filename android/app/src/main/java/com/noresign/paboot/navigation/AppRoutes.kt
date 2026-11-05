package com.noresign.paboot.navigation

import android.net.Uri
import androidx.navigation.NavController

object AppRoutes {

    const val CONNECT = "connect"
    const val MAIN = "main"
    const val WORKSPACES = "workspaces"
    const val PROVIDERS = "providers"

    /** Read-only workspace overview. A full page, not a bottom sheet. */
    const val WORKSPACE_OVERVIEW = "workspace_overview/{workspaceId}"

    /** K0 knowledge list/detail. A full page, not a bottom sheet. */
    const val KNOWLEDGE = "knowledge/{workspaceId}"

    /** 聊天详情；`sessionId` 为空 = 新会话。 */
    const val CONVERSATION = "conversation?sessionId={sessionId}"

    fun conversation(sessionId: String?): String =
        if (sessionId.isNullOrBlank()) "conversation" else "conversation?sessionId=$sessionId"

    fun workspaceOverview(workspaceId: String): String =
        "workspace_overview/${Uri.encode(workspaceId)}"

    fun knowledge(workspaceId: String): String =
        "knowledge/${Uri.encode(workspaceId)}"
}

fun NavController.navigateToMain() {
    navigate(AppRoutes.MAIN) {
        popUpTo(AppRoutes.CONNECT) { inclusive = true }
    }
}

fun NavController.navigateToConversation(sessionId: String?) {
    navigate(AppRoutes.conversation(sessionId))
}

fun NavController.navigateToConnect() {
    navigate(AppRoutes.CONNECT) {
        // 清掉 MAIN 及其之上的返回栈，回到连接门禁
        popUpTo(AppRoutes.MAIN) { inclusive = true }
    }
}

fun NavController.navigateToWorkspaces() {
    navigate(AppRoutes.WORKSPACES)
}

fun NavController.navigateToProviders() {
    navigate(AppRoutes.PROVIDERS)
}

fun NavController.navigateToWorkspaceOverview(workspaceId: String) {
    navigate(AppRoutes.workspaceOverview(workspaceId))
}

fun NavController.navigateToKnowledge(workspaceId: String) {
    navigate(AppRoutes.knowledge(workspaceId))
}
