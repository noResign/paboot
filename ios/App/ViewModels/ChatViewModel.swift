import Combine
import Foundation
import PabootClient
import PabootProtocol

/// Drives one chat transcript: history reconstruction, live SSE, reconnect, permissions.
@MainActor
final class ChatViewModel {
    struct State {
        var title = "新会话"
        var cwd = ""
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
        var model: String?
        var modelParameters: [String: String] = [:]
        var models: [ModelOptionDto] = []
        var sessionId: String?
        var runId: String?
    }

    @Published private(set) var state = State()

    private let repository: any ChatRepositoryProtocol
    private var sessionId: String?
    private let workspaceId: String?
    private var runtime: String?
    private let claudeSessionId: String?

    private var streamTask: Task<Void, Never>?
    private var historyTask: Task<Void, Never>?
    private var streamGeneration = 0
    private var lastSeq: Int64 = -1
    private var giveUp = false
    private var permissionQueue: [PendingPermission] = []
    private var seenPermissionIds: Set<String> = []
    private var didStart = false

    init(
        sessionId: String?,
        workspaceId: String? = nil,
        runtime: String? = nil,
        claudeSessionId: String? = nil,
        permissionMode: String? = nil,
        title: String? = nil,
        repository: any ChatRepositoryProtocol = ChatRepository()
    ) {
        self.repository = repository
        self.sessionId = sessionId
        self.workspaceId = workspaceId
        self.runtime = runtime
        self.claudeSessionId = claudeSessionId

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

        if let sessionId {
            historyTask = Task { await loadHistory(sessionId: sessionId) }
        } else {
            loadModels()
        }
    }

    // MARK: - History

    private func loadHistory(sessionId: String) async {
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
            state.cwd = session.cwd
            state.runtime = session.runtime
            state.permissionMode = session.permissionMode
            state.model = session.model
            state.modelParameters = session.modelParameters ?? [:]
            loadModels()

            var messages: [ChatUiMessage] = []
            var todos: [TodoItem] = []
            var context: ContextUsage?
            var runningRunId: String?

            for run in detail.runs {
                messages.append(ChatUiMessage(id: "u-\(run.id)", role: .user, text: run.prompt))

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

                for frame in frames {
                    if case .permissionRequest = frame.event {
                        continue
                    }
                    if case .toolUse(let tool) = frame.event, tool.name == "TodoWrite" {
                        let parsed = parseTodos(tool.input)
                        if !parsed.isEmpty {
                            todos = parsed
                        }
                        continue
                    }
                    if case .usage(let usage) = frame.event, let tokens = usage.contextTokens {
                        context = ContextUsage(tokens: tokens, window: usage.contextWindow)
                    }
                    ChatEventReducer.apply(frame.event, to: &assistant)
                }

                ChatEventReducer.finalize(&assistant)
                messages.append(assistant)
            }

            if messages.isEmpty && !detail.messages.isEmpty {
                messages = detail.messages.enumerated().map { index, message in
                    if message.role == "user" {
                        return ChatUiMessage(id: "m-\(index)", role: .user, text: message.content)
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

    func send(_ text: String) {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !state.streaming, !state.loadingHistory else { return }

        if state.sessionId == nil, state.title == "新会话" {
            state.title = String(prompt.prefix(60))
        }

        state.messages.append(
            ChatUiMessage(id: "u-\(UUID().uuidString)", role: .user, text: prompt)
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
            claudeSessionId: claudeSessionId,
            model: isNewSession ? state.model : nil,
            modelParameters: isNewSession && !state.modelParameters.isEmpty ? state.modelParameters : nil,
            runtime: isNewSession ? runtime : nil,
            permissionMode: isNewSession ? state.permissionMode : nil,
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
        streamGeneration += 1
        streamTask?.cancel()
        streamTask = nil
        state.streaming = false
        state.reconnecting = false
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

                        handleFrame(frame)
                        if ChatEventReducer.isTerminal(frame.event) { terminal = true }
                    }
                } catch {
                    failure = error
                }

                if Task.isCancelled || giveUp || generation != streamGeneration { return }

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
                            for frame in frames where frame.seq > lastSeq {
                                lastSeq = frame.seq
                                handleFrame(frame)
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

    private func handleFrame(_ frame: SSEFrame) {
        state.runId = frame.runId
        let event = frame.event

        if case .permissionRequest(let request) = event {
            handlePermissionRequest(request, runId: frame.runId)
            return
        }

        if case .status(let status) = event {
            if let id = status.sessionId, !id.isEmpty {
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
                RunNotifications.shared.watch(runId: frame.runId, sessionId: id, title: state.title)
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
        state.streaming = false
        state.reconnecting = false
        state.runId = nil

        if clearPermissions {
            state.permission = nil
            state.permissionError = nil
            permissionQueue.removeAll()
            seenPermissionIds.removeAll()
        }

        if markDone, let index = state.messages.lastIndex(where: { $0.role == .assistant }) {
            var assistant = state.messages[index]
            ChatEventReducer.finalize(&assistant)
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

    func answerQuestion(toolUseId: String, answerText: String) {
        let answer = answerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !state.streaming, !answer.isEmpty else { return }
        markQuestionAnswered(toolUseId)
        send(answer)
    }

    private func markQuestionAnswered(_ toolUseId: String) {
        for messageIndex in state.messages.indices
        where state.messages[messageIndex].role == .assistant {
            for blockIndex in state.messages[messageIndex].blocks.indices {
                guard case .question(var question) = state.messages[messageIndex].blocks[blockIndex],
                      question.toolUseId == toolUseId else {
                    continue
                }
                question.answered = true
                state.messages[messageIndex].blocks[blockIndex] = .question(question)
            }
        }
    }

    // MARK: - Session settings

    func setPermissionMode(_ mode: String) {
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

    /// Applied after the permission sheet PATCHes the mode, so the header menu stays in sync
    /// without sending a second request.
    func applyPermissionMode(_ mode: String) {
        state.permissionMode = mode
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
}
