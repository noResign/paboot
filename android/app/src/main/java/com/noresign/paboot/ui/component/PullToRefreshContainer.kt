package com.noresign.paboot.ui.component

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import kotlin.math.roundToInt

/**
 * 下拉刷新容器：**整页跟手**。
 *
 * 直接用 Material 3 的 `PullToRefreshBox` 是另一套手感——它只把指示器叠在顶部滑出来，
 * 内容一动不动（M3 的规范如此）。iOS / 微信那一派是整页跟着手指下移、松手弹回、刷新
 * 期间停在拉出位置。这里要的是后者，所以包一层把内容一起推下去。
 *
 * 手势不重写：M3 1.3 把驱动值 `PullToRefreshState.distanceFraction`（拉动进度）开成了
 * 公开 API，位移量直接从它读。于是下拉、回弹、加载中停留三个阶段同源，不会出现
 * 「圈已经回弹了、页面还没回」这种错位。
 *
 * [content] 的接收者是 [BoxScope]，页面里原有的 `Modifier.align(...)` 照常可用。空态 /
 * 错误态的内容不是可滚动组件，下拉手势未必触发，调用方要留自己的「重试」入口。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PullToRefreshContainer(
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    val state = rememberPullToRefreshState()
    val thresholdPx = with(LocalDensity.current) { PullToRefreshDefaults.PositionalThreshold.toPx() }
    PullToRefreshBox(
        isRefreshing = isRefreshing,
        onRefresh = onRefresh,
        modifier = modifier,
        state = state,
    ) {
        // 内容下移多少 = 指示器拉出多少，两者共用同一个 distanceFraction。
        // 外层负责裁掉溢出：下移之后底部那条会越过可见区（SwipeRefreshLayout 同样这么做）；
        // 裁在指示器这一层之下，指示器本身不受影响。
        Box(modifier = Modifier.fillMaxSize().clipToBounds()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    // lambda 版 offset：只在 layout 阶段读 distanceFraction，不触发重组。
                    .offset { IntOffset(0, (state.distanceFraction * thresholdPx).roundToInt()) },
                content = content,
            )
        }
    }
}
