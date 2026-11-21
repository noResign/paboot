import Combine
import Foundation
import PabootClient
import PabootProtocol

/// Drives one chat transcript: history reconstruction, live SSE, reconnect, permissions.
@MainActor
final class ChatViewModel {
    struct State {
        var title = "新会话"
        var runtime = ""
        var messages: [ChatUiMessage] = []
        var streaming = false
        var reconnecting = false
        var loadingHistory = false
        var permission: PendingPermission?
        var submittingPermissionId: String?
        var permissionError: String?
        var todos: [TodoItem] = []
        var contextUsage: ContextUsage?
        var error: String?
        var requiresReconnect = false
        var permissionMode = "ask"
        var memoryMode = "normal"
        /// Daemon-wide policy: when false, the UI must not offer bypass.
        var bypassAllowed = true
        var model: String?
        var modelParameters: [String: String] = [:]
        var models: [ModelOptionDto] = []
        var sessionId: String?
        var runId: String?
        var attachments: [ChatAttachmentDraft] = []
        /// Voice transcription in flight: composer disables the mic meanwhile.
        var transcribing = false
        /// 会话成员（助手）。空 + `agentsSupported == false` 表示老 daemon：
        /// UI 不显示任何 agent 入口，而不是显示一个空面板。
        var sessionAgents: [SessionAgentDto] = []
        var agentsSupported = false
        /// 工作区里可被拉进会话的助手（添加成员时用）。
        var workspaceAgents: [AgentProfileDto] = []
    }

    @Published private(set) var state = State()

    private let repository: any ChatRepositoryProtocol
    private let asrRepository: any AsrRepositoryProtocol
    private var sessionId: String?
    private let workspaceId: String?
    private var runtime: String?
    private let agentRepository: any AgentRepositoryProtocol

    private var streamTask: Task<Void, Never>?
    private var historyTask: Task<Void, Never>?
    /// Session watch (`/api/sessions/:id/events`); independent of any run stream.
    private var sessionWatchTask: Task<Void, Never>?
    /// Server recency, to notice runs finished while disconnected.
    private var lastActiveAt: Int64?
    /// Runs already rendered (dedupe for work started on another device).
    private var knownRunIds: Set<String> = []
    private var streamGeneration = 0
    private var lastSeq: Int64 = -1
    /// SSE frames are applied in small batches instead of one by one. Text streams
    /// token-by-token (and older daemons still stream thinking), so folding deltas
    /// keeps string growth and Combine/UI churn off the critical path.
    private var pendingFrames: [SSEFrame] = []
    private var flushTask: Task<Void, Never>?
    private static let streamFlushInterval: UInt64 = 120_000_000
    private var giveUp = false
    private var permissionQueue: [PendingPermission] = []
    private var seenPermissionIds: Set<String> = []
    private var didStart = false

    init(
        sessionId: String?,
        workspaceId: String? = nil,
        runtime: String? = nil,
        permissionMode: String? = nil,
        title: String? = nil,
        repository: any ChatRepositoryProtocol = ChatRepository(),
        asrRepository: any AsrRepositoryProtocol = AsrRepository(),
        agentRepository: any AgentRepositoryProtocol = AgentRepository()
    ) {
        self.repository = repository
        self.asrRepository = asrRepository
        self.agentRepository = agentRepository
        self.sessionId = sessionId
        self.workspaceId = workspaceId
        self.runtime = runtime

        state.sessionId = sessionId
        state.runtime = runtime ?? ""
        state.permissionMode = permissionMode ?? "ask"
        state.title = title ?? (sessionId == nil ? "新会话" : "会话")
    }

    var modelLabel: String {
        guard let model = state.model, !model.isEmpty else { return "默认模型" }
        return state.models.first(where: { $0.id == model })?.label ?? model
    }

    func start() {
        guard !didStart else { return }
        didStart = true

        Task { await loadSecurityPolicy() }
        if let sessionId {
            historyTask = Task { await loadHistory(sessionId: sessionId) }
        } else {
            loadModels()
        }
    }

    private func loadSecurityPolicy() async {
        do {
            let config = try await repository.config()
            state.bypassAllowed = config.bypassAllowed
            if !config.bypassAllowed && state.permissionMode == "bypass" {
                state.permissionMode = "acceptEdits"
            }
        } catch {
            // Older daemons may not expose the field; keep the local default.
        }
    }

