package com.noresign.paboot.util

import java.util.Calendar
import java.util.concurrent.TimeUnit

/** 把 epoch 毫秒格式化成相对时间（"刚刚 / n 分钟前 / n 小时前 / n 天前"）。 */
fun relativeTime(epochMs: Long): String {
    if (epochMs <= 0) return ""
    val diff = System.currentTimeMillis() - epochMs
    if (diff < 0) return "刚刚"
    val minutes = TimeUnit.MILLISECONDS.toMinutes(diff)
    if (minutes < 1) return "刚刚"
    if (minutes < 60) return "${minutes} 分钟前"
    val hours = TimeUnit.MINUTES.toHours(minutes)
    if (hours < 24) return "${hours} 小时前"
    val days = TimeUnit.HOURS.toDays(hours)
    return "${days} 天前"
}

/**
 * 用户消息的发送时间：今天只给 `HH:mm`，更早补日期。
 *
 * 和 [relativeTime] 不同——对话跨天后，「3 天前」已答不了「几点发的」。
 */
fun formatMessageTime(epochMs: Long, now: Long = System.currentTimeMillis()): String {
    if (epochMs <= 0) return ""
    val at = Calendar.getInstance().apply { timeInMillis = epochMs }
    val today = Calendar.getInstance().apply { timeInMillis = now }
    val hour = at.get(Calendar.HOUR_OF_DAY).toString().padStart(2, '0')
    val minute = at.get(Calendar.MINUTE).toString().padStart(2, '0')
    val time = "$hour:$minute"
    if (sameDay(at, today)) return time
    val yesterday = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_MONTH, -1) }
    if (sameDay(at, yesterday)) return "昨天 $time"
    if (at.get(Calendar.YEAR) == today.get(Calendar.YEAR)) {
        return "${at.get(Calendar.MONTH) + 1}月${at.get(Calendar.DAY_OF_MONTH)}日 $time"
    }
    return "${at.get(Calendar.YEAR)}/${at.get(Calendar.MONTH) + 1}/${at.get(Calendar.DAY_OF_MONTH)} $time"
}

private fun sameDay(a: Calendar, b: Calendar): Boolean =
    a.get(Calendar.YEAR) == b.get(Calendar.YEAR) &&
        a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)

/**
 * token 数的缩写形式：`999` / `45.2k` / `168k` / `1.2M`。
 *
 * 十万以内保留一位小数（token 计数在这个量级上，小数位有信息量），再往上取整。
 */
fun formatTokens(n: Long): String = when {
    n < 1_000 -> n.toString()
    n < 100_000 -> scaled(n, 1_000, "k")
    n < 1_000_000 -> "${n / 1_000}k"
    else -> scaled(n, 1_000_000, "M")
}

/**
 * 一位小数，整数尾数不显示（`1.0k` → `1k`）。
 *
 * 手算而不是 `String.format`：结果不该随系统 locale 变（有些 locale 的小数点是逗号），
 * 而 Kotlin 那个带 Locale 的 `String.format` 重载是被隐藏的（deprecated-hidden）。
 */
private fun scaled(n: Long, unit: Long, suffix: String): String {
    val tenths = Math.round(n.toDouble() * 10 / unit)
    val whole = tenths / 10
    val frac = tenths % 10
    return if (frac == 0L) "$whole$suffix" else "$whole.$frac$suffix"
}
