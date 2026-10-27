package com.noresign.paboot.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.noresign.paboot.data.WorkspaceSelection
import com.noresign.paboot.data.repository.MetaRepository
import com.noresign.paboot.data.repository.WorkspaceRepository
import com.noresign.paboot.util.friendlyError
import com.noresign.paboot.network.daemon.dto.DirectoryEntryDto
import com.noresign.paboot.network.daemon.dto.UpdateConfigRequest
import com.noresign.paboot.network.daemon.dto.WorkspaceDto
import com.noresign.paboot.network.http.NetworkResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed class DirectoryPickerUiState {
    data class Loading(val path: String?) : DirectoryPickerUiState()
    data class Ready(
        val path: String,
        val parent: String?,
        val entries: List<DirectoryEntryDto>,
        val showHidden: Boolean,
        /** 当前目录是否已注册为工作区（用于禁用「选择当前文件夹」）。 */
        val isWorkspace: Boolean,
    ) : DirectoryPickerUiState()
    data class Error(val message: String) : DirectoryPickerUiState()
}

sealed class SettingsUiState {
    object Loading : SettingsUiState()
    data class Ready(
        val version: String,
        val workspaces: List<WorkspaceDto>,
        val defaultWorkspaceId: String?,
        val defaultPermissionMode: String,
    ) : SettingsUiState()
    data class Error(val message: String) : SettingsUiState()
}