    // MARK: - History

    private func loadHistory(sessionId: String, startWatch: Bool = true) async {
        state.loadingHistory = true
        defer { state.loadingHistory = false }

        do {
            let detail = try await repository.sessionDetail(id: sessionId)
            guard !Task.isCancelled else { return }
            let session = detail.session

            self.sessionId = session.id
            self.runtime = session.runtime
            state.sessionId = session.id
            state.title = session.title.flatMap { $0.isEmpty ? nil : $0 } ?? "会话"
            state.runtime = session.runtime
            state.permissionMode = PermissionModeOptions.clamp(
                session.permissionMode,
                bypassAllowed: state.bypassAllowed
            )
            state.memoryMode = session.memoryMode ?? "normal"
            state.model = session.model
            state.modelParameters = session.modelParameters ?? [:]
            lastActiveAt = session.lastActiveAt
            knownRunIds = Set(detail.runs.map(\.id))
            loadModels()
            loadSessionAgents()

            var messages: [ChatUiMessage] = []
            var todos: [TodoItem] = []
            var context: ContextUsage?
            var runningRunId: String?

            for run in detail.runs {
                messages.append(
                    ChatUiMessage(
                        id: "u-\(run.id)",
                        role: .user,
                        text: run.prompt,
                        sentAt: run.startedAt,
                        attachmentIds: run.attachmentIds
                    )
                )

                if run.id == session.runningRunId {
                    messages.append(
                        ChatUiMessage(id: "a-\(run.id)", role: .assistant, done: false)
                    )
                    runningRunId = run.id
                    continue
                }

                let frames = (try? await repository.runEvents(runId: run.id, after: nil)) ?? []
                guard !Task.isCancelled else { return }
                var assistant = ChatUiMessage(id: "a-\(run.id)", role: .assistant, done: true)

                for event in ChatEventReducer.coalesced(frames.map(\.event)) {
                    if case .permissionRequest = event {
                        continue
                    }
                    if case .toolUse(let tool) = event, tool.name == "TodoWrite" {
                        let parsed = parseTodos(tool.input)
                        if !parsed.isEmpty {
                            todos = parsed
                        }
                        continue
                    }
                    if case .usage(let usage) = event, let tokens = usage.contextTokens {
                        context = ContextUsage(tokens: tokens, window: usage.contextWindow)
                    }
                    ChatEventReducer.apply(event, to: &assistant)
                }

                ChatEventReducer.finalize(&assistant)
                messages.append(assistant)
            }

            if messages.isEmpty && !detail.messages.isEmpty {
                messages = detail.messages.enumerated().map { index, message in
                    if message.role == "user" {
                        return ChatUiMessage(
                            id: "m-\(index)",
                            role: .user,
                            text: message.content,
                            sentAt: message.createdAt
                        )
                    }
                    return ChatUiMessage(
                        id: "m-\(index)",
                        role: .assistant,
                        blocks: message.content.isEmpty ? [] : [.text(message.content)],
                        done: true
                    )
                }
            }

            state.messages = messages
            state.todos = todos
            state.contextUsage = context

            if let runningRunId {
                state.runId = runningRunId
                startStream(
                    initial: repository.runStream(runId: runningRunId, after: nil),
                    runId: runningRunId,
                    after: nil,
                    resend: nil
                )
            }
            if startWatch {
                startSessionWatch(sessionId: session.id)
            }
        } catch {
            guard !Task.isCancelled else { return }
            handleLoadError(error)
        }
    }

    private func handleLoadError(_ error: Error) {
        if let error = error as? ChatRepositoryError {
            switch error {
            case .unauthorized, .notConnected:
                state.requiresReconnect = true
                state.error = error.errorDescription
            case .failed(let message):
                state.error = message
            }
        } else {
            state.error = error.localizedDescription
        }
    }

    // MARK: - Sending

