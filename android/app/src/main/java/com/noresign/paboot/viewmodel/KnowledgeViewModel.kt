package com.noresign.paboot.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.noresign.paboot.data.repository.KnowledgeRepository
import com.noresign.paboot.network.daemon.dto.KnowledgeDocDetailDto
import com.noresign.paboot.network.daemon.dto.KnowledgeDocDto
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.util.friendlyError
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed class KnowledgeListUiState {
    object Loading : KnowledgeListUiState()
    data class Content(val documents: List<KnowledgeDocDto>) : KnowledgeListUiState()
    data class Error(val message: String) : KnowledgeListUiState()
}

/**
 * K0 knowledge for mobile: list / detail + the human-verification toggle.
 * Editing stays on desktop so the phone never becomes a half-featured editor.
 */
class KnowledgeViewModel(
    private val repository: KnowledgeRepository = KnowledgeRepository(),
) : ViewModel() {

    private val _listState = MutableStateFlow<KnowledgeListUiState>(KnowledgeListUiState.Loading)
    val listState = _listState.asStateFlow()

    private val _detail = MutableStateFlow<KnowledgeDocDetailDto?>(null)
    val detail = _detail.asStateFlow()

    private val _detailLoading = MutableStateFlow(false)
    val detailLoading = _detailLoading.asStateFlow()

    private val _submitting = MutableStateFlow(false)
    val submitting = _submitting.asStateFlow()

    private val _message = MutableStateFlow<String?>(null)
    val message = _message.asStateFlow()

    private var workspaceId: String? = null
    private var status: String? = null
    private var verified: Boolean? = null
    private var query: String? = null
    private var loadJob: Job? = null
    private var loadGeneration = 0

    fun load(
        workspaceId: String,
        status: String? = null,
        verified: Boolean? = null,
        q: String? = null,
    ) {
        val workspaceChanged = this.workspaceId != workspaceId
        this.workspaceId = workspaceId
        this.status = status
        this.verified = verified
        this.query = q

        // Keep the previous list on a filter/search refresh so switching tabs
        // does not collapse the sheet into a spinner. Show Loading only on the
        // first load, after an error, or when the workspace itself changed.
        loadGeneration += 1
        val generation = loadGeneration
        loadJob?.cancel()
        if (workspaceChanged) {
            _detail.value = null
            _listState.value = KnowledgeListUiState.Loading
        } else if (_listState.value !is KnowledgeListUiState.Content) {
            _listState.value = KnowledgeListUiState.Loading
        }

        loadJob = viewModelScope.launch {
            when (val result = repository.list(workspaceId, status, verified, q)) {
                is NetworkResult.Success -> if (generation == loadGeneration) {
                    _listState.value = KnowledgeListUiState.Content(result.data)
                }
                is NetworkResult.Error -> if (generation == loadGeneration) {
                    _listState.value = KnowledgeListUiState.Error(friendlyError(result))
                }
            }
        }
    }

    fun refresh() {
        val workspaceId = workspaceId ?: return
        load(workspaceId, status, verified, query)
    }

    fun open(id: String) {
        val workspaceId = workspaceId ?: return
        viewModelScope.launch {
            _detailLoading.value = true
            when (val result = repository.detail(workspaceId, id)) {
                is NetworkResult.Success -> _detail.value = result.data
                is NetworkResult.Error -> _message.value = friendlyError(result)
            }
            _detailLoading.value = false
        }
    }

    fun closeDetail() {
        _detail.value = null
    }

    fun setVerified(verified: Boolean) {
        val workspaceId = workspaceId ?: return
        val current = _detail.value ?: return
        viewModelScope.launch {
            _submitting.value = true
            when (val result = repository.setVerified(workspaceId, current.id, verified)) {
                is NetworkResult.Success -> {
                    _message.value = if (verified) "已标记为人工核验" else "已取消核验"
                    open(current.id)
                    refresh()
                }
                is NetworkResult.Error -> _message.value = friendlyError(result)
            }
            _submitting.value = false
        }
    }

    fun clearMessage() {
        _message.value = null
    }
}
