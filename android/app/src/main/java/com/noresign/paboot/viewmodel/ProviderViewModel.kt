package com.noresign.paboot.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.noresign.paboot.data.repository.ProviderRepository
import com.noresign.paboot.network.daemon.dto.ProviderDto
import com.noresign.paboot.network.daemon.dto.ProviderModelDto
import com.noresign.paboot.network.http.NetworkResult
import com.noresign.paboot.util.friendlyError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class ProviderDraft(
    val id: String,
    val kind: String,
    val label: String,
    val baseUrl: String,
    val apiKey: String = "",
    val clearKey: Boolean = false,
    /** One model id per line; existing metadata is preserved by id. */
    val modelIds: String = "",
)

data class ProviderUiState(
    val loading: Boolean = true,
    val providers: List<ProviderDto> = emptyList(),
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
)

/** Provider CRUD/test state for the settings screen. */
class ProviderViewModel(
    private val repository: ProviderRepository = ProviderRepository(),
) : ViewModel() {
    private val _uiState = MutableStateFlow(ProviderUiState())
    val uiState = _uiState.asStateFlow()

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(loading = true, error = null)
            when (val result = repository.list()) {
                is NetworkResult.Success -> {
                    _uiState.value = _uiState.value.copy(
                        loading = false,
                        providers = result.data,
                    )
                }
                is NetworkResult.Error -> {
                    _uiState.value = _uiState.value.copy(loading = false, error = friendlyError(result))
                }
            }
        }
    }

    fun save(original: ProviderDto?, draft: ProviderDraft) {
        if (draft.id.isBlank() || draft.baseUrl.isBlank()) {
            _uiState.value = _uiState.value.copy(error = "Provider id 和 Base URL 不能为空")
            return
        }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(busy = true, error = null, notice = null)
            val models = buildModels(original, draft.modelIds)
            val label = draft.label.trim().ifEmpty { draft.id.trim() }
            val body = buildJsonObject {
                if (original == null) {
                    put("id", draft.id.trim())
                    put("kind", draft.kind)
                    put("label", label)
                    put("baseUrl", draft.baseUrl.trim())
                    put("models", models)
                    if (draft.apiKey.isNotBlank()) put("apiKey", draft.apiKey.trim())
                } else {
                    put("kind", draft.kind)
                    put("label", label)
                    put("baseUrl", draft.baseUrl.trim())
                    put("models", models)
                    if (draft.clearKey) put("apiKey", JsonNull)
                    else if (draft.apiKey.isNotBlank()) put("apiKey", draft.apiKey.trim())
                }
            }
            val result = if (original == null) repository.create(body) else repository.update(original.id, body)
            _uiState.value = when (result) {
                is NetworkResult.Success -> _uiState.value.copy(
                    busy = false,
                    notice = "已保存 ${result.data.label.ifBlank { result.data.id }}",
                ).also { load() }
                is NetworkResult.Error -> _uiState.value.copy(busy = false, error = friendlyError(result))
            }
        }
    }

    fun delete(provider: ProviderDto) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(busy = true, error = null, notice = null)
            when (val result = repository.delete(provider.id)) {
                is NetworkResult.Success -> {
                    _uiState.value = _uiState.value.copy(busy = false, notice = "已删除 ${provider.id}")
                    load()
                }
                is NetworkResult.Error -> {
                    _uiState.value = _uiState.value.copy(busy = false, error = friendlyError(result))
                }
            }
        }
    }

    fun test(provider: ProviderDto) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(busy = true, error = null, notice = "正在测试 ${provider.id}…")
            when (val result = repository.test(provider.id)) {
                is NetworkResult.Success -> {
                    _uiState.value = _uiState.value.copy(
                        busy = false,
                        notice = "连接成功 · ${result.data.latencyMs}ms · ${result.data.modelCount ?: 0} 个模型",
                    )
                }
                is NetworkResult.Error -> {
                    _uiState.value = _uiState.value.copy(busy = false, error = friendlyError(result))
                }
            }
        }
    }

    fun refreshModels(provider: ProviderDto) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(busy = true, error = null, notice = "正在刷新模型…")
            when (val result = repository.refreshModels(provider.id)) {
                is NetworkResult.Success -> {
                    _uiState.value = _uiState.value.copy(
                        busy = false,
                        notice = "已刷新 · ${result.data.models.size} 个模型",
                    )
                    load()
                }
                is NetworkResult.Error -> {
                    _uiState.value = _uiState.value.copy(busy = false, error = friendlyError(result))
                }
            }
        }
    }

    fun clearMessages() {
        _uiState.value = _uiState.value.copy(error = null, notice = null)
    }

    private fun buildModels(original: ProviderDto?, text: String): kotlinx.serialization.json.JsonArray {
        val existing = original?.models?.associateBy { it.id }.orEmpty()
        return buildJsonArray {
            text.lineSequence()
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .distinct()
                .forEach { id ->
                    val old = existing[id] ?: ProviderModelDto(
                        id = id,
                        supportsTools = true,
                        supportsImages = false,
                        enabled = true,
                    )
                    add(buildJsonObject {
                        put("id", id)
                        old.label?.let { put("label", it) }
                        old.contextWindow?.let { put("contextWindow", it) }
                        old.maxOutput?.let { put("maxOutput", it) }
                        old.supportsTools?.let { put("supportsTools", it) }
                        old.supportsImages?.let { put("supportsImages", it) }
                        old.enabled?.let { put("enabled", it) }
                    })
                }
        }
    }
}
