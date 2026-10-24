package com.noresign.paboot.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.noresign.paboot.data.repository.ScheduledTaskRepository
import com.noresign.paboot.network.daemon.dto.ScheduledTaskDto
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.util.friendlyError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class SessionTasksUiState(
    val loading: Boolean = true,
    val tasks: List<ScheduledTaskDto> = emptyList(),
    val error: String? = null,
)

/** Read-only list of the scheduled tasks attached to one session. */
class SessionTasksViewModel(
    private val repository: ScheduledTaskRepository = ScheduledTaskRepository(),
) : ViewModel() {

    private val _state = MutableStateFlow(SessionTasksUiState())
    val state = _state.asStateFlow()

    fun load(sessionId: String) {
        viewModelScope.launch {
            _state.value = SessionTasksUiState(loading = true)
            when (val r = repository.list(workspaceId = null, sessionId = sessionId)) {
                is NetworkResult.Success -> _state.value = SessionTasksUiState(loading = false, tasks = r.data)
                is NetworkResult.Error -> _state.value = SessionTasksUiState(
                    loading = false,
                    error = friendlyError(r),
                )
            }
        }
    }
}
