package com.noresign.paboot.navigation

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.rememberNavController
import com.noresign.paboot.data.local.SettingsStore

/**
 * @param pendingSessionId 通知点击要打开的会话。本机已保存连接时冷启动直接以会话列表为起点，
 *   所以通常一进来就能过门禁；只有没存连接、停在连接页时才等连接完成再跳。
 *   用户在任意页面（会话 / 工作区）点通知都应能直接跳过去，不能只在 MAIN 上生效。
 */
@Composable
fun AppNavHost(
    pendingSessionId: String? = null,
    onPendingConsumed: () -> Unit = {},
) {
    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()

    // 已保存连接时冷启动直接以会话列表为起点，不再闪现连接页再跳走（点通知进来尤其明显）。
    // 连接失效不在这里拦：会话列表会显示错误 + 「重试」，改地址 / token 走设置页「重新连接」。
    val startDestination = remember {
        if (!SettingsStore.baseUrl.isNullOrBlank() && !SettingsStore.token.isNullOrBlank()) {
            AppRoutes.MAIN
        } else {
            AppRoutes.CONNECT
        }
    }

    LaunchedEffect(pendingSessionId, backStackEntry?.destination?.route) {
        val target = pendingSessionId?.takeIf { it.isNotBlank() } ?: return@LaunchedEffect
        val route = backStackEntry?.destination?.route ?: return@LaunchedEffect
        if (route == AppRoutes.CONNECT) return@LaunchedEffect
        onPendingConsumed()
        // 已经停在目标会话上就不重复入栈（否则返回键要按两次）
        if (route == AppRoutes.CONVERSATION &&
            backStackEntry?.arguments?.getString("sessionId") == target
        ) {
            return@LaunchedEffect
        }
        navController.navigateToConversation(target)
    }

    NavHost(
        navController = navController,
        startDestination = startDestination,
        // All destination pages share one IME inset owner. Descendant system
        // bar padding sees the consumed inset and does not add it a second time.
        modifier = Modifier.fillMaxSize().imePadding(),
    ) {
        connectNavGraph(navController)
        mainNavGraph(navController)
    }
}
