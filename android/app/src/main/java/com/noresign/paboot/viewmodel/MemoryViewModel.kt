package com.noresign.paboot.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.noresign.paboot.data.repository.MemoryRepository
import com.noresign.paboot.network.daemon.dto.MemoryClaimDto
import com.noresign.paboot.network.daemon.dto.MemoryDuplicateDto
import com.noresign.paboot.network.daemon.dto.MemoryEntityDto
import com.noresign.paboot.network.daemon.dto.MemoryStatusDto
import com.noresign.paboot.network.daemon.dto.MemoryTimelineItemDto
import com.noresign.paboot.network.daemon.dto.WorkspaceMemoryDto
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.util.friendlyError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed class MemoryUiState {
    object Loading : MemoryUiState()
    data class Content(
        val claims: List<MemoryClaimDto>,
        val status: MemoryStatusDto?,
        val settings: WorkspaceMemoryDto? = null,
        val timeline: List<MemoryTimelineItemDto> = emptyList(),
        val duplicates: List<MemoryDuplicateDto> = emptyList(),
        val entities: List<MemoryEntityDto> = emptyList(),
    ) : MemoryUiState()
    data class Error(val message: String) : MemoryUiState()
}

/** Memory M0：只读 + 改正 / 忘记。 */
class MemoryViewModel(
    private val repository: MemoryRepository = MemoryRepository(),
) : ViewModel() {

    private val _state = MutableStateFlow<MemoryUiState>(MemoryUiState.Loading)
    val state = _state.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()

    private val _message = MutableStateFlow<String?>(null)
    val message = _message.asStateFlow()

    private var workspaceId: String? = null

    fun load(workspaceId: String, refresh: Boolean = false) {
        this.workspaceId = workspaceId
        if (!refresh && _state.value is MemoryUiState.Content) return
        _state.value = MemoryUiState.Loading
        viewModelScope.launch {
            val claims = repository.list(workspaceId)
            val status = repository.status(workspaceId)
            val settings = repository.settings(workspaceId)
            val timeline = repository.timeline(workspaceId)
            val duplicates = repository.duplicates(workspaceId)
            val entities = repository.entities(workspaceId)
            val currentSettings = (settings as? NetworkResult.Success)?.data
            when {
                claims is NetworkResult.Error &&
                    claims.apiCode == "memory_not_enabled" &&
                    currentSettings != null -> _state.value = MemoryUiState.Content(
                    claims = emptyList(),
                    status = null,
                    settings = currentSettings,
                    timeline = emptyList(),
                    duplicates = emptyList(),
                    entities = emptyList(),
                )
                claims is NetworkResult.Error -> _state.value = MemoryUiState.Error(friendlyError(claims))
                claims is NetworkResult.Success -> _state.value = MemoryUiState.Content(
                    claims = claims.data,
                    status = (status as? NetworkResult.Success)?.data,
                    settings = currentSettings,
                    timeline = (timeline as? NetworkResult.Success)?.data ?: emptyList(),
                    duplicates = (duplicates as? NetworkResult.Success)?.data ?: emptyList(),
                    entities = (entities as? NetworkResult.Success)?.data ?: emptyList(),
                )
            }
        }
    }

    fun correct(id: String, summary: String, objectText: String) {
        val workspaceId = workspaceId ?: return
        viewModelScope.launch {
            _busy.value = true
            when (val result = repository.correct(workspaceId, id, summary, objectText)) {
                is NetworkResult.Success -> {
                    _message.value = "已改正，之后以你确认的为准"
                    load(workspaceId, refresh = true)
                }
                is NetworkResult.Error -> _message.value = friendlyError(result)
            }
            _busy.value = false
        }
    }

    fun forget(id: String) {
        val workspaceId = workspaceId ?: return
        viewModelScope.launch {
            _busy.value = true
            when (val result = repository.forget(workspaceId, id)) {
                is NetworkResult.Success -> {
                    _message.value = "已忘记"
                    load(workspaceId, refresh = true)
                }
                is NetworkResult.Error -> _message.value = friendlyError(result)
            }
            _busy.value = false
        }
    }

    fun clearMessage() {
        _message.value = null
    }
}
