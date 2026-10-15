package com.noresign.paboot.viewmodel

import androidx.lifecycle.viewModelScope
import com.noresign.paboot.base.BaseViewModel
import com.noresign.paboot.data.SavedConnection
import com.noresign.paboot.data.WorkspaceSelection
import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.data.repository.ConnectRepository
import com.noresign.paboot.data.repository.WorkspaceRepository
import com.noresign.paboot.model.connect.ConnectResponse
import com.noresign.paboot.notify.RunWatchCenter
import com.noresign.paboot.util.friendlyError
import com.noresign.paboot.network.http.NetworkResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed class ConnectUiState {
    object Idle : ConnectUiState()
    object Connecting : ConnectUiState()
    data class Success(val data: ConnectResponse, val baseUrl: String) : ConnectUiState()
    data class Error(val message: String) : ConnectUiState()
}

class ConnectViewModel(
    private val repository: ConnectRepository = ConnectRepository(),
    private val workspaceRepository: WorkspaceRepository = WorkspaceRepository(),
    private val settings: SettingsStore = SettingsStore,
) : BaseViewModel() {

    private val _uiState = MutableStateFlow<ConnectUiState>(ConnectUiState.Idle)
    val uiState = _uiState.asStateFlow()

    private val _name = MutableStateFlow(settings.name ?: "")
    val name = _name.asStateFlow()

    private val _baseUrl = MutableStateFlow(settings.baseUrl ?: "")
    val baseUrl = _baseUrl.asStateFlow()

    private val _token = MutableStateFlow(settings.token ?: "")
    val token = _token.asStateFlow()

    private val _savedConnections = MutableStateFlow(settings.savedConnections)
    val savedConnections = _savedConnections.asStateFlow()

    /** 选中「最近连接」里的某条：回填后直接发起连接。 */
    fun selectSaved(connection: SavedConnection) {
        fillSaved(connection)
        connect()
    }

    /** 名称下拉框选中某条：只回填三个输入框，不自动连接，方便先改再连。 */
    fun fillSaved(connection: SavedConnection) {
        _name.value = connection.name
        _baseUrl.value = connection.baseUrl
        _token.value = connection.token
        _uiState.value = ConnectUiState.Idle
    }

    fun forgetSaved(baseUrl: String) {
        settings.forgetConnection(baseUrl)
        _savedConnections.value = settings.savedConnections
    }

    fun onNameChange(value: String) {
        _name.value = value
        if (_uiState.value !is ConnectUiState.Connecting) {
            _uiState.value = ConnectUiState.Idle
        }
    }

    fun onBaseUrlChange(value: String) {
        _baseUrl.value = value
        if (_uiState.value !is ConnectUiState.Connecting) {
            _uiState.value = ConnectUiState.Idle
        }
    }

    fun onTokenChange(value: String) {
        _token.value = value
        if (_uiState.value !is ConnectUiState.Connecting) {
            _uiState.value = ConnectUiState.Idle
        }
    }

    fun connect() {
        val nm = _name.value.trim()
        val url = _baseUrl.value.trim()
        val tk = _token.value.trim()
        when {
            url.isEmpty() -> {
                _uiState.value = ConnectUiState.Error("请输入 daemon 地址")
                return
            }
            tk.isEmpty() -> {
                _uiState.value = ConnectUiState.Error("请输入 token")
                return
            }
        }

        _uiState.value = ConnectUiState.Connecting
        viewModelScope.launch {
            when (val result = repository.testConnection(url, tk)) {
                is NetworkResult.Success -> {
                    val previousBaseUrl = settings.baseUrl
                    // 上一次那台 daemon 的身份。要在 rememberConnection 之前读，它会把旧地址那条合并掉。
                    val previousServerId = settings.savedConnections
                        .firstOrNull { it.baseUrl == previousBaseUrl }?.serverId
                    val sameDaemon = result.data.serverId != null && result.data.serverId == previousServerId
                    settings.name = nm
                    settings.baseUrl = url
                    settings.token = tk
                    settings.workspace = result.data.workspace
                    // 换了 daemon：旧 runId 的监听与残留通知在新 daemon 上没有意义。
                    // 同一地址重连、或同一台 daemon 换地址（回环 ↔ 局域网），都照旧接着提醒。
                    if (previousBaseUrl != null && previousBaseUrl != url && !sameDaemon) {
                        RunWatchCenter.clearAll()
                    }
                    settings.rememberConnection(nm, url, tk, result.data.serverId)
                    _savedConnections.value = settings.savedConnections
                    val workspaces = workspaceRepository.listWorkspaces()
                    if (workspaces is NetworkResult.Success) {
                        val list = workspaces.data
                        val selected = settings.selectedWorkspaceId
                            ?.takeIf { id -> list.any { it.id == id } }
                            ?: list.firstOrNull { it.isDefault }?.id
                            ?: list.firstOrNull()?.id
                        WorkspaceSelection.select(selected, list.find { it.id == selected }?.path)
                    } else {
                        // 旧 daemon 可能没有 /api/workspaces：清掉本地选择，回退到“不过滤会话”。
                        WorkspaceSelection.select(null)
                    }
                    _uiState.value = ConnectUiState.Success(result.data, url)
                }
                is NetworkResult.Error -> {
                    _uiState.value = ConnectUiState.Error(friendlyError(result, fallbackPrefix = "连接失败"))
                }
            }
        }
    }
}