    func attachImage(_ imageData: Data, contentType: String, previewData: Data) {
        guard state.attachments.count < 8 else { return }
        let localId = UUID().uuidString
        state.attachments.append(
            ChatAttachmentDraft(
                id: localId,
                previewData: previewData,
                uploading: true
            )
        )
        Task { [weak self, repository] in
            do {
                let dto = try await repository.uploadAttachment(
                    data: imageData,
                    contentType: contentType
                )
                guard let self, let index = self.state.attachments.firstIndex(where: { $0.id == localId }) else {
                    return
                }
                self.state.attachments[index].remoteId = dto.id
                self.state.attachments[index].uploading = false
            } catch {
                guard let self, let index = self.state.attachments.firstIndex(where: { $0.id == localId }) else {
                    return
                }
                self.state.attachments[index].uploading = false
                self.state.attachments[index].error = error.localizedDescription
            }
        }
    }

    func removeAttachment(id: String) {
        state.attachments.removeAll { $0.id == id }
    }

    func attachmentData(id: String) async -> Data? {
        try? await repository.attachmentData(id: id)
    }

    /// Voice → text only. The caller appends the result to the composer; this
    /// never sends a message on the user's behalf.
    func transcribeAudio(_ data: Data) async throws -> String {
        state.transcribing = true
        defer { state.transcribing = false }
        return try await asrRepository.transcribeAudio(data)
    }

    func send(_ text: String) {
        let uploaded = state.attachments.compactMap(\.remoteId)
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = trimmed.isEmpty
            ? (uploaded.isEmpty ? "" : "请查看这些图片。")
            : trimmed
        guard
            !prompt.isEmpty,
            !state.streaming,
            !state.loadingHistory,
            !state.attachments.contains(where: { $0.uploading })
        else { return }

        if state.sessionId == nil, state.title == "新会话" {
            state.title = String(prompt.prefix(60))
        }

        state.messages.append(
            ChatUiMessage(
                id: "u-\(UUID().uuidString)",
                role: .user,
                text: prompt,
                sentAt: Int64(Date().timeIntervalSince1970 * 1000),
                attachmentIds: uploaded
            )
        )
        state.messages.append(
            ChatUiMessage(id: "a-\(UUID().uuidString)", role: .assistant, done: false)
        )
        state.error = nil

        let isNewSession = state.sessionId == nil
        let request = ChatRequest(
            prompt: prompt,
            sessionId: state.sessionId,
            workspaceId: isNewSession ? workspaceId : nil,
            model: isNewSession ? state.model : nil,
            modelParameters: isNewSession && !state.modelParameters.isEmpty ? state.modelParameters : nil,
            runtime: isNewSession ? runtime : nil,
            permissionMode: isNewSession ? state.permissionMode : nil,
            attachmentIds: uploaded.isEmpty ? nil : uploaded,
            commandId: UUID().uuidString
        )

        let resend = { [repository] in
            repository.chat(request)
        }

        startStream(
            initial: repository.chat(request),
            runId: nil,
            after: nil,
            resend: resend
        )
        state.attachments = []
    }

    func stop() {
        let runId = state.runId

        streamGeneration += 1
        streamTask?.cancel()
        streamTask = nil
        giveUp = true
        finish()

        if let runId {
            Task {
                try? await repository.cancelRun(id: runId)
            }
        }
    }

    /// Close the local stream but leave the run alone (the daemon keeps it running).
    func detach() {
        historyTask?.cancel()
        historyTask = nil
        sessionWatchTask?.cancel()
        sessionWatchTask = nil
        streamGeneration += 1
        streamTask?.cancel()
        streamTask = nil
        flushTask?.cancel()
        flushTask = nil
        pendingFrames.removeAll(keepingCapacity: true)
        state.streaming = false
        state.reconnecting = false
    }

    // MARK: - Session watch

