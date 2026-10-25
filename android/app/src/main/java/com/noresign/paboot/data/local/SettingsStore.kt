package com.noresign.paboot.data.local

import com.noresign.paboot.data.SavedConnection
import com.tencent.mmkv.MMKV

/**
 * Minimal persistence for the daemon connection settings, backed by MMKV
 * (initialized in [com.noresign.paboot.AppApplication]).
 */
object SettingsStore {

    private val kv: MMKV by lazy { MMKV.defaultMMKV() }

    private const val KEY_BASE_URL = "daemon_base_url"
    private const val KEY_TOKEN = "daemon_token"
    private const val KEY_NAME = "daemon_name"
    private const val KEY_WORKSPACE = "daemon_workspace"
    private const val KEY_SELECTED_WORKSPACE_ID = "selected_workspace_id"
    private const val KEY_SELECTED_WORKSPACE_PATH = "selected_workspace_path"
    private const val KEY_SAVED_CONNECTIONS = "saved_connections"
    private const val KEY_BACKGROUND_NOTIFICATIONS = "background_notifications"
    private const val KEY_NOTIFICATION_PROMPT_SHOWN = "notification_prompt_shown"

    private const val MAX_SAVED_CONNECTIONS = 5
    private const val ENTRY_SEPARATOR = "\n"
    private const val FIELD_SEPARATOR = "\t"

    var baseUrl: String?
        get() = kv.decodeString(KEY_BASE_URL)
        set(value) {
            if (value.isNullOrBlank()) kv.removeValueForKey(KEY_BASE_URL) else kv.encode(KEY_BASE_URL, value)
        }

    var token: String?
        get() = kv.decodeString(KEY_TOKEN)
        set(value) {
            if (value.isNullOrBlank()) kv.removeValueForKey(KEY_TOKEN) else kv.encode(KEY_TOKEN, value)
        }

    /** 上次使用的可读名称（连接成功后写入，用于连接页预填与列表展示）。 */
    var name: String?
        get() = kv.decodeString(KEY_NAME)
        set(value) {
            if (value.isNullOrBlank()) kv.removeValueForKey(KEY_NAME) else kv.encode(KEY_NAME, value)
        }

    /** daemon 默认 Workspace 根目录（连接成功后写入，仅作兼容/兜底展示）。 */
    var workspace: String?
        get() = kv.decodeString(KEY_WORKSPACE)
        set(value) {
            if (value.isNullOrBlank()) kv.removeValueForKey(KEY_WORKSPACE) else kv.encode(KEY_WORKSPACE, value)
        }

    /** 当前客户端选中的 Workspace id。 */
    var selectedWorkspaceId: String?
        get() = kv.decodeString(KEY_SELECTED_WORKSPACE_ID)
        set(value) {
            if (value.isNullOrBlank()) kv.removeValueForKey(KEY_SELECTED_WORKSPACE_ID) else kv.encode(KEY_SELECTED_WORKSPACE_ID, value)
        }

    /** 当前客户端选中的 Workspace path（仅用于界面展示/兜底）。 */
    var selectedWorkspacePath: String?
        get() = kv.decodeString(KEY_SELECTED_WORKSPACE_PATH)
        set(value) {
            if (value.isNullOrBlank()) kv.removeValueForKey(KEY_SELECTED_WORKSPACE_PATH) else kv.encode(KEY_SELECTED_WORKSPACE_PATH, value)
        }

    /**
     * 最近连接成功过的服务器，最新在前。
     *
     * 存成一条字符串（条目用 `\n`、字段用 `\t` 分隔）而不是 MMKV 的 StringSet：
     * 顺序即"最近优先"，必须保留。
     *
     * 字段顺序：`name\tbaseUrl\ttoken\tserverId`。旧版本存过 3 段（无 serverId）
     * 与 2 段（无 name、无 serverId），解析时按段数兼容，缺失的字段视为空。
     */
    val savedConnections: List<SavedConnection>
        get() = kv.decodeString(KEY_SAVED_CONNECTIONS)
            .orEmpty()
            .split(ENTRY_SEPARATOR)
            .mapNotNull { entry ->
                val parts = entry.split(FIELD_SEPARATOR)
                when {
                    parts.size == 4 && parts[1].isNotBlank() && parts[2].isNotBlank() ->
                        SavedConnection(baseUrl = parts[1], token = parts[2], name = parts[0], serverId = parts[3])
                    parts.size == 3 && parts[1].isNotBlank() && parts[2].isNotBlank() ->
                        SavedConnection(baseUrl = parts[1], token = parts[2], name = parts[0])
                    parts.size == 2 && parts[0].isNotBlank() && parts[1].isNotBlank() ->
                        SavedConnection(baseUrl = parts[0], token = parts[1])
                    else -> null
                }
            }

