package com.noresign.paboot.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Dashboard
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Same floating capsule on the main tabs and in a conversation. */
@Composable
internal fun FloatingBottomBar(
    selected: MainTab,
    onSelect: (MainTab) -> Unit,
    composerVisible: Boolean = false,
    onToggle: (() -> Unit)? = null,
    composer: (@Composable () -> Unit)? = null,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 8.dp),
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(28.dp),
            // 对齐 iOS 的 ultraThinMaterial 胶囊：近白半透明 + 细边，而不是灰色 surfaceContainer。
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)),
            shadowElevation = 2.dp,
        ) {
            Row(
                modifier = Modifier.heightIn(min = 56.dp).padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (onToggle != null) {
                    Box(
                        modifier = Modifier
                            .size(48.dp)
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                role = Role.Button,
                                onClick = onToggle,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = if (composerVisible) Icons.Rounded.Dashboard else Icons.Rounded.Edit,
                            contentDescription = if (composerVisible) "切换到导航" else "切换到输入框",
                            modifier = Modifier.size(21.dp),
                        )
                    }
                    Surface(
                        modifier = Modifier.width(1.dp).height(24.dp),
                        color = MaterialTheme.colorScheme.outlineVariant,
                    ) {}
                }
                if (composerVisible && composer != null) {
                    Box(modifier = Modifier.weight(1f).padding(start = 4.dp, end = 2.dp)) {
                        composer()
                    }
                } else {
                    MainTab.entries.forEach { tab ->
                        val active = tab == selected
                        val tint = if (active) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurfaceVariant
                        val interactionSource = remember { MutableInteractionSource() }
                        Column(
                            modifier = Modifier
                                .weight(1f)
                                .selectable(
                                    selected = active,
                                    interactionSource = interactionSource,
                                    indication = null,
                                    role = Role.Tab,
                                    onClick = { onSelect(tab) },
                                )
                                .padding(vertical = 5.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            Icon(tab.icon, contentDescription = tab.label, tint = tint, modifier = Modifier.size(20.dp))
                            Text(
                                tab.label,
                                color = tint,
                                fontSize = 11.sp,
                                // iOS 选中只变主色、不加粗——保持一致，避免切换时文字跳动。
                                fontWeight = FontWeight.Medium,
                            )
                        }
                    }
                }
            }
        }
    }
}
