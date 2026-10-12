package com.noresign.paboot.viewmodel

import android.os.SystemClock
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.noresign.paboot.data.PendingNewSession
import com.noresign.paboot.data.repository.ChatRepository
import com.noresign.paboot.data.repository.SessionRepository
import com.noresign.paboot.notify.ChatVisibility
import com.noresign.paboot.notify.RunWatchCenter
import com.noresign.paboot.util.ReconnectPolicy
import com.noresign.paboot.util.friendlyError
import com.noresign.paboot.util.friendlyMessage
import com.noresign.paboot.network.daemon.ChatStreamEvent
import com.noresign.paboot.model.chat.ChatUiMessage
import com.noresign.paboot.model.chat.ContentBlock
import com.noresign.paboot.model.chat.ContextUsage
import com.noresign.paboot.model.chat.TodoItem
import com.noresign.paboot.model.chat.UsageInfo
import com.noresign.paboot.model.chat.parseTodos
import com.noresign.paboot.network.daemon.dto.NormalizedEvent
import com.noresign.paboot.network.daemon.dto.PermissionGrantDto
import com.noresign.paboot.network.daemon.dto.SseFrame
import com.noresign.paboot.network.daemon.dto.MessageDto
import com.noresign.paboot.network.daemon.dto.RunDto
import com.noresign.paboot.network.http.NetworkResult
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.random.Random

sealed class SessionPermissionsUiState {
    object Loading : SessionPermissionsUiState()
    data class Ready(
        val mode: String,
        val grants: List<PermissionGrantDto>,
    ) : SessionPermissionsUiState()
    data class Error(val message: String) : SessionPermissionsUiState()
}

/** 回滚一次尝试的结果，供聊天页弹提示 / 升级为带 force 的二次确认。 */
sealed interface RollbackResult {
    data object Done : RollbackResult
    /** 该 run 之后还有更晚的 run，需要 `force` 才能一并丢弃。 */
    data object NeedForce : RollbackResult
    data class Failed(val message: String) : RollbackResult
}

