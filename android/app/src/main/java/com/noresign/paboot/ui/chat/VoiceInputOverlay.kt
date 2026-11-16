package com.noresign.paboot.ui.chat

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import kotlin.math.sin

/** 录音/转写时盖住输入区的浮层；只覆盖 composer，不影响上方消息流。 */
@Composable
internal fun VoiceInputOverlay(
    recording: Boolean,
    transcribing: Boolean,
    cancelArmed: Boolean,
    level: Float,
    modifier: Modifier = Modifier,
) {
    if (!recording && !transcribing) return
    val animatedLevel by animateFloatAsState(targetValue = level, label = "voiceLevel")
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(18.dp))
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.98f))
            .pointerInput(Unit) { detectTapGestures { } },
        contentAlignment = Alignment.Center,
    ) {
        if (transcribing) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                Spacer(modifier = Modifier.width(10.dp))
                Text(
                    "识别中…",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    repeat(7) { index ->
                        val shape = 0.35f + 0.65f * abs(sin((index + 1).toDouble())).toFloat()
                        Box(
                            modifier = Modifier
                                .width(3.dp)
                                .height((6f + animatedLevel * 22f * shape).dp)
                                .clip(RoundedCornerShape(2.dp))
                                .background(MaterialTheme.colorScheme.error),
                        )
                    }
                }
                Spacer(modifier = Modifier.width(12.dp))
                Text(
                    if (cancelArmed) "松开取消" else "正在聆听…松开结束",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (cancelArmed) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        }
    }
}
