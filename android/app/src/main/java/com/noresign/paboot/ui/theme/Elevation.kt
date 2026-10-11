package com.noresign.paboot.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * 三层阴影 token（docs/ui/shared/design-principles.md §4.1.1）。
 *
 * CSS 参考值：
 * - elevation1（卡片）      : 0 1px 2px  rgba(22,33,29,.06)
 * - elevation2（悬浮/Sheet）: 0 8px 24px rgba(22,33,29,.10)
 * - elevation3（全屏浮层）  : 0 16px 48px rgba(22,33,29,.18)
 *
 * Compose 的 Modifier.shadow 用 elevation + 颜色近似表达；这里提供三层高度与统一阴影色，
 * UI 层用 `Modifier.shadow(elevation = DesignElevation.Level2, shape = …, ambientColor = …, spotColor = …)`。
 */
object DesignElevation {

    /** 阴影色（深绿黑），建议 0.10 透明度；重阴影可叠加透明度。 */
    val ShadowColor = Color(0x1A16211D) // rgba(22,33,29,.10)

    val Level1 = 1.dp   // 卡片
    val Level2 = 8.dp   // 悬浮 / Sheet
    val Level3 = 16.dp  // 全屏浮层 / 审批弹窗
}
