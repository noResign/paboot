package com.noresign.paboot.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import coil.ImageLoader
import coil.compose.SubcomposeAsyncImage
import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.network.daemon.PabootClient

@Composable
internal fun MessageAttachments(ids: List<String>) {
    if (ids.isEmpty()) return
    val context = LocalContext.current
    val settings = SettingsStore
    // SettingsStore keeps exactly what the user typed (often just `192.168.x.x`);
    // the REST client normalizes scheme/port internally, so the image URL must too.
    val base = settings.baseUrl?.let { PabootClient.normalizeBaseUrl(it).trimEnd('/') }
    val token = settings.token
    if (base.isNullOrEmpty() || token.isNullOrEmpty()) return
    var preview by remember { mutableStateOf<String?>(null) }
    val imageLoader = remember(base, token) {
        ImageLoader.Builder(context)
            .callFactory(PabootClient.authedHttpClient(base, token))
            .build()
    }

    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ids.forEach { id ->
            val url = "$base/api/attachments/$id"
            SubcomposeAsyncImage(
                model = url,
                imageLoader = imageLoader,
                contentDescription = "图片附件",
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .size(74.dp)
                    .clip(RoundedCornerShape(9.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .clickable { preview = url },
                loading = {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    }
                },
                error = {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(
                            "加载失败",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
            )
        }
    }

    preview?.let { url ->
        Dialog(onDismissRequest = { preview = null }) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(12.dp),
                contentAlignment = Alignment.Center,
            ) {
                SubcomposeAsyncImage(
                    model = url,
                    imageLoader = imageLoader,
                    contentDescription = "图片预览",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxSize()
                        .clickable { preview = null },
                    loading = {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    },
                    error = {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text(
                                "图片加载失败",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    },
                )
            }
        }
    }
}
