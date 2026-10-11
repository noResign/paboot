package com.noresign.paboot.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * 语义色 token，值来自 docs/ui/shared/design-principles.md §4.1（浅色默认 + 深色）。
 *
 * Material3 的 ColorScheme 没有 success / warning / thinking 等槽位，因此完整语义色统一收在这里；
 * Theme.kt 只把标准槽位映射过去，UI 需要非标准色时直接从本对象取。
 */
object DesignColors {

    // ---- 浅色（默认） ----
    val LightBg = Color(0xFFF6F8F7)
    val LightSurface = Color(0xFFFFFFFF)
    val LightSurface2 = Color(0xFFFFFFFF)
    val LightBorder = Color(0xFFE3EAE6)
    val LightTextPrimary = Color(0xFF16211D)
    val LightTextSecondary = Color(0xFF5A6B64)
    val LightTextMuted = Color(0xFF93A29A)
    val LightPrimary = Color(0xFF0E9F86)
    val LightPrimaryDeep = Color(0xFF0A7D6B)
    val LightPrimarySubtle = Color(0xFFE2F3EE)
    val LightSuccess = Color(0xFF18A058)
    val LightWarning = Color(0xFFB7791F)
    val LightError = Color(0xFFD6423E)
    val LightThinking = Color(0xFF9AA8A2)
    val LightCodeBg = Color(0xFFF2F5F3)
    val LightErrorContainer = Color(0xFFFBEDED)

    // ---- 深色 ----
    val DarkBg = Color(0xFF0E1512)
    val DarkSurface = Color(0xFF17201C)
    val DarkSurface2 = Color(0xFF1E2823)
    val DarkBorder = Color(0xFF293430)
    val DarkTextPrimary = Color(0xFFE7EFEB)
    val DarkTextSecondary = Color(0xFFA2B0AA)
    val DarkTextMuted = Color(0xFF6D7C75)
    val DarkPrimary = Color(0xFF2BC7A4)
    val DarkPrimaryDeep = Color(0xFF4AD8B8)
    val DarkPrimarySubtle = Color(0xFF12332B)
    val DarkSuccess = Color(0xFF4CC38A)
    val DarkWarning = Color(0xFFE0B14A)
    val DarkError = Color(0xFFF26D6D)
    val DarkThinking = Color(0xFF85938C)
    val DarkCodeBg = Color(0xFF101815)
    val DarkErrorContainer = Color(0xFF3A211F)

    /** Claude 暖橙（§5.2 runtime 身份色，同时作 tertiary 点缀）。 */
    val ClaudeOrange = Color(0xFFD97757)
}