class ChatViewModel(
    private val repository: ChatRepository = ChatRepository(),
    private val sessionRepository: SessionRepository = SessionRepository(),
) : ViewModel() {

    private val _messages = MutableStateFlow<List<ChatUiMessage>>(emptyList())
    val messages = _messages.asStateFlow()

    private val _todos = MutableStateFlow<List<TodoItem>>(emptyList())
    val todos = _todos.asStateFlow()

    private val _streaming = MutableStateFlow(false)
    val streaming = _streaming.asStateFlow()

    /** 断线自动重连中：界面据此显示横幅（此时 [streaming] 仍为 true）。 */
    private val _reconnecting = MutableStateFlow(false)
    val reconnecting = _reconnecting.asStateFlow()

    /** 进入会话后重建历史期间为 true：界面据此显示加载指示，而不是空白消息区。 */
    private val _historyLoading = MutableStateFlow(false)
    val historyLoading = _historyLoading.asStateFlow()

    private val _runId = MutableStateFlow<String?>(null)
    val runId = _runId.asStateFlow()

    private val _sessionTitle = MutableStateFlow<String?>(null)
    val sessionTitle = _sessionTitle.asStateFlow()

    private val _sessionCwd = MutableStateFlow<String?>(null)
    val sessionCwd = _sessionCwd.asStateFlow()

    private val _sessionRuntime = MutableStateFlow<String?>(null)
    val sessionRuntime = _sessionRuntime.asStateFlow()

    /**
     * 会话级：当前上下文窗口占用（顶栏展示）。
     *
     * 只在切换会话时清空——重连走 `?after=` 只回放缺口，缺口里没有 context 帧，
     * 一重置就再也补不回来，顶栏会永久空着。
     */
    private val _contextUsage = MutableStateFlow<ContextUsage?>(null)
    val contextUsage = _contextUsage.asStateFlow()

    private val _permission = MutableStateFlow<NormalizedEvent.PermissionRequest?>(null)
    val permission = _permission.asStateFlow()
    private val _permissionSubmitting = MutableStateFlow(false)
    val permissionSubmitting = _permissionSubmitting.asStateFlow()

    /**
     * 服务端对回答的校验失败（`bad_response`）——只在弹窗内展示。
     *
     * 这类错误必须贴着输入框说，不能走 [error] 的 snackbar：snackbar 在 Activity 的
     * Scaffold 里，被模态弹窗的遮罩压住，用户只会看到「点了没反应」。
     */
    private val _permissionInputError = MutableStateFlow<String?>(null)
    val permissionInputError = _permissionInputError.asStateFlow()

    // 并发工具调用会同时推多个 permission_request，排队逐个弹窗，避免后到的覆盖先到的
    private val permissionQueue = ArrayDeque<NormalizedEvent.PermissionRequest>()
    private val queuedPermissionIds = mutableSetOf<String>()

    private val _error = MutableStateFlow<String?>(null)
    val error = _error.asStateFlow()

    private val _rollbackResult = MutableStateFlow<RollbackResult?>(null)
    val rollbackResult = _rollbackResult.asStateFlow()

    private val _sessionPermissions = MutableStateFlow<SessionPermissionsUiState?>(null)
    val sessionPermissions = _sessionPermissions.asStateFlow()

    private var sessionId: String? = null
    private var streamJob: Job? = null

    /** 已收到的最大 `seq`，重连时作为 `?after=` 游标（-1 = 本轮还没收到任何帧）。 */
    private var lastSeq = -1L

    /** 流的代数：`cancel()` 存在取消不掉的窗口，靠它让旧循环彻底失效。 */
    private var streamGen = 0

    /** 用户主动停止 / 切会话 / 发新消息时置位，让在途的重连循环退出。 */
    private var giveUp = false

    // 新建会话时由 Sheet 传入的续接 Claude 会话 / runtime / Workspace / 权限模式
    private var initialClaudeSessionId: String? = null
    private var initialRuntime: String? = null
    private var initialWorkspaceId: String? = null
    private var initialPermissionMode: String? = null

    fun load(sessionId: String?) {
        // 切会话时先掐掉在途的流，否则旧 run 的帧会灌进新会话。
        cancelStream()
        // 上下文占用属于上一个会话，必须先清；打开会话时由历史重建填回。
        _contextUsage.value = null
        this.sessionId = sessionId
        // 通知的抑制条件：用户此刻正看着这个会话（新会话先登记 null，拿到 id 后再更新）
        ChatVisibility.enter(sessionId)
        sessionId?.let { RunWatchCenter.clearFor(it) }
        if (sessionId == null) {
            PendingNewSession.take()?.let {
                initialClaudeSessionId = it.claudeSessionId
                initialRuntime = it.runtime
                _sessionRuntime.value = it.runtime ?: "claude"
                initialWorkspaceId = it.workspaceId
                initialPermissionMode = it.permissionMode
            }
            return
        }
        viewModelScope.launch {
            _historyLoading.value = true
            try {
                when (val r = repository.sessionDetail(sessionId)) {
                    is NetworkResult.Success -> {
                        val session = r.data.session
                        _sessionTitle.value = session.title
                        _sessionCwd.value = session.cwd
                        _sessionRuntime.value = session.runtime
                        // runningRunId 来自另一个 module，无法直接智能转换，先取到局部变量
                        val runningRunId = session.runningRunId
                        _messages.value = reconstructHistory(r.data.runs, runningRunId, r.data.messages)
                        if (session.running && runningRunId != null) {
                            attach(runningRunId)
                        }
                    }
                    is NetworkResult.Error -> _error.value = friendlyError(r)
                }
            } finally {
                // 出错也要复位，否则指示器会一直转。
                _historyLoading.value = false
            }
        }
    }

    /**
     * 用「run + 逐 run 回放 events」重建完整历史（含思考块 / 工具卡 / 用量），
     * 而不是只看聚合后的 messages。正在运行的 run 留空、交给 attach() 续流。
     */
    private suspend fun reconstructHistory(
        runs: List<RunDto>,
        runningRunId: String?,
        messages: List<MessageDto>,
    ): List<ChatUiMessage> {
        val list = mutableListOf<ChatUiMessage>()
        for (run in runs) {
            list += ChatUiMessage.User(run.prompt)
            if (run.id == runningRunId) {
                // 运行中：attach() 会追加并续流
                list += ChatUiMessage.Assistant()
            } else {
                when (val ev = repository.runEvents(run.id)) {
                    is NetworkResult.Success -> list += buildAssistantFromEvents(ev.data.events)
                    is NetworkResult.Error -> list += ChatUiMessage.Assistant(done = true)
                }
            }
        }
        // 兜底：没有任何 run（历史遗留数据）时，退回聚合 messages
        if (list.isEmpty() && messages.isNotEmpty()) {
            list += messages.map { m ->
                if (m.role == "user") ChatUiMessage.User(m.content)
                else ChatUiMessage.Assistant(blocks = listOf(ContentBlock.Text(m.content)), done = true)
            }
        }
        return list
    }

    private fun buildAssistantFromEvents(events: List<SseFrame>): ChatUiMessage.Assistant {
        var a = ChatUiMessage.Assistant()
        for (frame in events) {
            val e = frame.event
            if (e is NormalizedEvent.PermissionRequest) continue // 审批请求是瞬态，不进历史
            if (e is NormalizedEvent.ToolUse && e.name == "TodoWrite") {
                _todos.value = parseTodos(e.input)
                continue
            }
            // 重建这条路不经过 applyEvent，所以上下文占用要在这里也喂一次，
            // 否则打开会话时顶栏会一直空着，直到下一次模型调用。
            trackContext(e)
            a = updateAssistant(a, e)
        }
        return finalizeAssistant(a)
    }

    fun send(text: String) {
        val prompt = text.trim()
        if (prompt.isEmpty() || _streaming.value) return
        if (sessionId == null && _sessionTitle.value == null) {
            _sessionTitle.value = prompt.take(60)
        }
        _messages.update { it + ChatUiMessage.User(prompt) + ChatUiMessage.Assistant() }
        _error.value = null
        // 一次性新会话选项在下面清零；重发要用同样的 body，先捕获到局部量。
        val sessionIdAtSend = sessionId
        val claudeSessionId = initialClaudeSessionId
        val runtime = initialRuntime
        val workspaceId = initialWorkspaceId
        val permissionMode = initialPermissionMode
        // 同一次发送（含重发）共用一个 commandId，让「请求刚发出就断、run id 都没拿到」
        // 能按同一 id 重发，daemon 重连到已起的 run，而不是起第二个。
        val commandId = UUID.randomUUID().toString()
        val chatFlow: () -> Flow<ChatStreamEvent> = {
            repository.chatStream(
                sessionId = sessionIdAtSend,
                prompt = prompt,
                claudeSessionId = claudeSessionId,
                runtime = runtime,
                workspaceId = workspaceId,
                permissionMode = permissionMode,
                commandId = commandId,
            )
        }
        // 新 run：seq 空间是新的，runId 要等首帧 status 才知道
        startStream(
            initialFlow = chatFlow(),
            runId = null,
            initialAfter = null,
            resendChat = chatFlow,
        )
        initialClaudeSessionId = null
        initialRuntime = null
        initialWorkspaceId = null
        initialPermissionMode = null
    }

    private fun attach(runId: String) {
        if (_streaming.value) return
        _messages.update { list ->
            val last = list.lastOrNull()
            if (last is ChatUiMessage.Assistant && !last.done) list else list + ChatUiMessage.Assistant()
        }
        // 全量回放该 run 的事件（历史重建时运行中的 run 是留空的）
        startStream(
            initialFlow = repository.runStream(runId, after = null),
            runId = runId,
            initialAfter = null,
        )
    }

    /**
     * 跑一条流，并在断线时自动续接。
     *
     * daemon 侧 run 与连接解耦（断开不杀进程），事件按 `(run_id, seq)` 落库，所以「流断了」
     * 几乎总能靠 `GET /api/runs/:id/stream?after=<lastSeq>` 续上：回放缺口后继续直播，
     * 不重建消息列表，也就不会闪烁或重复。
     *
     * @param initialFlow 首轮用的流：新会话是 `/api/chat`，重连已有 run 是 `/api/runs/:id/stream`
     * @param runId 已知的 run id；新会话传 null（首帧 `status` 才会带出来）
     * @param initialAfter 首轮的 `?after=` 游标
     * @param resendChat 连 run id 都没拿到时按同一 `commandId` 重发的流工厂；只有新会话「发送」提供
     */
    private fun startStream(
        initialFlow: Flow<ChatStreamEvent>,
        runId: String?,
        initialAfter: Long?,
        resendChat: (() -> Flow<ChatStreamEvent>)? = null,
    ) {
        streamJob?.cancel()
        val gen = ++streamGen
        _streaming.value = true
        _reconnecting.value = false
        giveUp = false
        lastSeq = -1L

        streamJob = viewModelScope.launch {
            var currentRunId = runId
            var after = initialAfter
            var flow = initialFlow
            var attempt = 0
            var unreachableSince: Long? = null

            while (isActive && !giveUp && gen == streamGen) {
                var terminal = false
                var failure: ChatStreamEvent.Failed? = null
                var frames = 0
                val startedAt = SystemClock.elapsedRealtime()

                flow.collect { evt ->
                    when (evt) {
                        is ChatStreamEvent.Frame -> {
                            frames++
                            // 收到帧说明链路已恢复，横幅撤掉（重连成功但没终局事件时靠这里收尾）
                            if (_reconnecting.value) _reconnecting.value = false
                            if (evt.frame.seq > lastSeq) lastSeq = evt.frame.seq
                            handleFrame(evt)
                            if (isTerminal(evt.frame.event)) terminal = true
                        }
                        is ChatStreamEvent.Failed -> failure = evt
                        is ChatStreamEvent.Closed -> Unit
                    }
                }
                if (!isActive || giveUp || gen != streamGen) return@launch
                // 健康判定只看流本身活了多久，不含下面探测的耗时（探测要等连接超时，会误判）
                val streamMs = SystemClock.elapsedRealtime() - startedAt

                // 新会话的 run id 来自首帧 status；首轮就失败时会拿不到。
                // 已终局就不必探测了 —— 少一次无谓的请求。
                val resumable = currentRunId ?: _runId.value
                val probed = if (terminal || resumable == null) null else repository.isRunActive(resumable)
                val now = SystemClock.elapsedRealtime()
                if (probed == null) {
                    if (unreachableSince == null) unreachableSince = now
                } else {
                    unreachableSince = null
                }

                // 连 run id 都没拿到（请求刚发出就断了）。有 commandId 就能按同一 id 重发，
                // daemon 会重连到已起的 run（或起一个，若首个请求根本没到）；否则无从续接，
                // 只能让用户重发。退避预算用完或错误不值得重试（如 400）才放弃。
                val unreachableMs = unreachableSince?.let { now - it } ?: 0L
                val decision = when {
                    !terminal && resumable == null && resendChat != null &&
                        !ReconnectPolicy.isNonRetryable(failure?.httpCode) &&
                        unreachableMs < ReconnectPolicy.UNREACHABLE_BUDGET_MS ->
                        ReconnectPolicy.Decision.Retry(ReconnectPolicy.backoffMs(attempt, Random.nextDouble()))
                    !terminal && resumable == null -> ReconnectPolicy.Decision.GiveUp
                    else -> ReconnectPolicy.decide(
                        terminal = terminal,
                        httpCode = failure?.httpCode,
                        runActive = probed,
                        unreachableMs = unreachableMs,
                        attempt = attempt,
                        jitter = Random.nextDouble(),
                    )
                }

                when (decision) {
                    ReconnectPolicy.Decision.Finished -> {
                        finish()
                        return@launch
                    }
                    ReconnectPolicy.Decision.Settled -> {
                        // run 已经从 daemon 消失（结束 / 重启 / 被看门狗取消）。
                        // 通常尾部事件在这一轮 connect 时就回放完了；但如果这一轮压根没连上
                        // （failure != null），缺的尾部得用一次性回放补上，否则消息会截断。
                        if (failure != null && resumable != null) {
                            val r = repository.runEvents(resumable, if (lastSeq >= 0) lastSeq else null)
                            if (r is NetworkResult.Success) {
                                r.data.events.forEach { handleFrame(ChatStreamEvent.Frame(it)) }
                            }
                        }
                        finish()
                        return@launch
                    }
                    ReconnectPolicy.Decision.GiveUp -> {
                        // 走同一张文案表：daemon 的错误码在这里才第一次变成人能看懂的话
                        // （例如 runtime_unavailable → 「该 Agent 未安装…」）。
                        _error.value = failure
                            ?.let { friendlyMessage(it.apiCode, it.httpCode, it.message) }
                            ?: if (resumable == null) "请求未送达，请重新发送" else "连接已断开"
                        finish(clearPermissions = false, markDone = false)
                        return@launch
                    }
                    is ReconnectPolicy.Decision.Retry -> {
                        // 这一轮收到过帧、或流活过了健康阈值，就认为退避该归零；
                        // 反之（连上就被掐断）才加长退避
                        attempt = if (frames > 0 || streamMs > ReconnectPolicy.HEALTHY_ATTEMPT_MS) {
                            0
                        } else {
                            attempt + 1
                        }
                        _reconnecting.value = true
                        delay(decision.delayMs)
                        after = if (lastSeq >= 0) lastSeq else initialAfter
                        flow = if (resumable != null) {
                            currentRunId = resumable
                            repository.runStream(resumable, after)
                        } else {
                            // resumable == null 时按同一 commandId 重发（见上面的判定）
                            resendChat!!()
                        }
                    }
                }
            }
        }
    }

    /** 掐断在途的流（含在途的重连循环），不碰 run 本身。 */
    private fun cancelStream() {
        giveUp = true
        streamGen++
        streamJob?.cancel()
        streamJob = null
        _reconnecting.value = false
        _streaming.value = false
    }

    private fun handleFrame(evt: ChatStreamEvent.Frame) {
        val frame = evt.frame
        _runId.value = frame.runId
        val e = frame.event
        if (e is NormalizedEvent.Status) e.runtime?.let { _sessionRuntime.value = it }
        if (e is NormalizedEvent.Status && e.sessionId != null && sessionId == null) {
            sessionId = e.sessionId
            ChatVisibility.enter(sessionId)
            sessionId?.let { RunWatchCenter.clearFor(it) }
        }
        // 登记后台监听：离开会话页（或锁屏后进程被回收）时，审批 / 完成仍能弹通知。
        // 同一 run 重复登记只更新标题，daemon 允许同一 run 有多个订阅者。
        // 终局帧不登记：run 即将收口，登记等于立刻又发起一条注定落空的连接。
        val terminal = isTerminal(e)
        if (!terminal) {
            sessionId?.let { RunWatchCenter.watch(frame.runId, it, _sessionTitle.value) }
        }
        when (e) {
            is NormalizedEvent.PermissionRequest -> enqueuePermission(e)
            else -> applyEvent(e)
        }
        if (terminal) {
            // 非终态 error 是"过程中的告警"（如 Codex 偶尔的模型列表刷新失败），运行最终
            // 成功时不该在一条好回答上留一条红字；失败时那条 error 事件本身就是结论。
            if (e is NormalizedEvent.Status && e.label == "succeeded") clearLastAssistantError()
            finish()
        }
    }

    private fun clearLastAssistantError() {
        _messages.update { list ->
            val last = list.lastIndex
            if (last < 0) return@update list
            list.mapIndexed { i, m ->
                if (i == last && m is ChatUiMessage.Assistant && m.error != null) m.copy(error = null) else m
            }
        }
    }

    private fun isTerminal(e: NormalizedEvent): Boolean = when (e) {
        is NormalizedEvent.Status -> e.terminal == true
        is NormalizedEvent.Error -> e.terminal == true
        else -> false
    }

    fun openSessionPermissions() {
        val id = sessionId ?: return
        _sessionPermissions.value = SessionPermissionsUiState.Loading
        viewModelScope.launch {
            when (val r = sessionRepository.permissions(id)) {
                is NetworkResult.Success -> _sessionPermissions.value = SessionPermissionsUiState.Ready(
                    mode = r.data.mode,
                    grants = r.data.grants,
                )
                is NetworkResult.Error -> _sessionPermissions.value = SessionPermissionsUiState.Error(friendlyError(r))
            }
        }
    }

    fun closeSessionPermissions() {
        _sessionPermissions.value = null
    }

    fun updateSessionPermissionMode(mode: String) {
        val id = sessionId ?: return
        viewModelScope.launch {
            when (val r = sessionRepository.updatePermissionMode(id, mode)) {
                is NetworkResult.Success -> openSessionPermissions()
                is NetworkResult.Error -> _error.value = friendlyError(r)
            }
        }
    }

    fun revokePermissionGrant(toolName: String) {
        val id = sessionId ?: return
        viewModelScope.launch {
            when (val r = sessionRepository.deletePermissionGrant(id, toolName)) {
                is NetworkResult.Success -> openSessionPermissions()
                is NetworkResult.Error -> _error.value = friendlyError(r)
            }
        }
    }

    fun revokeAllPermissionGrants() {
        val id = sessionId ?: return
        viewModelScope.launch {
            when (val r = sessionRepository.deletePermissionGrants(id)) {
                is NetworkResult.Success -> openSessionPermissions()
                is NetworkResult.Error -> _error.value = friendlyError(r)
            }
        }
    }

    /**
     * 结束当前流。[markDone] 为 false 时保留最后一条回复的"未完成"状态——放弃重连时用，
     * 否则被中断的回复会被标成已完成，用户既看不出区别也无法再续。
     */
    private fun finish(clearPermissions: Boolean = true, markDone: Boolean = true) {
        _streaming.value = false
        _reconnecting.value = false
        _runId.value = null
        if (clearPermissions) {
            _permission.value = null
            _permissionInputError.value = null
            permissionQueue.clear()
            queuedPermissionIds.clear()
        }
        if (markDone) {
            _messages.update { list ->
                val lastIndex = list.lastIndex
                list.mapIndexed { i, m ->
                    if (i == lastIndex && m is ChatUiMessage.Assistant) finalizeAssistant(m) else m
                }
            }
        }
    }

    private fun applyEvent(e: NormalizedEvent) {
        if (e is NormalizedEvent.ToolUse && e.name == "TodoWrite") {
            _todos.value = parseTodos(e.input)
            return
        }
        trackContext(e)
        _messages.update { list ->
            val idx = list.indexOfLast { it is ChatUiMessage.Assistant }
            if (idx < 0) {
                list + ChatUiMessage.Assistant()
            } else {
                val mutable = list.toMutableList()
                mutable[idx] = updateAssistant(mutable[idx] as ChatUiMessage.Assistant, e)
                mutable
            }
        }
    }

    private fun updateAssistant(a: ChatUiMessage.Assistant, e: NormalizedEvent): ChatUiMessage.Assistant = when (e) {
        is NormalizedEvent.Status -> if (e.terminal == true) finalizeAssistant(a) else a
        is NormalizedEvent.TextDelta -> a.copy(blocks = appendText(a.blocks, e.delta))
        is NormalizedEvent.ThinkingDelta -> a.copy(blocks = appendThinking(a.blocks, e.delta))
        is NormalizedEvent.ThinkingStart -> a
        is NormalizedEvent.ToolUse -> a.copy(
            blocks = a.blocks + ContentBlock.ToolUse(id = e.id, name = e.name, input = e.input, running = true)
        )
        is NormalizedEvent.ToolResult -> a.copy(
            blocks = a.blocks.map { b ->
                if (b is ContentBlock.ToolUse && b.id == e.toolUseId) {
                    b.copy(
                        result = e.content,
                        isError = e.isError == true,
                        interrupted = e.interrupted == true,
                        running = false,
                    )
                } else {
                    b
                }
            }
        )
        is NormalizedEvent.Usage -> a.copy(usage = parseUsage(e) ?: a.usage)
        is NormalizedEvent.TurnEnd -> a
        is NormalizedEvent.Error ->
            if (e.terminal == true) finalizeAssistant(a.copy(error = e.message)) else a.copy(error = e.message)
        is NormalizedEvent.PermissionRequest -> a
        is NormalizedEvent.Question -> a.copy(
            blocks = a.blocks + ContentBlock.Question(toolUseId = e.toolUseId, questions = e.questions)
        )
    }

    /**
     * 收口一条助手回复：标 done，并把还没拿到结果的工具卡标成「中断」。
     *
     * daemon 也会在 run 结束时补发中断结果，但点「停止」时客户端已经提前掐了流、读不到那一帧，
     * 所以本地收口必须自己再关一遍，否则卡片会一直转圈。
     */
    private fun finalizeAssistant(a: ChatUiMessage.Assistant): ChatUiMessage.Assistant {
        if (a.done && a.blocks.none { it is ContentBlock.ToolUse && it.running }) return a
        return a.copy(
            done = true,
            blocks = a.blocks.map { b ->
                if (b is ContentBlock.ToolUse && b.running) b.copy(running = false, interrupted = true) else b
            },
        )
    }

    private fun appendText(blocks: List<ContentBlock>, delta: String): List<ContentBlock> {
        val last = blocks.lastOrNull()
        return if (last is ContentBlock.Text) {
            blocks.dropLast(1) + last.copy(text = last.text + delta)
        } else {
            blocks + ContentBlock.Text(delta)
        }
    }

    private fun appendThinking(blocks: List<ContentBlock>, delta: String): List<ContentBlock> {
        val last = blocks.lastOrNull()
        return if (last is ContentBlock.Thinking) {
            blocks.dropLast(1) + last.copy(text = last.text + delta)
        } else {
            blocks + ContentBlock.Thinking(delta)
        }
    }

    /**
     * 会话级上下文占用：只认带 `contextTokens` 的帧。
     *
     * 字段缺省表示「本帧不含此信息」（例如运行时的传输层错误帧），必须保留上一个已知值，
     * 不能当成 0 或清空。
     */
    private fun trackContext(e: NormalizedEvent) {
        if (e !is NormalizedEvent.Usage) return
        val tokens = e.contextTokens ?: return
        _contextUsage.value = ContextUsage(tokens = tokens, window = e.contextWindow)
    }

    private fun parseUsage(u: NormalizedEvent.Usage): UsageInfo? {
        val obj = u.usage as? JsonObject
        val input = (obj?.get("input_tokens") as? JsonPrimitive)?.content?.toLongOrNull()
        val output = (obj?.get("output_tokens") as? JsonPrimitive)?.content?.toLongOrNull()
        if (input == null && output == null && u.costUsd == null) return null
        return UsageInfo(inputTokens = input, outputTokens = output, costUsd = u.costUsd)
    }

    fun answerQuestion(toolUseId: String, answerText: String) {
        if (_streaming.value || answerText.isBlank()) return
        _messages.update { list ->
            list.map { m ->
                if (m is ChatUiMessage.Assistant) {
                    m.copy(blocks = m.blocks.map { b ->
                        if (b is ContentBlock.Question && b.toolUseId == toolUseId) b.copy(answered = true)
                        else b
                    })
                } else m
            }
        }
        send(answerText)
    }

    fun decidePermission(decision: String, reason: String? = null, response: JsonElement? = null) {
        val p = _permission.value ?: return
        if (_permissionSubmitting.value) return
        _permissionSubmitting.value = true
        _permissionInputError.value = null
        viewModelScope.launch {
            try {
                when (val r = repository.decidePermission(p.permissionId, decision, reason, response)) {
                    is NetworkResult.Success -> dismissPermission(p.permissionId)
                    is NetworkResult.Error -> {
                        // 回答没通过服务端校验：错误属于这次输入，回填进弹窗而不是 snackbar。
                        if (r.apiCode == "bad_response") {
                            _permissionInputError.value = friendlyError(r)
                        } else {
                            _error.value = friendlyError(r)
                        }
                        // Keep the input on transient failures so the operator can retry.
                        if (r.code == 404 || r.code == 409) dismissPermission(p.permissionId)
                    }
                }
            } finally {
                _permissionSubmitting.value = false
            }
        }
    }

    private fun enqueuePermission(req: NormalizedEvent.PermissionRequest) {
        // 已决（allowed/denied/timed_out）状态帧表示该请求不需要再审批：
        // 重连回放时跳过，运行中收到状态更新时还要把已排队的同 id 请求移除。
        if (req.status != null && req.status != "pending") {
            dismissPermission(req.permissionId)
            return
        }
        if (!queuedPermissionIds.add(req.permissionId)) return
        if (_permission.value == null) {
            _permissionInputError.value = null
            _permission.value = req
        } else {
            permissionQueue.addLast(req)
        }
    }

    private fun dismissPermission(permissionId: String) {
        queuedPermissionIds.remove(permissionId)
        val remaining = permissionQueue.filterNot { it.permissionId == permissionId }
        permissionQueue.clear()
        permissionQueue.addAll(remaining)
        if (_permission.value?.permissionId == permissionId) {
            // 弹窗换人：上一条请求的输入错误不能跟到下一条。
            _permissionInputError.value = null
            _permission.value = permissionQueue.removeFirstOrNull()
        }
    }

    fun stop() {
        // 先取 runId：cancelStream() 会把 _runId 清掉
        val rid = _runId.value
        cancelStream()
        finish()
        if (rid != null) {
            viewModelScope.launch { repository.cancelRun(rid) }
        }
    }

    fun consumeError() {
        _error.value = null
    }

    /**
     * 回滚工作区到该 run 之前（破坏性）。`later_runs_exist` 时不要 force 直接重试，
     * 交给 UI 二次确认后再 `rollback(force = true)`。
     */
    fun rollback(force: Boolean = false) {
        val rid = _runId.value ?: return
        viewModelScope.launch {
            _rollbackResult.value = when (val r = repository.rollbackRun(rid, force)) {
                is NetworkResult.Success -> RollbackResult.Done
                is NetworkResult.Error ->
                    if (r.apiCode == "later_runs_exist") RollbackResult.NeedForce else RollbackResult.Failed(r.message)
            }
        }
    }

    fun consumeRollbackResult() {
        _rollbackResult.value = null
    }

    override fun onCleared() {
        // 离开聊天页：不再算「用户正看着这个会话」
        ChatVisibility.exit(sessionId)
        super.onCleared()
    }
}
