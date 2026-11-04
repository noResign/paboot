package com.noresign.paboot.network.daemon

import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

/**
 * Builds a Retrofit [PabootApi] against a user-supplied base URL + token. The
 * daemon URL is not known at compile time, so instances are built lazily and
 * cached per (baseUrl, token) while the underlying OkHttp client is shared.
 */
object PabootClient {

    /** The daemon's default port; kept in step with `parseAddress` on desktop. */
    private const val DEFAULT_DAEMON_PORT = 4780

    private val json = Json { ignoreUnknownKeys = true }

    private val baseOkHttpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    /** Normalizes user input like `192.168.1.5` into `http://192.168.1.5:4780/`. */
    fun normalizeBaseUrl(input: String): String {
        var url = input.trim()
        if (url.isNotEmpty()) {
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = "http://$url"
            }
            url = withDefaultPort(url)
            if (!url.endsWith("/")) url += "/"
        }
        return url
    }

    /** The daemon's port applies whenever the user did not type one ([v6]:port counts). */
    private fun withDefaultPort(url: String): String {
        val authorityStart = url.indexOf("://") + 3
        if (authorityStart < 3) return url
        var authorityEnd = url.length
        for (index in authorityStart until url.length) {
            if (url[index] == '/' || url[index] == '?' || url[index] == '#') {
                authorityEnd = index
                break
            }
        }
        val hostPort = url.substring(authorityStart, authorityEnd).substringAfterLast('@')
        val hasPort = if (hostPort.startsWith("[")) {
            val close = hostPort.indexOf(']')
            close >= 0 && close + 1 < hostPort.length && hostPort[close + 1] == ':'
        } else {
            hostPort.contains(':')
        }
        if (hasPort) return url
        return url.substring(0, authorityEnd) + ":$DEFAULT_DAEMON_PORT" + url.substring(authorityEnd)
    }

    private val apiCache = mutableMapOf<String, PabootApi>()
    private val clientCache = mutableMapOf<String, OkHttpClient>()

    /**
     * An OkHttp client that injects `Authorization: Bearer <token>` on every call,
     * shared per (baseUrl, token). Exposed for consumers that fetch bytes over
     * their own HTTP stack — Coil for images, ExoPlayer for video — so the token
     * stays in a header and never ends up in a URL.
     */
    @Synchronized
    fun authedHttpClient(baseUrl: String, token: String): OkHttpClient {
        val normalized = normalizeBaseUrl(baseUrl)
        val key = "$normalized|$token"
        return clientCache.getOrPut(key) {
            baseOkHttpClient.newBuilder()
                .addInterceptor { chain ->
                    val request = chain.request().newBuilder()
                        .header("Authorization", "Bearer $token")
                        .build()
                    chain.proceed(request)
                }
                .build()
        }
    }

    /**
     * Absolute URL of a raw file read (`GET /api/files/raw`), for handing to Coil
     * or a media player. The caller's client must add the Authorization header —
     * this only shapes the URL (endpoint + encoded query).
     */
    fun fileRawUrl(baseUrl: String, workspaceId: String?, root: String?, path: String): String {
        val query = listOfNotNull(
            workspaceId?.let { "workspaceId=${encode(it)}" },
            root?.let { "root=${encode(it)}" },
            "path=${encode(path)}",
        ).joinToString("&")
        return normalizeBaseUrl(baseUrl) + "api/files/raw?$query"
    }

    private fun encode(value: String): String =
        java.net.URLEncoder.encode(value, Charsets.UTF_8.name())

    /** Build (or reuse) an API instance that injects `Authorization: Bearer <token>` on every call. */
    @Synchronized
    fun create(baseUrl: String, token: String): PabootApi {
        val normalized = normalizeBaseUrl(baseUrl)
        val key = "$normalized|$token"
        return apiCache.getOrPut(key) {
            Retrofit.Builder()
                .baseUrl(normalized)
                .client(authedHttpClient(normalized, token))
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .build()
                .create(PabootApi::class.java)
        }
    }
}
