package com.noresign.paboot.ui.theme

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/**
 * 品牌渐变（docs/ui/shared/design-principles.md §4.1.1）：linear-gradient(135deg, #0E9F86 → #18C9A6)。
 * 仅用于 Logo、FAB、主 CTA 焦点态、连接页 hero 点缀，不滥用。
 */
object Brand {

    val Start = Color(0xFF0E9F86)
    val End = Color(0xFF18C9A6)

    /** 135°（左上→右下）渐变。 */
    val Gradient: Brush = Brush.linearGradient(
        colors = listOf(Start, End),
        start = Offset.Zero,
        end = Offset.Infinite,
    )
}
