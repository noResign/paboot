package com.noresign.paboot.updater

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import com.noresign.paboot.updater.internal.ApkVerifier
import com.noresign.paboot.updater.internal.ManifestFetcher
import com.noresign.paboot.updater.internal.UpdateDecisionHelper
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request

class Updater(private val config: UpdaterConfig) {

    private val client = config.client ?: OkHttpClient()
    private val json = Json { ignoreUnknownKeys = true }
    private val manifestFetcher = ManifestFetcher(config, client, json)

    /** 检查更新：manifest → channel 校验 → versionCode 比较。 */
    fun check(): Flow<UpdateEvent> = flow {
        emit(UpdateEvent.Checking)
        val manifest = manifestFetcher.fetch()
        val decision = UpdateDecisionHelper.decide(config, manifest)
        if (decision.updateAvailable) {
            emit(UpdateEvent.UpdateAvailable(manifest))
        } else {
            emit(UpdateEvent.NoUpdate)
        }
    }.catch { throwable ->
        emit(UpdateEvent.Failed(UpdateException.from(throwable)))
    }

    /** 检查更新，如果有新版本则继续下载。 */
    fun checkAndDownload(destDir: File): Flow<UpdateEvent> = flow {
        emit(UpdateEvent.Checking)
        val manifest = manifestFetcher.fetch()
        val decision = UpdateDecisionHelper.decide(config, manifest)
        if (!decision.updateAvailable) {
            emit(UpdateEvent.NoUpdate)
        } else {
            emit(UpdateEvent.UpdateAvailable(manifest))
            download(manifest, destDir).collect { emit(it) }
        }
    }.catch { throwable ->
        emit(UpdateEvent.Failed(UpdateException.from(throwable)))
    }

    /** 下载 APK 到 destDir/paboot-<versionCode>.apk.part，sha256 校验后重命名为同名 .apk。 */
    fun download(manifest: UpdateManifest, destDir: File): Flow<UpdateEvent> = flow {
        if (!destDir.exists() && !destDir.mkdirs()) {
            throw UpdateException.Storage("cannot create update dir: ${destDir.absolutePath}")
        }
        // 文件名带 versionCode：每次更新的 URI/路径都不同，避免系统安装器按同一路径
        // 复用上一次解析出来的安装包信息（表现为「已安装相同版本」而装不上）。
        val name = "paboot-${manifest.versionCode}.apk"
        val part = File(destDir, "$name.part")
        val target = File(destDir, name)
        pruneStaleApks(destDir, keep = target)
        part.delete()
        try {
            val request = Request.Builder().url(manifest.apkUrl).build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw UpdateException.Network("apk request failed: HTTP ${response.code}")
                }
                val body = response.body ?: throw UpdateException.Network("apk response body is empty")
                val total = body.contentLength().takeIf { it > 0 } ?: manifest.apkSize
                body.byteStream().use { input ->
                    FileOutputStream(part).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var downloaded = 0L
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            downloaded += read
                            emit(UpdateEvent.DownloadProgress(downloaded, total))
                        }
                    }
                }
            }
            if (part.length() != manifest.apkSize) {
                throw UpdateException.ChecksumMismatch(
                    expected = "size ${manifest.apkSize}",
                    actual = "size ${part.length()}",
                )
            }
            val actualSha256 = ApkVerifier.sha256(part)
            if (!actualSha256.equals(manifest.sha256, ignoreCase = true)) {
                throw UpdateException.ChecksumMismatch(manifest.sha256, actualSha256)
            }
            target.delete()
            if (!part.renameTo(target)) {
                throw UpdateException.Storage("failed to move apk into place")
            }
            emit(UpdateEvent.Downloaded(target, manifest))
        } catch (throwable: Throwable) {
            part.delete()
            throw throwable
        }
    }.flowOn(Dispatchers.IO).catch { throwable ->
        emit(UpdateEvent.Failed(UpdateException.from(throwable)))
    }

    /**
     * 清掉历史下载的包，磁盘上最多留两份：最近下载的一份和本次要写的一份。
     *
     * 保留"最近一份"不是漏删——系统安装器是异步读 `content://` URI 的：用户可能停在安装
     * 确认框上，此刻删掉那个包，等他点「安装」时就会读不到文件。
     */
    private fun pruneStaleApks(destDir: File, keep: File) {
        val files = destDir.listFiles { file -> file.isFile && file.name.startsWith("paboot-") } ?: return
        val newestApk = files.filter { it.name.endsWith(".apk") }.maxByOrNull { it.lastModified() }
        files.forEach { file -> if (file != keep && file != newestApk) file.delete() }
    }

    /** 调起系统安装器；FileProvider 由宿主 App 声明。 */
    fun install(context: Context, apkFile: File): Boolean {
        if (!apkFile.exists()) {
            throw UpdateException.InstallNotResolved("apk file not found: ${apkFile.absolutePath}")
        }
        val uri = FileProvider.getUriForFile(context, config.fileProviderAuthority, apkFile)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return try {
            context.startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            throw UpdateException.InstallNotResolved("no package installer available", e)
        }
    }

    /** App 启动时清空上次遗留的安装包；不要在 install() 后立刻清理。 */
    fun cleanup(context: Context) {
        File(context.cacheDir, "updates").deleteRecursively()
    }
}
