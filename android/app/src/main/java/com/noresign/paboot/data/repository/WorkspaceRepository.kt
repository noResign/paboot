package com.noresign.paboot.data.repository

import com.noresign.paboot.data.local.SettingsStore
import com.noresign.paboot.network.daemon.PabootApi
import com.noresign.paboot.network.daemon.PabootClient
import com.noresign.paboot.network.daemon.dto.ConfigResponse
import com.noresign.paboot.network.daemon.dto.CreateWorkspaceRequest
import com.noresign.paboot.network.daemon.dto.DirectoriesResponse
import com.noresign.paboot.network.daemon.dto.UpdateConfigRequest
import com.noresign.paboot.network.daemon.dto.UpdateWorkspaceRequest
import com.noresign.paboot.network.daemon.dto.WorkspaceDirsRequest
import com.noresign.paboot.network.daemon.dto.WorkspaceDto
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.network.http.safeApiCall

class WorkspaceRepository(
    private val settings: SettingsStore = SettingsStore,
) {

    private fun api(): PabootApi? {
        val url = settings.baseUrl ?: return null
        val token = settings.token ?: return null
        return PabootClient.create(url, token)
    }

    suspend fun listWorkspaces(): NetworkResult<List<WorkspaceDto>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.workspaces() }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.workspaces)
            is NetworkResult.Error -> r
        }
    }

    suspend fun config(): NetworkResult<ConfigResponse> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall { api.config() }
    }

    suspend fun updateConfig(request: UpdateConfigRequest): NetworkResult<ConfigResponse?> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.updateConfig(request) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.config)
            is NetworkResult.Error -> r
        }
    }

    suspend fun directories(path: String? = null, showHidden: Boolean? = null): NetworkResult<DirectoriesResponse> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return safeApiCall { api.directories(path, showHidden) }
    }

    suspend fun createWorkspace(path: String, name: String? = null): NetworkResult<WorkspaceDto> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.createWorkspace(CreateWorkspaceRequest(name = name, path = path)) }) {
            is NetworkResult.Success -> r.data.workspace?.let { NetworkResult.Success(it) }
                ?: NetworkResult.Error(-2, "daemon 未返回 workspace")
            is NetworkResult.Error -> r
        }
    }

    suspend fun updateWorkspace(
        workspaceId: String,
        name: String? = null,
        enabled: Boolean? = null,
    ): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall {
            api.updateWorkspace(workspaceId, UpdateWorkspaceRequest(name = name, enabled = enabled))
        }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    /** [cascade] 为 true 时连该工作区下的会话（含聊天记录与事件）一起删掉。 */
    suspend fun deleteWorkspace(workspaceId: String, cascade: Boolean = false): NetworkResult<Unit> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.deleteWorkspace(workspaceId, cascade) }) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> r
        }
    }

    /** 授予工作区一个额外目录；返回更新后的完整列表。 */
    suspend fun addDir(workspaceId: String, path: String): NetworkResult<List<String>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.addWorkspaceDir(workspaceId, WorkspaceDirsRequest(path)) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.dirs)
            is NetworkResult.Error -> r
        }
    }

    suspend fun removeDir(workspaceId: String, path: String): NetworkResult<List<String>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.removeWorkspaceDir(workspaceId, WorkspaceDirsRequest(path)) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.dirs)
            is NetworkResult.Error -> r
        }
    }

    /** 浏览快捷方式：只多一个文件 Tab 的 tab，不授予 agent 权限。返回更新后的完整列表。 */
    suspend fun addShortcut(workspaceId: String, path: String): NetworkResult<List<String>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.addWorkspaceShortcut(workspaceId, WorkspaceDirsRequest(path)) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.shortcutDirs)
            is NetworkResult.Error -> r
        }
    }

    suspend fun removeShortcut(workspaceId: String, path: String): NetworkResult<List<String>> {
        val api = api() ?: return NetworkResult.Error(-2, "未配置连接")
        return when (val r = safeApiCall { api.removeWorkspaceShortcut(workspaceId, WorkspaceDirsRequest(path)) }) {
            is NetworkResult.Success -> NetworkResult.Success(r.data.shortcutDirs)
            is NetworkResult.Error -> r
        }
    }
}
