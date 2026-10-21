@file:kotlin.OptIn(ExperimentalMaterial3Api::class)

package com.noresign.paboot.ui

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import coil.ImageLoader
import coil.compose.SubcomposeAsyncImage
import com.noresign.paboot.data.MediaKind
import com.noresign.paboot.viewmodel.MediaUiState
import okhttp3.OkHttpClient

/**
 * 图片 / 视频预览。数据由 Coil / ExoPlayer 通过带鉴权的 OkHttp 客户端按需拉取
 * （daemon 的 `/api/files/raw` 支持 Range，所以视频能拖进度、大图能分块加载）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MediaViewerScreen(
    state: MediaUiState,
    client: OkHttpClient?,
    onBack: () -> Unit,
    bottomOverlayPadding: Dp = 0.dp,
) {
    val path = when (state) {
        is MediaUiState.Ready -> state.path
        is MediaUiState.Error -> state.path
    }
    Scaffold(
        containerColor = MediaBackground,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        fileName(path),
                        style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { innerPadding ->
        val body = Modifier.fillMaxSize().padding(innerPadding).padding(bottom = bottomOverlayPadding)
        when (state) {
            is MediaUiState.Error -> CenteredHint(state.message, isError = true, modifier = body)
            is MediaUiState.Ready -> when {
                client == null -> CenteredHint("未配置连接", isError = true, modifier = body)
                state.kind == MediaKind.Image -> ImagePreview(url = state.url, client = client, modifier = body)
                else -> VideoPreview(url = state.url, client = client, modifier = body)
            }
        }
    }
}

@Composable
private fun ImagePreview(url: String, client: OkHttpClient, modifier: Modifier) {
    val context = LocalContext.current
    val loader = remember(client) {
        ImageLoader.Builder(context).callFactory(client).build()
    }
    SubcomposeAsyncImage(
        model = url,
        contentDescription = null,
        imageLoader = loader,
        contentScale = ContentScale.Fit,
        modifier = modifier.background(MediaBackground),
        loading = {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        },
        error = {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("图片加载失败", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
    )
}

@OptIn(UnstableApi::class)
@Composable
private fun VideoPreview(url: String, client: OkHttpClient, modifier: Modifier) {
    val context = LocalContext.current
    val player = remember(client) {
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(client)))
            .build()
    }
    // 换文件 / 换客户端时重设媒体项；player 本身随 client 复用。
    LaunchedEffect(url, client) {
        player.setMediaItem(MediaItem.fromUri(url))
        player.prepare()
    }
    DisposableEffect(player) {
        onDispose { player.release() }
    }
    // 切后台时暂停，避免「锁屏了还在放」。
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, player) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) player.pause()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    AndroidView(
        factory = { ctx -> PlayerView(ctx).apply { this.player = player } },
        update = { it.player = player },
        modifier = modifier.background(Color.Black),
    )
}

@Composable
private fun CenteredHint(message: String, isError: Boolean, modifier: Modifier) {
    Box(modifier, contentAlignment = Alignment.Center) {
        Text(
            message,
            color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

private fun fileName(path: String): String = path.substringAfterLast('/').ifBlank { path }

private val MediaBackground = Color(0xFF1E1E1E)