class SettingsViewModel(
    private val repository: MetaRepository = MetaRepository(),
    private val workspaceRepository: WorkspaceRepository = WorkspaceRepository(),
) : ViewModel() {

    private val _uiState = MutableStateFlow<SettingsUiState>(SettingsUiState.Loading)
    val uiState = _uiState.asStateFlow()

    private val _selectedWorkspaceId = MutableStateFlow(WorkspaceSelection.current())
    val selectedWorkspaceId = _selectedWorkspaceId.asStateFlow()

    private val _directoryPicker = MutableStateFlow<DirectoryPickerUiState?>(null)
    val directoryPicker = _directoryPicker.asStateFlow()

    /** 目录选择器的落点：null = 新增工作区；非空 = 给该工作区加一个附加目录。 */
    private val _dirTargetWorkspaceId = MutableStateFlow<String?>(null)
    val dirTargetWorkspaceId = _dirTargetWorkspaceId.asStateFlow()

    /** 改默认权限失败的提示：选项已乐观选中，失败时回滚，这里说明为什么弹回去了。 */
    private val _permissionModeError = MutableStateFlow<String?>(null)
    val permissionModeError = _permissionModeError.asStateFlow()

    init {
        load()
        // 工作区也会在「工作区管理」页被切换/新增（那是另一个 ViewModel 实例），
        // 这里跟着全局选择走，否则切换后返回本页还显示旧的工作区。
        viewModelScope.launch {
            WorkspaceSelection.selectedId.collect { workspaceId ->
                _selectedWorkspaceId.value = workspaceId
                // 选中的工作区不在本页已加载的列表里（例如刚在管理页新增），重新拉一次。
                val known = (_uiState.value as? SettingsUiState.Ready)?.workspaces
                if (workspaceId != null && known != null && known.none { it.id == workspaceId }) load()
            }
        }
    }

    fun load() {
        viewModelScope.launch {
            // 已有内容时原地刷新：改默认权限、重命名工作区等都会走 load()，
            // 每次都退回 Loading 会让整页闪一下。
            if (_uiState.value !is SettingsUiState.Ready) _uiState.value = SettingsUiState.Loading
            val health = repository.health()
            if (health is NetworkResult.Error) {
                _uiState.value = SettingsUiState.Error(friendlyError(health))
                return@launch
            }
            val workspaces = workspaceRepository.listWorkspaces()
            if (workspaces is NetworkResult.Error) {
                _uiState.value = SettingsUiState.Error(friendlyError(workspaces))
                return@launch
            }
            val config = workspaceRepository.config()
            if (config is NetworkResult.Error) {
                _uiState.value = SettingsUiState.Error(friendlyError(config))
                return@launch
            }
            val workspaceList = (workspaces as NetworkResult.Success).data
            val configData = (config as NetworkResult.Success).data
            val selected = _selectedWorkspaceId.value
                ?.takeIf { id -> workspaceList.any { it.id == id } }
                ?: configData.defaultWorkspaceId
                    ?.takeIf { id -> workspaceList.any { it.id == id } }
                ?: workspaceList.firstOrNull { it.isDefault }?.id
                ?: workspaceList.firstOrNull()?.id
            _selectedWorkspaceId.value = selected
            WorkspaceSelection.select(selected, workspaceList.find { it.id == selected }?.path)
            _uiState.value = SettingsUiState.Ready(
                version = (health as NetworkResult.Success).data.version ?: "unknown",
                workspaces = workspaceList,
                defaultWorkspaceId = configData.defaultWorkspaceId,
                defaultPermissionMode = configData.defaultPermissionMode,
            )
        }
    }

    fun selectWorkspace(workspaceId: String) {
        val workspace = (_uiState.value as? SettingsUiState.Ready)?.workspaces?.find { it.id == workspaceId }
        _selectedWorkspaceId.value = workspaceId
        WorkspaceSelection.select(workspaceId, workspace?.path)
    }

    fun setDefaultPermissionMode(mode: String) {
        val ready = _uiState.value as? SettingsUiState.Ready ?: return
        if (ready.defaultPermissionMode == mode) return
        _permissionModeError.value = null
        // 先立即选中，不等接口；成功后以服务端数据为准，失败回滚并提示。
        _uiState.value = ready.copy(defaultPermissionMode = mode)
        viewModelScope.launch {
            when (val r = workspaceRepository.updateConfig(UpdateConfigRequest(defaultPermissionMode = mode))) {
                is NetworkResult.Success -> load()
                is NetworkResult.Error -> {
                    _uiState.value = ready
                    _permissionModeError.value = friendlyError(r)
                }
            }
        }
    }

    fun renameWorkspace(workspaceId: String, name: String) {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return
        viewModelScope.launch {
            when (val r = workspaceRepository.updateWorkspace(workspaceId, name = trimmed)) {
                is NetworkResult.Success -> load()
                is NetworkResult.Error -> _uiState.value = SettingsUiState.Error(friendlyError(r))
            }
        }
    }

    fun setWorkspaceEnabled(workspaceId: String, enabled: Boolean) {
        viewModelScope.launch {
            when (val r = workspaceRepository.updateWorkspace(workspaceId, enabled = enabled)) {
                is NetworkResult.Success -> load()
                is NetworkResult.Error -> _uiState.value = SettingsUiState.Error(friendlyError(r))
            }
        }
    }

    /** [cascade] 为 true 时连同该工作区下的会话一起删；否则有会话时 daemon 会 409。 */
    fun deleteWorkspace(workspaceId: String, cascade: Boolean = false) {
        viewModelScope.launch {
            when (val r = workspaceRepository.deleteWorkspace(workspaceId, cascade)) {
                is NetworkResult.Success -> {
                    if (WorkspaceSelection.current() == workspaceId) WorkspaceSelection.select(null)
                    load()
                }
                is NetworkResult.Error -> _uiState.value = SettingsUiState.Error(friendlyError(r))
            }
        }
    }

    /** [workspaceId] 为 null 时是「新增工作区」，否则是给该工作区添加附加目录。 */
    fun openDirectoryPicker(workspaceId: String? = null) {
        _dirTargetWorkspaceId.value = workspaceId
        loadDirectories(null, false)
    }

    fun closeDirectoryPicker() {
        _directoryPicker.value = null
        _dirTargetWorkspaceId.value = null
    }

    /** 目录选择器确认：按落点分派到「新增工作区」或「添加附加目录」。 */
    fun confirmDirectoryPick() {
        val current = _directoryPicker.value as? DirectoryPickerUiState.Ready ?: return
        val target = _dirTargetWorkspaceId.value
        if (target == null) {
            createWorkspaceFromCurrentDirectory()
        } else {
            addWorkspaceDir(target, current.path)
        }
    }

    fun addWorkspaceDir(workspaceId: String, path: String) {
        viewModelScope.launch {
            when (val r = workspaceRepository.addDir(workspaceId, path)) {
                is NetworkResult.Success -> {
                    _directoryPicker.value = null
                    _dirTargetWorkspaceId.value = null
                    load()
                }
                is NetworkResult.Error -> _directoryPicker.value = DirectoryPickerUiState.Error(friendlyError(r))
            }
        }
    }

    fun removeWorkspaceDir(workspaceId: String, path: String) {
        viewModelScope.launch {
            when (val r = workspaceRepository.removeDir(workspaceId, path)) {
                is NetworkResult.Success -> load()
                is NetworkResult.Error -> _uiState.value = SettingsUiState.Error(friendlyError(r))
            }
        }
    }

    fun loadDirectories(path: String?, showHidden: Boolean = false) {
        viewModelScope.launch {
            _directoryPicker.value = DirectoryPickerUiState.Loading(path)
            when (val r = workspaceRepository.directories(path, showHidden)) {
                is NetworkResult.Success -> {
                    // 当前目录是否已是工作区：目录接口只标注子项，本级要自己比对已加载的工作区列表。
                    val known = (_uiState.value as? SettingsUiState.Ready)?.workspaces ?: emptyList()
                    _directoryPicker.value = DirectoryPickerUiState.Ready(
                        path = r.data.path,
                        parent = r.data.parent,
                        entries = r.data.entries,
                        showHidden = showHidden,
                        isWorkspace = known.any { it.path == r.data.path },
                    )
                }
                is NetworkResult.Error -> _directoryPicker.value = DirectoryPickerUiState.Error(friendlyError(r))
            }
        }
    }

    fun toggleDirectoryHidden() {
        val current = _directoryPicker.value as? DirectoryPickerUiState.Ready ?: return
        loadDirectories(current.path, !current.showHidden)
    }

    fun createWorkspaceFromCurrentDirectory() {
        val current = _directoryPicker.value as? DirectoryPickerUiState.Ready ?: return
        viewModelScope.launch {
            when (val r = workspaceRepository.createWorkspace(current.path)) {
                is NetworkResult.Success -> {
                    _selectedWorkspaceId.value = r.data.id
                    WorkspaceSelection.select(r.data.id, r.data.path)
                    _directoryPicker.value = null
                    load()
                }
                is NetworkResult.Error -> {
                    _directoryPicker.value = DirectoryPickerUiState.Error(friendlyError(r))
                }
            }
        }
    }
}
