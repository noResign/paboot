package com.noresign.paboot.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.noresign.paboot.data.repository.WorkspaceRepository
import com.noresign.paboot.network.http.NetworkResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed class EndStatusUiState {
    object Loading : EndStatusUiState()
    data class Content(
        val archivedEndNames: List<String> = emptyList(),
        val activeEnds: List<WorkspaceRepository.EndSummary> = emptyList(),
    ) : EndStatusUiState()

    object Unavailable : EndStatusUiState()
}

/** 只读端状态：工作区概览显示启用的端与已归档端。 */
class EndStatusViewModel(
    private val repository: WorkspaceRepository = WorkspaceRepository(),
) : ViewModel() {

    private val _state = MutableStateFlow<EndStatusUiState>(EndStatusUiState.Loading)
    val state = _state.asStateFlow()

    fun load(workspaceId: String) {
        _state.value = EndStatusUiState.Loading
        viewModelScope.launch {
            _state.value = when (val result = repository.endsStatus(workspaceId)) {
                is NetworkResult.Success -> EndStatusUiState.Content(
                    archivedEndNames = result.data.archivedEndNames,
                    activeEnds = result.data.activeEnds,
                )

                is NetworkResult.Error -> EndStatusUiState.Unavailable
            }
        }
    }
}
