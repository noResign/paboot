package com.noresign.paboot.updater

import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdaterDownloadTest {

    @Test
    fun `downloads verifies and renames apk`() {
        val bytes = "fake apk bytes".toByteArray()
        val sha256 = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }

        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(Buffer().write(bytes)))
        server.start()

        val destDir = File.createTempFile("paboot-updater", "").apply {
            delete()
            mkdirs()
        }
        try {
            val config = UpdaterConfig(
                manifestUrl = "https://example.com/manifest.json",
                channel = "alpha",
                currentVersionCode = 10,
                currentVersionName = "0.1.0",
                fileProviderAuthority = "com.noresign.paboot.fileprovider",
            )
            val manifest = UpdateManifest(
                channel = "alpha",
                versionCode = 11,
                versionName = "0.2.0",
                apkUrl = server.url("/app.apk").toString(),
                apkSize = bytes.size.toLong(),
                sha256 = sha256,
            )
            val events = runBlocking { Updater(config).download(manifest, destDir).toList() }
            assertTrue(events.any { it is UpdateEvent.DownloadProgress })
            assertTrue(events.any { it is UpdateEvent.Downloaded })
            assertEquals(bytes.size.toLong(), File(destDir, "paboot-11.apk").length())
        } finally {
            server.shutdown()
            destDir.deleteRecursively()
        }
    }
}
