package com.noresign.paboot.navigation

import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavType
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import com.noresign.paboot.ui.ChatScreen
import com.noresign.paboot.ui.MainScreen
import com.noresign.paboot.ui.WorkspaceManagementScreen

fun NavGraphBuilder.mainNavGraph(navController: NavController) {
    composable(AppRoutes.MAIN) {
        MainScreen(
            onOpenSession = { id -> navController.navigateToConversation(id) },
            onNewSession = { navController.navigateToConversation(null) },
            onReconnect = { navController.navigateToConnect() },
            onManageWorkspaces = { navController.navigateToWorkspaces() },
        )
    }

    composable(AppRoutes.WORKSPACES) {
        WorkspaceManagementScreen(onBack = { navController.popBackStack() })
    }

    composable(
        route = AppRoutes.CONVERSATION,
        arguments = listOf(
            navArgument("sessionId") {
                type = NavType.StringType
                nullable = true
                defaultValue = null
            }
        ),
    ) { entry ->
        val sessionId = entry.arguments?.getString("sessionId")
        ChatScreen(
            sessionId = sessionId,
            onBack = { navController.popBackStack() },
            onReconnect = { navController.navigateToConnect() },
            onManageWorkspaces = { navController.navigateToWorkspaces() },
            onOpenSession = { id -> navController.navigateToConversation(id) },
        )
    }
}
