package com.noresign.paboot.ui.component

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * 上下文窗口占用圆环（聊天页顶栏，见 docs/ui/mobile/pages/chat.md §6.3）。
 *
 * 只画比例、不写数字：顶栏那一行要留给 cwd，具体数值由点击后的详情给出。
 *
 * [percent] 为 null（运行时不给窗口大小，例如 Claude）时只画底圈——「占用已知、比例未知」，
 * 不假装成 0%。
 */
@Composable
fun ContextRing(
    percent: Int?,
    modifier: Modifier = Modifier,
    size: Dp = 18.dp,
) {
    val trackColor = MaterialTheme.colorScheme.outlineVariant
    val arcColor = MaterialTheme.colorScheme.primary
    Box(modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            // 显式用 this.size：函数据参也叫 size，靠命名参数区分容易看错。
            val stroke = this.size.minDimension * 0.18f
            val inset = stroke / 2
            val ring = Size(this.size.width - stroke, this.size.height - stroke)
            drawArc(
                color = trackColor,
                startAngle = 0f,
                sweepAngle = 360f,
                useCenter = false,
                topLeft = Offset(inset, inset),
                size = ring,
                style = Stroke(width = stroke),
            )
            val sweep = ((percent ?: 0).coerceIn(0, 100) / 100f) * 360f
            if (sweep > 0f) {
                drawArc(
                    color = arcColor,
                    // 从 12 点方向顺时针，符合「进度环」的直觉。
                    startAngle = -90f,
                    sweepAngle = sweep,
                    useCenter = false,
                    topLeft = Offset(inset, inset),
                    size = ring,
                    style = Stroke(width = stroke, cap = StrokeCap.Round),
                )
            }
        }
    }
}
