package com.noresign.paboot.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.noresign.paboot.data.WorkspaceSelection
import com.noresign.paboot.data.repository.MetaRepository
import com.noresign.paboot.data.repository.WorkspaceRepository
import com.noresign.paboot.ui.identity.defaultAgentId
import com.noresign.paboot.util.friendlyError
import com.noresign.paboot.network.daemon.dto.AgentDto
import com.noresign.paboot.network.daemon.dto.WorkspaceDto
import com.noresign.paboot.network.http.NetworkResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed class NewSessionUiState {
    object Loading : NewSessionUiState()
    data class Ready(
        val agents: List<AgentDto>,
        val workspaces: List<WorkspaceDto>,
    ) : NewSessionUiState()
    data class Error(val message: String) : NewSessionUiState()
}

class NewSessionViewModel(
    private val repository: MetaRepository = MetaRepository(),
    private val workspaceRepository: WorkspaceRepository = WorkspaceRepository(),
) : ViewModel() {

    private val _uiState = MutableStateFlow<NewSessionUiState>(NewSessionUiState.Loading)
    val uiState = _uiState.asStateFlow()

    private val _selectedAgent = MutableStateFlow<String?>(null)
    val selectedAgent = _selectedAgent.asStateFlow()

    private val _selectedWorkspaceId = MutableStateFlow(WorkspaceSelection.current())
    val selectedWorkspaceId = _selectedWorkspaceId.asStateFlow()

    private val _permissionMode = MutableStateFlow("ask")
    val permissionMode = _permissionMode.asStateFlow()

    init {
        viewModelScope.launch {
            WorkspaceSelection.selectedId.collect { workspaceId ->
                _selectedWorkspaceId.value = workspaceId
                load()
            }
        }
    }

    fun load() {
        viewModelScope.launch {
            _uiState.value = NewSessionUiState.Loading
            val agents = repository.agents()
            val workspaces = workspaceRepository.listWorkspaces()
            if (agents is NetworkResult.Error) {
                _uiState.value = NewSessionUiState.Error(friendlyError(agents))
                return@launch
            }
            if (workspaces is NetworkResult.Error) {
                _uiState.value = NewSessionUiState.Error(friendlyError(workspaces))
                return@launch
            }

            val agentList = (agents as NetworkResult.Success).data.agents
            val workspaceList = (workspaces as NetworkResult.Success).data
            val current = _selectedWorkspaceId.value
                ?.takeIf { id -> workspaceList.any { it.id == id } }
                ?: workspaceList.firstOrNull { it.isDefault }
                    ?.id
                ?: workspaceList.firstOrNull()?.id
            _selectedWorkspaceId.value = current
            if (current != null) WorkspaceSelection.select(current, workspaceList.find { it.id == current }?.path)

            val config = workspaceRepository.config()
            if (config is NetworkResult.Success) {
                _permissionMode.value = config.data.defaultPermissionMode
            }

            if (_selectedAgent.value == null) _selectedAgent.value = defaultAgentId(agentList)
            _uiState.value = NewSessionUiState.Ready(
                agents = agentList,
                workspaces = workspaceList,
            )
        }
    }

    /** 未安装的 Agent 不可选——选中它只会在发送时换来一个 503。 */
    fun selectAgent(id: String) {
        val ready = _uiState.value as? NewSessionUiState.Ready ?: return
        if (ready.agents.none { it.id == id && it.available }) return
        _selectedAgent.value = id
    }

    fun selectPermissionMode(mode: String) {
        _permissionMode.value = mode
    }
}
