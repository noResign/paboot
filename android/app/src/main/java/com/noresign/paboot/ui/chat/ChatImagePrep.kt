package com.noresign.paboot.ui.chat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/** Client-side limit: keeps screenshot/photo prompts small enough for the model. */
private const val MAX_DIMENSION = 2048
private const val KEEP_ORIGINAL_BYTES = 4 * 1024 * 1024
private const val MAX_BYTES = 10 * 1024 * 1024
private val ALLOWED = setOf("image/png", "image/jpeg", "image/webp", "image/gif")

data class PreparedChatImage(
    val bytes: ByteArray,
    val contentType: String,
    val previewUri: Uri,
)

object ChatImagePrep {
    suspend fun prepare(context: Context, uri: Uri): Result<PreparedChatImage> =
        withContext(Dispatchers.IO) {
            runCatching {
                val resolver = context.contentResolver
                val contentType = resolver.getType(uri)?.lowercase() ?: "image/jpeg"
                require(contentType in ALLOWED) { "只支持 PNG / JPEG / WebP / GIF" }
                val original = resolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: error("无法读取图片")
                require(original.size <= MAX_BYTES) { "单张图片不能超过 10MB" }

                if (contentType == "image/gif" || original.size <= KEEP_ORIGINAL_BYTES) {
                    return@runCatching PreparedChatImage(original, contentType, uri)
                }

                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(original, 0, original.size, bounds)
                val longest = maxOf(bounds.outWidth, bounds.outHeight)
                if (longest <= MAX_DIMENSION) {
                    return@runCatching PreparedChatImage(original, contentType, uri)
                }

                val options = BitmapFactory.Options().apply {
                    inSampleSize = sampleSize(longest)
                }
                val bitmap = BitmapFactory.decodeByteArray(original, 0, original.size, options)
                    ?: error("无法解析图片")
                val scale = MAX_DIMENSION.toFloat() / maxOf(bitmap.width, bitmap.height)
                val scaled = if (scale < 1f) {
                    Bitmap.createScaledBitmap(
                        bitmap,
                        (bitmap.width * scale).toInt().coerceAtLeast(1),
                        (bitmap.height * scale).toInt().coerceAtLeast(1),
                        true,
                    )
                } else {
                    bitmap
                }
                val output = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.JPEG, 85, output)
                scaled.recycle()
                if (scaled !== bitmap) bitmap.recycle()
                val bytes = output.toByteArray()
                require(bytes.size <= MAX_BYTES) { "压缩后图片仍超过 10MB" }
                PreparedChatImage(bytes, "image/jpeg", uri)
            }
        }

    private fun sampleSize(longest: Int): Int {
        var sample = 1
        while (longest / sample > MAX_DIMENSION * 2) sample *= 2
        return sample
    }
}
