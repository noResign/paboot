package com.noresign.paboot.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.noresign.paboot.data.WorkspaceSelection
import com.noresign.paboot.data.repository.SessionRepository
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.model.session.SessionListModel
import com.noresign.paboot.model.session.groupByCwd
import com.noresign.paboot.util.friendlyError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed class SessionListUiState {
    object Loading : SessionListUiState()
    data class Content(val model: SessionListModel) : SessionListUiState()
    data class Error(val message: String) : SessionListUiState()
}

class SessionListViewModel(
    private val repository: SessionRepository = SessionRepository(),
) : ViewModel() {

    private val _uiState = MutableStateFlow<SessionListUiState>(SessionListUiState.Loading)
    val uiState = _uiState.asStateFlow()

    /** Transient message (e.g. delete failure), cleared after being shown. */
    private val _message = MutableStateFlow<String?>(null)
    val message = _message.asStateFlow()

    /** 下拉刷新指示器；只由手势驱动，进页面/切回来时的自动刷新不碰它。 */
    private val _refreshing = MutableStateFlow(false)
    val refreshing = _refreshing.asStateFlow()

    private val _renameSubmitting = MutableStateFlow(false)
    val renameSubmitting = _renameSubmitting.asStateFlow()
    private val _renameError = MutableStateFlow<String?>(null)
    val renameError = _renameError.asStateFlow()

    init {
        viewModelScope.launch {
            WorkspaceSelection.selectedId.collect { workspaceId ->
                _uiState.value = SessionListUiState.Loading
                fetch(workspaceId)
            }
        }
    }

    fun refresh() {
        viewModelScope.launch {
            _uiState.value = SessionListUiState.Loading
            fetch(WorkspaceSelection.current())
        }
    }

    /** Re-fetch without flashing the Loading spinner; keeps current list visible on failure. */
    fun refreshSilently() {
        viewModelScope.launch { refetchQuietly() }
    }

    /**
     * 下拉刷新。与 [refreshSilently] 拉的是同一份数据、走同一套错误处理（有内容时只弹
     * 一句提示，不退回错误页），区别只在转不转指示器——所以已经有内容时不会闪。
     */
    fun pullRefresh() {
        if (_refreshing.value) return
        viewModelScope.launch {
            _refreshing.value = true
            try {
                refetchQuietly()
            } finally {
                _refreshing.value = false
            }
        }
    }

    private suspend fun refetchQuietly() = fetchFor(
        WorkspaceSelection.current(),
        onError = { error ->
            if (_uiState.value !is SessionListUiState.Content) {
                _uiState.value = SessionListUiState.Error(friendlyError(error))
            } else {
                _message.value = friendlyError(error)
            }
        },
    )

    private suspend fun fetch(workspaceId: String?, onError: (NetworkResult.Error) -> Unit = { error ->
        _uiState.value = SessionListUiState.Error(friendlyError(error))
    }) {
        when (val r = repository.listSessions(workspaceId)) {
            is NetworkResult.Success -> _uiState.value = SessionListUiState.Content(
                groupByCwd(r.data, WorkspaceSelection.selectedPath.value),
            )
            is NetworkResult.Error -> {
                // 本地选中的工作区在 daemon 上已经不存在（换过 daemon、或在那边删掉了）：
                // 清掉本地选择，selectedId 的 collector 会用「不过滤」重拉一次。不处理就会
                // 停在一条不可重试的错误上——「重试」永远失败，用户也看不出该去哪。
                if (r.apiCode == "workspace_not_found" && workspaceId != null) {
                    WorkspaceSelection.select(null)
                    return
                }
                onError(r)
            }
        }
    }

    private suspend fun fetchFor(workspaceId: String?, onError: (NetworkResult.Error) -> Unit) = fetch(workspaceId, onError)

    fun delete(id: String) {
        viewModelScope.launch {
            when (val r = repository.deleteSession(id)) {
                is NetworkResult.Success -> {
                    // Optimistically drop it from the current list, then re-sync.
                    val current = _uiState.value
                    if (current is SessionListUiState.Content) {
                        val remaining = current.model.allSessions.filterNot { it.id == id }
                        _uiState.value = SessionListUiState.Content(
                            groupByCwd(remaining, WorkspaceSelection.selectedPath.value),
                        )
                    }
                    refresh()
                }
                is NetworkResult.Error -> {
                    _message.value = friendlyError(r)
                }
            }
        }
    }

    fun clearRenameError() {
        _renameError.value = null
    }

    fun rename(id: String, title: String, onSuccess: () -> Unit) {
        val trimmed = title.trim()
        if (trimmed.isEmpty() || _renameSubmitting.value) return
        _renameSubmitting.value = true
        _renameError.value = null
        viewModelScope.launch {
            try {
                when (val result = repository.renameSession(id, trimmed)) {
                    is NetworkResult.Success -> {
                        val current = _uiState.value
                        if (current is SessionListUiState.Content) {
                            val sessions = current.model.allSessions
                            _uiState.value = SessionListUiState.Content(
                                groupByCwd(
                                    sessions.map { if (it.id == id) it.copy(title = trimmed) else it },
                                    WorkspaceSelection.selectedPath.value,
                                ),
                            )
                        }
                        onSuccess()
                        refreshSilently()
                    }
                    is NetworkResult.Error -> _renameError.value = friendlyError(result)
                }
            } finally {
                _renameSubmitting.value = false
            }
        }
    }

    fun consumeMessage() {
        _message.value = null
    }
}
