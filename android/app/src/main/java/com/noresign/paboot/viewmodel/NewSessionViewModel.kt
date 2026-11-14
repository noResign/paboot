package com.noresign.paboot.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.noresign.paboot.data.WorkspaceSelection
import com.noresign.paboot.data.repository.MetaRepository
import com.noresign.paboot.data.repository.WorkspaceRepository
import com.noresign.paboot.ui.identity.clampPermissionMode
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
        val bypassAllowed: Boolean = true,
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

    /** The workspace whose defaults have already been applied to this form. */
    private var defaultsWorkspaceId: String? = null

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
            val currentWorkspaceSelection = workspaceList.find { it.id == current }
            if (current != null) {
                WorkspaceSelection.select(
                    current,
                    currentWorkspaceSelection?.path,
                    currentWorkspaceSelection?.family,
                )
            }

            val config = workspaceRepository.config()
            val configData = if (config is NetworkResult.Success) config.data else null
            val bypassAllowed = configData?.bypassAllowed ?: true
            val globalPermission = configData?.defaultPermissionMode ?: _permissionMode.value
            _permissionMode.value = clampPermissionMode(_permissionMode.value, bypassAllowed)

            val currentWorkspace = workspaceList.find { it.id == current }
            // Apply workspace defaults when the workspace changes; a manual
            // choice made while the sheet is open is not overwritten by a
            // background refresh.
            if (defaultsWorkspaceId != current) {
                defaultsWorkspaceId = current
                _permissionMode.value = clampPermissionMode(
                    currentWorkspace?.defaultPermissionMode ?: globalPermission,
                    bypassAllowed,
                )
                val workspaceRuntime = currentWorkspace?.defaultRuntime
                _selectedAgent.value = workspaceRuntime
                    ?.takeIf { id -> agentList.any { it.id == id && it.available } }
                    ?: defaultAgentId(agentList)
            } else if (_selectedAgent.value == null) {
                _selectedAgent.value = defaultAgentId(agentList)
            }
            _uiState.value = NewSessionUiState.Ready(
                agents = agentList,
                workspaces = workspaceList,
                bypassAllowed = bypassAllowed,
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
        val allowed = (_uiState.value as? NewSessionUiState.Ready)?.bypassAllowed ?: true
        _permissionMode.value = clampPermissionMode(mode, allowed)
    }
}
