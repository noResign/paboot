package com.noresign.paboot.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.noresign.paboot.data.WorkspaceSelection
import com.noresign.paboot.data.repository.ScheduledTaskRepository
import com.noresign.paboot.data.repository.SessionRepository
import com.noresign.paboot.model.task.TaskDraft
import com.noresign.paboot.network.daemon.dto.ScheduledTaskDetailResponse
import com.noresign.paboot.network.daemon.dto.ScheduledTaskDto
import com.noresign.paboot.network.daemon.dto.SessionDto
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.util.friendlyError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed class TasksUiState {
    object Loading : TasksUiState()
    data class Content(val tasks: List<ScheduledTaskDto>) : TasksUiState()
    data class Error(val message: String) : TasksUiState()
}

class ScheduledTasksViewModel(
    private val repository: ScheduledTaskRepository = ScheduledTaskRepository(),
    private val sessionRepository: SessionRepository = SessionRepository(),
) : ViewModel() {

    private val _uiState = MutableStateFlow<TasksUiState>(TasksUiState.Loading)
    val uiState = _uiState.asStateFlow()

    /** Candidate sessions for retargeting an AI task; `null` while loading. */
    private val _targetSessions = MutableStateFlow<List<SessionDto>?>(null)
    val targetSessions = _targetSessions.asStateFlow()

    private val _detail = MutableStateFlow<ScheduledTaskDetailResponse?>(null)
    val detail = _detail.asStateFlow()

    private val _message = MutableStateFlow<String?>(null)
    val message = _message.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing = _refreshing.asStateFlow()

    private val _submitting = MutableStateFlow(false)
    val submitting = _submitting.asStateFlow()

    private val _startingConfig = MutableStateFlow(false)
    val startingConfig = _startingConfig.asStateFlow()

    private val _editorError = MutableStateFlow<String?>(null)
    val editorError = _editorError.asStateFlow()

    init {
        viewModelScope.launch {
            WorkspaceSelection.selectedId.collect { workspaceId ->
                _uiState.value = TasksUiState.Loading
                fetch(workspaceId)
            }
        }
    }

    fun refresh() {
        viewModelScope.launch {
            _uiState.value = TasksUiState.Loading
            fetch(WorkspaceSelection.current())
        }
    }

    fun refreshSilently() {
        viewModelScope.launch { refetchQuietly() }
    }

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

    private suspend fun refetchQuietly() = fetch(WorkspaceSelection.current()) { error ->
        if (_uiState.value !is TasksUiState.Content) {
            _uiState.value = TasksUiState.Error(friendlyError(error))
        } else {
            _message.value = friendlyError(error)
        }
    }

    private suspend fun fetch(
        workspaceId: String?,
        onError: (NetworkResult.Error) -> Unit = { error ->
            _uiState.value = TasksUiState.Error(friendlyError(error))
        },
    ) {
        when (val r = repository.list(workspaceId)) {
            is NetworkResult.Success -> _uiState.value = TasksUiState.Content(r.data)
            is NetworkResult.Error -> {
                if (r.apiCode == "workspace_not_found" && workspaceId != null) {
                    WorkspaceSelection.select(null)
                    return
                }
                onError(r)
            }
        }
    }

    fun openDetail(id: String) {
        viewModelScope.launch {
            when (val r = repository.detail(id)) {
                is NetworkResult.Success -> _detail.value = r.data
                is NetworkResult.Error -> _message.value = friendlyError(r)
            }
        }
    }

    fun closeDetail() {
        _detail.value = null
    }

    /** Opens/creates the reusable AI authoring chat and hands its session id back. */
    fun startConfigSession(onReady: (String) -> Unit) {
        if (_startingConfig.value) return
        _startingConfig.value = true
        viewModelScope.launch {
            try {
                when (val r = repository.startConfigSession(WorkspaceSelection.current())) {
                    is NetworkResult.Success -> onReady(r.data.sessionId)
                    is NetworkResult.Error -> _message.value = friendlyError(r)
                }
            } finally {
                _startingConfig.value = false
            }
        }
    }

    fun loadTargetSessions(workspaceId: String) {
        _targetSessions.value = null
        viewModelScope.launch {
            when (val r = sessionRepository.listSessions(workspaceId)) {
                is NetworkResult.Success -> {
                    // The reusable task-authoring chat is not a meaningful target.
                    _targetSessions.value = r.data.filter { it.purpose == null }
                }
                is NetworkResult.Error -> _targetSessions.value = emptyList()
            }
        }
    }

    fun updateTask(
        task: ScheduledTaskDto,
        draft: TaskDraft,
        scheduleEditable: Boolean,
        onSuccess: () -> Unit,
    ) {
        if (_submitting.value) return
        _submitting.value = true
        _editorError.value = null
        // `null` means "next fire creates a session"; compare the desired
        // binding with the current one so an unrelated edit does not rewrite it.
        val retarget = task.type == "ai" && draft.sessionId != task.sessionId
        viewModelScope.launch {
            try {
                when (val r = repository.update(task.id, draft, scheduleEditable, retarget)) {
                    is NetworkResult.Success -> {
                        onSuccess()
                        refetchQuietly()
                        openDetail(task.id)
                    }
                    is NetworkResult.Error -> _editorError.value = friendlyError(r)
                }
            } finally {
                _submitting.value = false
            }
        }
    }

    fun toggle(task: ScheduledTaskDto) {
        viewModelScope.launch {
            when (val r = repository.setEnabled(task.id, !task.enabled)) {
                is NetworkResult.Success -> {
                    refetchQuietly()
                    _detail.value?.let { if (it.task.id == task.id) openDetail(task.id) }
                }
                is NetworkResult.Error -> _message.value = friendlyError(r)
            }
        }
    }

    fun runNow(task: ScheduledTaskDto) {
        viewModelScope.launch {
            when (val r = repository.runNow(task.id)) {
                is NetworkResult.Success -> {
                    _message.value = "已开始运行"
                    refetchQuietly()
                    _detail.value?.let { if (it.task.id == task.id) openDetail(task.id) }
                }
                is NetworkResult.Error -> _message.value = friendlyError(r)
            }
        }
    }

    fun delete(task: ScheduledTaskDto) {
        viewModelScope.launch {
            when (val r = repository.delete(task.id)) {
                is NetworkResult.Success -> {
                    closeDetail()
                    refetchQuietly()
                }
                is NetworkResult.Error -> _message.value = friendlyError(r)
            }
        }
    }

    fun clearEditorError() {
        _editorError.value = null
    }

    fun consumeMessage() {
        _message.value = null
    }
}
