package com.noresign.paboot.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.noresign.paboot.model.chat.AttachmentDraft

@Composable
internal fun InputBar(
    input: String,
    streaming: Boolean,
    attachments: List<AttachmentDraft>,
    uploading: Boolean,
    canAttach: Boolean,
    onPickImages: () -> Unit,
    onRemoveAttachment: (String) -> Unit,
    onInputChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
) {
    val sendable = input.isNotBlank() || attachments.any { it.remoteId != null }
    Column(modifier = Modifier.fillMaxWidth()) {
        if (attachments.isNotEmpty()) {
            LazyRow(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(attachments, key = { it.localId }) { attachment ->
                    AttachmentChip(attachment, onRemoveAttachment)
                }
            }
        }
        attachments.firstOrNull { it.error != null }?.let { failed ->
            Text(
                failed.error.orEmpty(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
            )
        }
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(
                onClick = onPickImages,
                enabled = canAttach && !uploading && !streaming && attachments.size < 8,
            ) {
                Icon(
                    Icons.Rounded.Add,
                    contentDescription = "添加图片",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            BasicTextField(
                value = input,
                onValueChange = onInputChange,
                modifier = Modifier
                    .weight(1f)
                    .background(Color.Transparent)
                    .padding(horizontal = 4.dp, vertical = 12.dp),
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(MaterialTheme.colorScheme.primary),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(
                    onSend = { if (sendable && !streaming && !uploading) onSend() },
                ),
                decorationBox = { innerTextField ->
                    Box {
                        if (input.isEmpty()) {
                            Text(
                                when {
                                    streaming -> "任务运行中…"
                                    uploading -> "图片上传中…"
                                    else -> "输入指令…"
                                },
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        innerTextField()
                    }
                },
            )
            FilledIconButton(
                onClick = if (streaming) onStop else onSend,
                enabled = streaming || (sendable && !uploading),
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = lerp(
                        MaterialTheme.colorScheme.surface,
                        MaterialTheme.colorScheme.primary,
                        0.6f,
                    ),
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ),
                modifier = Modifier.size(40.dp),
            ) {
                Icon(
                    if (streaming) Icons.Rounded.Stop else Icons.AutoMirrored.Filled.Send,
                    contentDescription = if (streaming) "停止" else "发送",
                    modifier = Modifier.size(19.dp),
                )
            }
        }
    }
}

@Composable
private fun AttachmentChip(attachment: AttachmentDraft, onRemove: (String) -> Unit) {
    Box(modifier = Modifier.size(64.dp)) {
        AsyncImage(
            model = attachment.previewUri,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(64.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
        )
        if (attachment.uploading) {
            Box(
                modifier = Modifier
                    .size(64.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(Color.Black.copy(alpha = 0.35f)),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            }
        }
        IconButton(
            onClick = { onRemove(attachment.localId) },
            modifier = Modifier
                .size(22.dp)
                .align(Alignment.TopEnd),
        ) {
            Icon(
                Icons.Rounded.Close,
                contentDescription = "移除图片",
                tint = Color.White,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}
