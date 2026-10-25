package com.noresign.paboot.util

import java.net.URI

private val IPV4_WITH_PORT = Regex("""\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}\b""")
private val IPV4 = Regex("""\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}\b""")
private val IPV6_WITH_PORT = Regex("""\[([0-9a-fA-F]+):[0-9a-fA-F:]+\]:\d{1,5}""")
private val IPV6 = Regex("""\[([0-9a-fA-F]+):[0-9a-fA-F:]+\]""")

/**
 * 隐去地址里能定位到具体主机的部分：`192.168.1.5:4780` → `192.*.*.*:****`。
 * 只保留第一段；主机名本来就是可读的，原样返回。
 */
fun maskAddress(value: String): String = value
    .replace(IPV4_WITH_PORT) { "${it.groupValues[1]}.*.*.*:****" }
    .replace(IPV4) { "${it.groupValues[1]}.*.*.*" }
    .replace(IPV6_WITH_PORT) { "[${it.groupValues[1]}:…]:****" }
    .replace(IPV6) { "[${it.groupValues[1]}:…]" }

/** 从 baseUrl 取出 host；解析不了就原样返回，交给 [maskAddress] 兜底。 */
fun hostOf(baseUrl: String): String =
    runCatching { URI(baseUrl).host }.getOrNull() ?: baseUrl