    /// Watch for runs started on another device and for title changes. The
    /// daemon answers every connection with a `state` snapshot, so a reconnect
    /// never needs a cursor.
    private func startSessionWatch(sessionId: String) {
        sessionWatchTask?.cancel()
        sessionWatchTask = Task { [weak self] in
            var attempt = 0
            while !Task.isCancelled {
                guard let self, self.sessionId == sessionId else { return }
                var reached = false
                var fatal = false
                do {
                    for try await event in self.repository.sessionEvents(sessionId: sessionId) {
                        if Task.isCancelled { return }
                        reached = true
                        self.applySessionEvent(event)
                    }
                } catch {
                    if Task.isCancelled { return }
                    if let pabootError = error as? PabootError,
                       case .http(let status, _) = pabootError,
                       status == 401 || status == 403 || status == 404 {
                        fatal = true
                    }
                }
                guard !Task.isCancelled, !fatal, self.sessionId == sessionId else { return }
                attempt = reached ? 0 : attempt + 1
                let seconds = min(10, 1 << min(attempt, 4))
                try? await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000)
            }
        }
    }

    private func applySessionEvent(_ event: SessionEventDto) {
        guard let sid = sessionId else { return }
        switch event {
        case .state(let session):
            guard session.id == sid else { return }
            if let title = session.title, !title.isEmpty { state.title = title }
            // Our own run stream is the truth while it is open.
            guard !state.streaming else { return }
            let stale = lastActiveAt == nil || session.lastActiveAt > (lastActiveAt ?? 0)
            if session.runningRunId != nil || stale {
                Task { [weak self] in
                    await self?.loadHistory(sessionId: sid, startWatch: false)
                }
            }
        case .sessionUpdated(let eventSessionId, let title):
            if eventSessionId == sid, let title, !title.isEmpty {
                state.title = title
            }
        case .runStarted(let eventSessionId, let run),
             .runFinished(let eventSessionId, let run):
            appendExternalRun(sid: sid, eventSessionId: eventSessionId, run: run)
        case .unknown:
            break
        }
    }

    /// Another device started (or just finished) a run: add its prompt, then
    /// attach to the run stream — which replays from zero even if it is over.
    private func appendExternalRun(
        sid: String,
        eventSessionId: String,
        run: SessionEventDto.RunBrief
    ) {
        guard eventSessionId == sid, !state.streaming, !knownRunIds.contains(run.id) else { return }
        // History is on its way: the messages are about to be replaced by the
        // rebuild, and `knownRunIds` is still empty in that window — the two
        // together are what made a known run look unknown and get appended twice.
        guard !state.loadingHistory else { return }
        knownRunIds.insert(run.id)
        state.messages.append(
            ChatUiMessage(
                id: "u-\(run.id)",
                role: .user,
                text: run.prompt,
                sentAt: run.startedAt,
                attachmentIds: run.attachmentIds
            )
        )
        state.messages.append(ChatUiMessage(id: "a-\(run.id)", role: .assistant, done: false))
        state.runId = run.id
        startStream(
            initial: repository.runStream(runId: run.id, after: nil),
            runId: run.id,
            after: nil,
            resend: nil
        )
    }

    // MARK: - Stream loop

    private func startStream(
        initial: AsyncThrowingStream<SSEFrame, Error>,
        runId: String?,
        after: Int64?,
        resend: (() -> AsyncThrowingStream<SSEFrame, Error>)?
    ) {
        streamTask?.cancel()
        streamGeneration += 1
        let generation = streamGeneration

        flushTask?.cancel()
        flushTask = nil
        pendingFrames.removeAll(keepingCapacity: true)

        state.streaming = true
        state.reconnecting = false
        state.runId = runId
        if let runId, let sessionId = state.sessionId {
            RunNotifications.shared.watch(runId: runId, sessionId: sessionId, title: state.title)
        }
        giveUp = false
        lastSeq = -1

        streamTask = Task {
            var currentRunId = runId
            var after = after
            var stream = initial
            var attempt = 0
            var unreachableSince: Date?

            while !Task.isCancelled && !giveUp && generation == streamGeneration {
                var terminal = false
                var failure: Error?
                var frameCount = 0
                let startedAt = Date()

                do {
                    for try await frame in stream {
                        if Task.isCancelled || generation != streamGeneration { return }

                        frameCount += 1
                        if state.reconnecting { state.reconnecting = false }
                        if frame.seq > lastSeq { lastSeq = frame.seq }
                        if currentRunId == nil { currentRunId = frame.runId }

                        enqueue(frame)
                        if ChatEventReducer.isTerminal(frame.event) { terminal = true }
                    }
                } catch {
                    failure = error
                }

                if Task.isCancelled || giveUp || generation != streamGeneration { return }
                flushPendingFrames()

                let streamMs = Date().timeIntervalSince(startedAt) * 1000
                let resumable = currentRunId ?? state.runId
                let probed: Bool?
                if terminal || resumable == nil {
                    probed = nil
                } else {
                    probed = await repository.isRunActive(runId: resumable!)
                }
                guard !Task.isCancelled, generation == streamGeneration else { return }

                let now = Date()
                if probed == nil {
                    if unreachableSince == nil { unreachableSince = now }
                } else {
                    unreachableSince = nil
                }
                let unreachableMs = unreachableSince.map {
                    Int64(now.timeIntervalSince($0) * 1000)
                } ?? 0
                let httpCode: Int? = {
                    guard let error = failure as? PabootError,
                          case .http(let status, _) = error else { return nil }
                    return status
                }()

                let localFailure = failure as? ChatRepositoryError
                let decision: ReconnectPolicy.Decision
                if localFailure != nil {
                    decision = .giveUp
                } else if !terminal, resumable == nil, resend != nil,
                   !ReconnectPolicy.isNonRetryable(httpCode: httpCode),
                   unreachableMs < ReconnectPolicy.unreachableBudgetMs {
                    decision = .retry(
                        delayMs: ReconnectPolicy.backoffMs(
                            attempt: attempt,
                            jitter: Double.random(in: 0..<1)
                        )
                    )
                } else if !terminal, resumable == nil {
                    decision = .giveUp
                } else {
                    decision = ReconnectPolicy.decide(
                        terminal: terminal,
                        httpCode: httpCode,
                        runActive: probed,
                        unreachableMs: unreachableMs,
                        attempt: attempt,
                        jitter: Double.random(in: 0..<1)
                    )
                }

                switch decision {
                case .finished:
                    finish()
                    return

                case .settled:
                    if failure != nil, let resumable {
                        if let frames = try? await repository.runEvents(
                            runId: resumable,
                            after: lastSeq >= 0 ? lastSeq : nil
                        ) {
                            guard !Task.isCancelled, generation == streamGeneration else { return }
                            let missed = frames.filter { $0.seq > lastSeq }
                            if let seq = missed.last?.seq { lastSeq = seq }
                            let missedRunId = missed.last?.runId ?? resumable
                            for event in ChatEventReducer.coalesced(missed.map(\.event)) {
                                handle(event, runId: missedRunId)
                            }
                        }
                    }
                    guard !Task.isCancelled, generation == streamGeneration else { return }
                    finish()
                    return

                case .giveUp:
                    state.error = friendlyMessage(failure, hasRun: resumable != nil)
                    if let localFailure {
                        switch localFailure {
                        case .unauthorized, .notConnected:
                            state.requiresReconnect = true
                        case .failed:
                            break
                        }
                    } else if let error = failure as? PabootError,
                              case .http(let status, _) = error,
                              status == 401 || status == 403 {
                        state.requiresReconnect = true
                    }
                    finish(clearPermissions: false, markDone: false)
                    return

                case .retry(let delayMs):
                    attempt = (frameCount > 0
                        || streamMs > Double(ReconnectPolicy.healthyAttemptMs))
                        ? 0
                        : attempt + 1
                    state.reconnecting = true
                    try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                    if Task.isCancelled || generation != streamGeneration { return }

                    after = lastSeq >= 0 ? lastSeq : after
                    if let resumable {
                        currentRunId = resumable
                        stream = repository.runStream(runId: resumable, after: after)
                    } else if let resend {
                        stream = resend()
                    } else {
                        return
                    }
                }
            }
        }
    }

    /// Buffer one frame. Text/thinking deltas are sampled at ~8 Hz because they
    /// arrive faster than the UI can usefully redraw; structural events (tools,
    /// usage, status, approvals) are applied immediately so cards appear at once.
    private func enqueue(_ frame: SSEFrame) {
        pendingFrames.append(frame)

        guard Self.isDelta(frame.event) else {
            flushPendingFrames()
            return
        }
        guard flushTask == nil else { return }
        flushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.streamFlushInterval)
            guard !Task.isCancelled else { return }
            self?.flushPendingFrames()
        }
    }

    private static func isDelta(_ event: NormalizedEvent) -> Bool {
        switch event {
        case .textDelta, .thinkingDelta:
            return true
        default:
            return false
        }
    }

    /// Apply buffered frames in order, merging consecutive deltas first. One
    /// merged append per flush keeps a block from copying its whole accumulated
    /// string once per token.
    private func flushPendingFrames() {
        flushTask?.cancel()
        flushTask = nil
        guard !pendingFrames.isEmpty else { return }

        let frames = pendingFrames
        pendingFrames.removeAll(keepingCapacity: true)
        let runId = frames.last?.runId ?? state.runId ?? ""
        for event in ChatEventReducer.coalesced(frames.map(\.event)) {
            handle(event, runId: runId)
        }
    }

    private func handle(_ event: NormalizedEvent, runId: String) {
        state.runId = runId
        // This run is ours: remember it. `run_finished` can arrive after `done`
        // cleared streaming, and at that point `knownRunIds` only holds runs seen
        // when the detail was fetched — the hint would be treated as another
        // device's run and the prompt appended twice.
        if !runId.isEmpty {
            knownRunIds.insert(runId)
        }

        if case .permissionRequest(let request) = event {
            // The run pauses for an approval, so the thinking spinner must stop.
            if let index = state.messages.lastIndex(where: { $0.role == .assistant }) {
                var assistant = state.messages[index]
                ChatEventReducer.endThinking(&assistant)
                state.messages[index] = assistant
            }
            handlePermissionRequest(request, runId: runId)
            return
        }

        if case .status(let status) = event {
            // Only adopt a session id when we started without one. The daemon's
            // "starting" frame carries the paboot session id, while runtime
            // drivers report their native id (Claude session / Codex thread) in
            // the same field; letting that overwrite ours makes the next send
            // target a session the daemon does not know ("session not found").
            if let id = status.sessionId, !id.isEmpty, sessionId == nil {
                sessionId = id
                state.sessionId = id
            }
            if let model = status.model, !model.isEmpty {
                state.model = model
            }
            if let value = status.runtime, !value.isEmpty {
                runtime = value
                state.runtime = value
            }
            if status.terminal != true, let id = state.sessionId {
                RunNotifications.shared.watch(runId: runId, sessionId: id, title: state.title)
                if AppRouter.shared.isViewingSession(id) { RunNotifications.shared.clearSession(id) }
            }
        }

        if case .usage(let usage) = event, let tokens = usage.contextTokens {
            state.contextUsage = ContextUsage(tokens: tokens, window: usage.contextWindow)
        }

        if case .toolUse(let tool) = event, tool.name == "TodoWrite" {
            let parsed = parseTodos(tool.input)
            if !parsed.isEmpty {
                state.todos = parsed
            }
            return
        }

        if state.messages.last?.role != .assistant {
            state.messages.append(
                ChatUiMessage(id: "a-\(UUID().uuidString)", role: .assistant, done: false)
            )
        }
        guard let index = state.messages.lastIndex(where: { $0.role == .assistant }) else {
            return
        }

        var assistant = state.messages[index]
        ChatEventReducer.apply(event, to: &assistant)
        state.messages[index] = assistant
    }

    private func handlePermissionRequest(
        _ request: NormalizedEvent.PermissionRequest,
        runId: String
    ) {
        let status = request.status ?? "pending"

        if status == "pending" {
            guard !seenPermissionIds.contains(request.permissionId) else { return }
            seenPermissionIds.insert(request.permissionId)

            let pending = PendingPermission(
                permissionId: request.permissionId,
                runId: runId,
                toolName: request.toolName,
                toolInput: request.toolInput,
                status: status
            )
            if state.permission == nil {
                state.permission = pending
            } else {
                permissionQueue.append(pending)
            }
        } else {
            dismissPermission(id: request.permissionId)
        }
    }

    private func dismissPermission(id: String) {
        // Both the decision response and SSE resolution may arrive, in either order.
        // Remember resolved IDs so a stale pending replay cannot resurrect them.
        seenPermissionIds.insert(id)
        permissionQueue.removeAll { $0.permissionId == id }
        guard state.permission?.permissionId == id else { return }
        state.permissionError = nil
        state.permission = permissionQueue.isEmpty ? nil : permissionQueue.removeFirst()
    }

    private func finish(clearPermissions: Bool = true, markDone: Bool = true) {
        flushPendingFrames()
        state.streaming = false
        state.reconnecting = false
        state.runId = nil

        if clearPermissions {
            state.permission = nil
            state.permissionError = nil
            permissionQueue.removeAll()
            seenPermissionIds.removeAll()
        }

        if let index = state.messages.lastIndex(where: { $0.role == .assistant }) {
            var assistant = state.messages[index]
            // Never leave the thinking spinner running after the stream is gone,
            // even when the run is left resumable (markDone: false).
            if markDone {
                ChatEventReducer.finalize(&assistant)
            } else {
                ChatEventReducer.endThinking(&assistant)
            }
            state.messages[index] = assistant
        }
    }

    private func friendlyMessage(_ error: Error?, hasRun: Bool) -> String {
        if let error = error as? ChatRepositoryError {
            return error.errorDescription ?? error.localizedDescription
        }
        if let error = error as? PabootError {
            return error.errorDescription ?? error.localizedDescription
        }
        if let error {
            return error.localizedDescription
        }
        return hasRun ? "连接已断开" : "请求未送达，请重新发送"
    }

    // MARK: - Permissions / questions

    func decidePermission(_ decision: String, permissionId: String, response: JSONValue? = nil) {
        guard let permission = state.permission,
              permission.permissionId == permissionId,
              state.submittingPermissionId != permissionId else { return }
        state.submittingPermissionId = permissionId
        state.permissionError = nil

        Task {
            defer {
                if state.submittingPermissionId == permissionId {
                    state.submittingPermissionId = nil
                }
            }
            do {
                try await repository.decidePermission(
                    id: permission.permissionId,
                    decision: decision,
                    response: response
                )
                dismissPermission(id: permissionId)
            } catch {
                guard state.permission?.permissionId == permissionId else { return }
                let message = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
                if permission.toolName == "UserInput" {
                    state.permissionError = message
                } else {
                    state.error = message
                }
            }
        }
    }

    func answerQuestion(
        toolUseId: String,
        answerText: String,
        answers: [String: [String]]
    ) {
        let answer = answerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !answer.isEmpty else { return }
        guard let question = findQuestion(toolUseId) else { return }

        // Blocking questions (builtin / Codex): structured answers go through the
        // permission endpoint and the same run continues with the tool result.
        if let permissionId = question.permissionId {
            guard !question.answered else { return }
            markQuestionAnswered(toolUseId, answered: true)
            let payload = answers.mapValues { labels in
                JSONValue.object(["answers": .array(labels.map(JSONValue.string))])
            }
            Task {
                do {
                    try await repository.decidePermission(
                        id: permissionId,
                        decision: "allow",
                        response: .object(["answers": .object(payload)])
                    )
                } catch {
                    markQuestionAnswered(toolUseId, answered: false)
                    state.error = friendlyMessage(error, hasRun: false)
                }
            }
            return
        }

        // Claude and other headless runtimes cannot block: the answer only
        // reaches the model as the next message, after the turn ends.
        guard !state.streaming else { return }
        markQuestionAnswered(toolUseId, answered: true)
        send(answer)
    }

    private func findQuestion(_ toolUseId: String) -> QuestionBlock? {
        for message in state.messages where message.role == .assistant {
            for block in message.blocks {
                if case .question(let question) = block, question.toolUseId == toolUseId {
                    return question
                }
            }
        }
        return nil
    }

    private func markQuestionAnswered(_ toolUseId: String, answered: Bool) {
        for messageIndex in state.messages.indices
        where state.messages[messageIndex].role == .assistant {
            for blockIndex in state.messages[messageIndex].blocks.indices {
                guard case .question(var question) = state.messages[messageIndex].blocks[blockIndex],
                      question.toolUseId == toolUseId else {
                    continue
                }
                question.answered = answered
                state.messages[messageIndex].blocks[blockIndex] = .question(question)
            }
        }
    }

    // MARK: - Session settings

    func setPermissionMode(_ mode: String) {
        let mode = PermissionModeOptions.clamp(mode, bypassAllowed: state.bypassAllowed)
        guard mode != state.permissionMode else { return }
        state.permissionMode = mode

        guard let sessionId else { return }
        Task {
            do {
                try await repository.updatePermissionMode(sessionId: sessionId, mode: mode)
            } catch {
                state.error = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
        }
    }

    func setMemoryMode(_ mode: String) {
        guard ["normal", "no_injection", "off"].contains(mode) else { return }
        guard mode != state.memoryMode else { return }
        state.memoryMode = mode
        guard let sessionId else { return }
        Task {
            do {
                try await repository.updateMemoryMode(sessionId: sessionId, mode: mode)
            } catch {
                state.error = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
        }
    }

    /// Applied after the permission sheet PATCHes the mode, so the header menu stays in sync
    /// without sending a second request.
    func applyPermissionMode(_ mode: String) {
        state.permissionMode = PermissionModeOptions.clamp(
            mode,
            bypassAllowed: state.bypassAllowed
        )
    }

    func setModel(_ model: String?) {
        state.model = model

        // Drop knobs the newly selected model does not declare.
        let allowed = Set(
            state.models.first(where: { $0.id == model })?.parameters.map(\.id) ?? []
        )
        state.modelParameters = state.modelParameters.filter { allowed.contains($0.key) }

        guard let sessionId else { return }
        let parameters = state.modelParameters.isEmpty ? nil : state.modelParameters

        Task {
            do {
                if let session = try await repository.updateModel(
                    sessionId: sessionId,
                    model: model,
                    parameters: parameters
                ) {
                    state.model = session.model
                    state.modelParameters = session.modelParameters ?? [:]
                }
            } catch {
                state.error = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
        }
    }

    func setModelParameter(_ parameterId: String, valueId: String?) {
        if let valueId {
            state.modelParameters[parameterId] = valueId
        } else {
            state.modelParameters.removeValue(forKey: parameterId)
        }

        guard let sessionId else { return }
        let model = state.model
        let parameters = state.modelParameters.isEmpty ? nil : state.modelParameters

        Task {
            do {
                if let session = try await repository.updateModel(
                    sessionId: sessionId,
                    model: model,
                    parameters: parameters
                ) {
                    state.model = session.model
                    state.modelParameters = session.modelParameters ?? [:]
                }
            } catch {
                state.error = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
        }
    }

    func consumeError() {
        state.error = nil
        state.requiresReconnect = false
    }

    private func loadModels() {
        let runtime = state.runtime
        guard !runtime.isEmpty else { return }

        Task {
            do {
                state.models = try await repository.models(agentId: runtime)
            } catch {
                // A model catalogue is optional; leave the menu empty.
            }
        }
    }
}    // MARK: - 会话里的助手（agent）
    //
    // 404 一律当成「这台 daemon 还没有这个功能」：静默关掉入口，不弹错误。

    func loadSessionAgents() {
        guard let id = state.sessionId else { return }
        Task {
            do {
                let roster = try await agentRepository.sessionAgents(sessionId: id)
                state.agentsSupported = true
                state.sessionAgents = roster.agents
            } catch let error as PabootError {
                if case .http(let status, _) = error, status == 404 {
                    state.agentsSupported = false
                    state.sessionAgents = []
                } else {
                    state.error = error.localizedDescription
                }
            } catch {
                state.error = error.localizedDescription
            }
        }
    }

    /// 用当前会话所属工作区刷新候选助手。
    func refreshWorkspaceAgents() {
        Task {
            var workspaceId = self.workspaceId
            if workspaceId == nil, let id = state.sessionId,
               let detail = try? await repository.sessionDetail(id: id) {
                workspaceId = detail.session.workspaceId
            }
            guard let workspaceId else { return }
            state.workspaceAgents = (try? await agentRepository.listByWorkspace(workspaceId: workspaceId)) ?? []
        }
    }

    func addSessionAgent(_ agentId: String) {
        guard let id = state.sessionId else { return }
        Task {
            do {
                try await agentRepository.addToSession(sessionId: id, agentId: agentId)
                loadSessionAgents()
            } catch {
                state.error = error.localizedDescription
            }
        }
    }

    func removeSessionAgent(_ agentId: String) {
        guard let id = state.sessionId else { return }
        Task {
            do {
                try await agentRepository.removeFromSession(sessionId: id, agentId: agentId)
                loadSessionAgents()
            } catch {
                state.error = error.localizedDescription
            }
        }
    }

    /// 重置某个 agent 在本会话的对话。
    ///
    /// 只清 paboot 侧的 thread 绑定；runtime 自己存的记忆清不掉 —— 文案要说清。
    func resetAgentContext(_ agentId: String) {
        guard let id = state.sessionId else { return }
        Task {
            do {
                try await agentRepository.resetContext(sessionId: id, agentId: agentId)
                loadSessionAgents()
            } catch {
                state.error = error.localizedDescription
            }
        }
    }

    // MARK: - Streaming