    /**
     * 后台任务提醒（审批 / 完成时弹系统通知）。
     *
     * 关掉后不再建立后台监听连接，也不会有常驻的「正在监听」提示；任务本身照旧在电脑上跑。
     * 默认开：这个功能的价值就在「人不在会话页」的时候，默认关等于没做。
     */
    var backgroundNotifications: Boolean
        get() = !kv.containsKey(KEY_BACKGROUND_NOTIFICATIONS) || kv.decodeBool(KEY_BACKGROUND_NOTIFICATIONS)
        set(value) {
            kv.encode(KEY_BACKGROUND_NOTIFICATIONS, value)
        }

    /** 是否已经弹过系统通知权限框。只弹一次，之后由设置页引导去系统设置。 */
    var notificationPromptShown: Boolean
        get() = kv.decodeBool(KEY_NOTIFICATION_PROMPT_SHOWN)
        set(value) {
            kv.encode(KEY_NOTIFICATION_PROMPT_SHOWN, value)
        }

    /**
     * 记录一次成功的连接：同一地址、或**同一台 daemon 的另一个地址**，都只保留最新一条
     * （token 轮换 / 改名 / 换地址后自动覆盖）。
     *
     * `serverId` 为空（老 daemon）时退回按地址去重——那时无从判断是不是同一台。
     */
    fun rememberConnection(name: String, baseUrl: String, token: String, serverId: String? = null) {
        val nm = sanitizeField(name)
        val url = baseUrl.trim()
        val tk = token.trim()
        if (url.isEmpty() || tk.isEmpty()) return
        val sid = sanitizeField(serverId.orEmpty())
        val updated = listOf(SavedConnection(url, tk, nm, sid)) +
            savedConnections.filterNot { it.baseUrl == url || (sid.isNotEmpty() && it.serverId == sid) }
        writeSavedConnections(updated.take(MAX_SAVED_CONNECTIONS))
    }

    /**
     * 编辑一条已保存的连接（名称 / 地址 / token），保持它在列表里的位置。
     * 改的若正是当前使用的连接，同步 `baseUrl` / `token` / `name`，保证冷启动仍能直接进入。
     * 地址或 token 为空时不做修改并返回 false。
     */
    fun updateConnection(oldBaseUrl: String, name: String, baseUrl: String, token: String): Boolean {
        val current = savedConnections.firstOrNull { it.baseUrl == oldBaseUrl } ?: return false
        val nm = sanitizeField(name)
        val url = baseUrl.trim()
        val tk = token.trim()
        if (url.isEmpty() || tk.isEmpty()) return false

        val updated = SavedConnection(url, tk, nm, current.serverId)
        val next = mutableListOf<SavedConnection>()
        savedConnections.forEach { item ->
            when {
                item.baseUrl == oldBaseUrl -> next += updated
                // 改成了已有地址、或同一台 daemon（serverId）的条目：合并成一条。
                item.baseUrl == url -> Unit
                updated.serverId.isNotEmpty() && item.serverId == updated.serverId -> Unit
                else -> next += item
            }
        }
        writeSavedConnections(next.take(MAX_SAVED_CONNECTIONS))

        if (this.baseUrl == oldBaseUrl) {
            this.name = nm
            this.baseUrl = url
            this.token = tk
        }
        return true
    }

    fun forgetConnection(baseUrl: String) {
        writeSavedConnections(savedConnections.filterNot { it.baseUrl == baseUrl })
    }

    private fun writeSavedConnections(connections: List<SavedConnection>) {
        val encoded = connections.joinToString(ENTRY_SEPARATOR) {
            "${sanitizeField(it.name)}$FIELD_SEPARATOR${it.baseUrl}$FIELD_SEPARATOR${it.token}" +
                "$FIELD_SEPARATOR${sanitizeField(it.serverId)}"
        }
        if (encoded.isBlank()) {
            kv.removeValueForKey(KEY_SAVED_CONNECTIONS)
        } else {
            kv.encode(KEY_SAVED_CONNECTIONS, encoded)
        }
    }

    /** name 是自由输入，不能混入分隔符，否则会破坏编码。 */
    private fun sanitizeField(value: String): String =
        value.replace(ENTRY_SEPARATOR, " ").replace(FIELD_SEPARATOR, " ").trim()
}
