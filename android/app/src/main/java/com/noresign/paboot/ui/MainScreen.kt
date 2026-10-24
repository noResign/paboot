package com.noresign.paboot.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChatBubble
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector

internal enum class MainTab(val label: String, val icon: ImageVector) {
    Sessions("会话", Icons.Rounded.ChatBubble),
    Files("文件", Icons.Rounded.Folder),
    Tasks("任务", Icons.Rounded.Schedule),
    Settings("设置", Icons.Rounded.Settings),
}

/**
 * Main tabs share the same floating navigation capsule as conversations.
 */
@Composable
fun MainScreen(
    onOpenSession: (String) -> Unit,
    onNewSession: () -> Unit,
    onReconnect: () -> Unit,
    onManageWorkspaces: () -> Unit,
) {
    var selectedTab by rememberSaveable { mutableStateOf(MainTab.Sessions) }

    Scaffold(
        bottomBar = { FloatingBottomBar(selected = selectedTab, onSelect = { selectedTab = it }) },
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(top = innerPadding.calculateTopPadding())
                // Draw the pages behind the floating capsule. Their scrollable content
                // adds the bottom inset so the final row remains reachable.
                .consumeWindowInsets(innerPadding),
        ) {
            when (selectedTab) {
                MainTab.Sessions -> SessionListScreen(
                    onOpenSession = onOpenSession,
                    onNewSession = onNewSession,
                    onReconnect = onReconnect,
                    bottomOverlayPadding = innerPadding.calculateBottomPadding(),
                )
                MainTab.Files -> FilesScreen(bottomOverlayPadding = innerPadding.calculateBottomPadding())
                MainTab.Tasks -> TasksScreen(
                    onOpenSession = onOpenSession,
                    bottomOverlayPadding = innerPadding.calculateBottomPadding(),
                )
                MainTab.Settings -> SettingsScreen(
                    onReconnect = onReconnect,
                    onManageWorkspaces = onManageWorkspaces,
                    bottomOverlayPadding = innerPadding.calculateBottomPadding(),
                )
            }
        }
    }
}
