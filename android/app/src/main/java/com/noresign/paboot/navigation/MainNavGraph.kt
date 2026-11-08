package com.noresign.paboot.navigation

import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavType
import androidx.compose.runtime.remember
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import com.noresign.paboot.ui.ChatScreen
import com.noresign.paboot.ui.KnowledgeScreen
import com.noresign.paboot.ui.MainScreen
import com.noresign.paboot.ui.MemoryScreen
import com.noresign.paboot.ui.ProviderManagementScreen
import com.noresign.paboot.ui.WorkspaceManagementScreen
import com.noresign.paboot.ui.WorkspaceOverviewScreen
import com.noresign.paboot.viewmodel.SessionListViewModel

fun NavGraphBuilder.mainNavGraph(navController: NavController) {
    composable(AppRoutes.MAIN) {
        MainScreen(
            onOpenSession = { id -> navController.navigateToConversation(id) },
            onNewSession = { navController.navigateToConversation(null) },
            onReconnect = { navController.navigateToConnect() },
            onManageWorkspaces = { navController.navigateToWorkspaces() },
            onManageProviders = { navController.navigateToProviders() },
            onOpenWorkspaceOverview = { id -> navController.navigateToWorkspaceOverview(id) },
        )
    }

    composable(
        route = AppRoutes.WORKSPACE_OVERVIEW,
        arguments = listOf(navArgument("workspaceId") { type = NavType.StringType }),
    ) { entry ->
        val workspaceId = entry.arguments?.getString("workspaceId").orEmpty()
        // Reuse the main tab's VM so the overview reads the same workspace list
        // and session counts without a second network round trip.
        val mainEntry = remember(entry) { navController.getBackStackEntry(AppRoutes.MAIN) }
        val sessionViewModel: SessionListViewModel = viewModel(viewModelStoreOwner = mainEntry)
        WorkspaceOverviewScreen(
            workspaceId = workspaceId,
            viewModel = sessionViewModel,
            onBack = { navController.popBackStack() },
            onOpenKnowledge = { id -> navController.navigateToKnowledge(id) },
            onOpenMemory = { id -> navController.navigateToMemory(id) },
        )
    }

    composable(
        route = AppRoutes.MEMORY,
        arguments = listOf(navArgument("workspaceId") { type = NavType.StringType }),
    ) { entry ->
        val workspaceId = entry.arguments?.getString("workspaceId").orEmpty()
        MemoryScreen(
            workspaceId = workspaceId,
            onBack = { navController.popBackStack() },
        )
    }

    composable(
        route = AppRoutes.KNOWLEDGE,
        arguments = listOf(navArgument("workspaceId") { type = NavType.StringType }),
    ) { entry ->
        val workspaceId = entry.arguments?.getString("workspaceId").orEmpty()
        KnowledgeScreen(
            workspaceId = workspaceId,
            onBack = { navController.popBackStack() },
        )
    }

    composable(AppRoutes.WORKSPACES) {
        WorkspaceManagementScreen(onBack = { navController.popBackStack() })
    }

    composable(AppRoutes.PROVIDERS) {
        ProviderManagementScreen(onBack = { navController.popBackStack() })
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
            onManageProviders = { navController.navigateToProviders() },
            onOpenSession = { id -> navController.navigateToConversation(id) },
        )
    }
}
