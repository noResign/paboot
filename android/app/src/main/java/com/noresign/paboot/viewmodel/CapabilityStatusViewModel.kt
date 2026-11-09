package com.noresign.paboot.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.noresign.paboot.data.repository.WorkspaceRepository
import com.noresign.paboot.network.http.NetworkResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed class CapabilityStatusUiState {
    object Loading : CapabilityStatusUiState()
    data class Content(val activeEndName: String?, val onlineDevices: Int) : CapabilityStatusUiState()
    object Unavailable : CapabilityStatusUiState()
}

/** 只读能力状态：工作区概览显示端与在线设备数量。 */
class CapabilityStatusViewModel(
    private val repository: WorkspaceRepository = WorkspaceRepository(),
) : ViewModel() {

    private val _state = MutableStateFlow<CapabilityStatusUiState>(CapabilityStatusUiState.Loading)
    val state = _state.asStateFlow()

    fun load(workspaceId: String) {
        _state.value = CapabilityStatusUiState.Loading
        viewModelScope.launch {
            _state.value = when (val result = repository.capabilityStatus(workspaceId)) {
                is NetworkResult.Success -> CapabilityStatusUiState.Content(
                    activeEndName = result.data.activeEndName,
                    onlineDevices = result.data.onlineDevices,
                )
                is NetworkResult.Error -> CapabilityStatusUiState.Unavailable
            }
        }
    }
}
