package com.noresign.paboot.data

import com.noresign.paboot.data.local.SettingsStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * 全局的「当前选中 Workspace」。
 *
 * 它是客户端本地状态，不写回 daemon；Sessions / Files / Settings 都监听它并在切换后刷新。
 */
object WorkspaceSelection {

    private val _selectedId = MutableStateFlow(SettingsStore.selectedWorkspaceId)
    val selectedId: StateFlow<String?> = _selectedId.asStateFlow()

    private val _selectedPath = MutableStateFlow(SettingsStore.selectedWorkspacePath)
    val selectedPath: StateFlow<String?> = _selectedPath.asStateFlow()

    /** `dev` / `life`：个人空间的目录路径不展示，界面靠它判断。 */
    private val _selectedFamily = MutableStateFlow(SettingsStore.selectedWorkspaceFamily)
    val selectedFamily: StateFlow<String?> = _selectedFamily.asStateFlow()

    fun select(workspaceId: String?, path: String? = null, family: String? = null) {
        val normalized = workspaceId?.takeIf { it.isNotBlank() }
        SettingsStore.selectedWorkspaceId = normalized
        _selectedId.value = normalized
        if (normalized == null) {
            SettingsStore.selectedWorkspacePath = null
            _selectedPath.value = null
            SettingsStore.selectedWorkspaceFamily = null
            _selectedFamily.value = null
        } else {
            if (path != null) {
                SettingsStore.selectedWorkspacePath = path
                _selectedPath.value = path
            }
            if (family != null) {
                SettingsStore.selectedWorkspaceFamily = family
                _selectedFamily.value = family
            }
        }
    }

    fun current(): String? = _selectedId.value
}
