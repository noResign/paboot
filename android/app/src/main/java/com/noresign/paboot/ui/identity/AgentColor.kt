package com.noresign.paboot.ui.identity

import androidx.compose.ui.graphics.Color

/**
 * 一个助手（agent）的稳定标识色。
 *
 * 按 **id** 散列，不按名字：改名不该换颜色，否则用户会以为是另一个助手。
 * 时间线发言人、助手 tab 的色点都用它 —— 同一个助手在任何界面颜色一致。
 *
 * 与 iOS / Desktop 用同一套调色板与算法，三端颜色对得上。
 */
internal fun agentColor(id: String): Color {
    val palette = listOf(
        Color(0xFF5B8DEF), // 蓝
        Color(0xFF14B8A6), // 青
        Color(0xFFF59E0B), // 橙
        Color(0xFFEC4899), // 粉
        Color(0xFF8B5CF6), // 紫
        Color(0xFF10B981), // 绿
    )
    val hash = id.fold(0) { acc, ch -> (acc * 31 + ch.code) and 0x7FFFFFFF }
    return palette[hash % palette.size]
}
