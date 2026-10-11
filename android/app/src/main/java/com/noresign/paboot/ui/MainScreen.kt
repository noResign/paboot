package com.noresign.paboot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChatBubble
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private enum class MainTab(val label: String, val icon: ImageVector) {
    Sessions("会话", Icons.Rounded.ChatBubble),
    Files("文件", Icons.Rounded.Folder),
    Settings("设置", Icons.Rounded.Settings),
}

/**
 * 底部 Tab Bar，尺寸对齐 `docs/ui/mobile/preview.html` 的紧凑稿（icon 24dp + label 10.5sp，
 * 条高约 61dp + 系统导航栏 inset）。
 *
 * 没有用 Material3 的 `NavigationBar`：它固定 80dp 高且不暴露高度参数，压不到预览稿的尺寸。
 */
@Composable
private fun MainBottomBar(selected: MainTab, onSelect: (MainTab) -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .windowInsetsPadding(WindowInsets.navigationBars),
    ) {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 5.dp, start = 8.dp, end = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            MainTab.entries.forEach { tab ->
                val active = tab == selected
                val tint = if (active) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                }
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(12.dp))
                        .selectable(selected = active, role = Role.Tab, onClick = { onSelect(tab) })
                        .padding(top = 7.dp, bottom = 9.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Icon(
                        imageVector = tab.icon,
                        contentDescription = tab.label,
                        tint = tint,
                        modifier = Modifier.size(24.dp),
                    )
                    Text(
                        text = tab.label,
                        color = tint,
                        fontSize = 10.5.sp,
                        fontWeight = if (active) FontWeight.Bold else FontWeight.Medium,
                    )
                }
            }
        }
    }
}

/**
 * 主界面：底部 Tab Bar 容器（会话 / 文件 / 设置），对应 docs/ui/shared/design-principles.md §3。
 * 聊天详情是 push 页（在 MAIN 之上），进入后本容器（含 Tab）隐藏。
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
        bottomBar = { MainBottomBar(selected = selectedTab, onSelect = { selectedTab = it }) },
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                // 各 Tab 页自带 Scaffold + TopAppBar，会再吃一次系统栏 inset；
                // 这里声明已被本层消化，否则顶部多一条状态栏高度的空白、底栏上方也多一段空隙。
                .consumeWindowInsets(innerPadding),
        ) {
            when (selectedTab) {
                MainTab.Sessions -> SessionListScreen(
                    onOpenSession = onOpenSession,
                    onNewSession = onNewSession,
                    onReconnect = onReconnect,
                )
                MainTab.Files -> FilesScreen()
                MainTab.Settings -> SettingsScreen(
                    onReconnect = onReconnect,
                    onManageWorkspaces = onManageWorkspaces,
                )
            }
        }
    }
}
