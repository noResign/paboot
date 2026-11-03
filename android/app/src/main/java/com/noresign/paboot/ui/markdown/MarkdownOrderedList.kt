package com.noresign.paboot.ui.markdown

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import com.mikepenz.markdown.model.BulletHandler

/**
 * 回显源码里的有序列表序号：从 `4.` 接着写的列表不会被库重新编成 1./2.；
 * 缺 marker 时再退回自增序号。
 */
@Composable
internal fun rememberSourceOrderedListHandler(): BulletHandler = remember {
    BulletHandler { _, bullet, index ->
        val marker = bullet?.toString()?.trim().orEmpty()
        when {
            marker.isEmpty() -> "${index + 1}. "
            marker.endsWith(".") || marker.endsWith(")") -> "$marker "
            else -> "$marker. "
        }
    }
}
