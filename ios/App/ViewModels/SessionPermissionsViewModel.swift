import Combine
import Foundation
import PabootProtocol

/// Drives one session's permission sheet: mode, "allow all" grants, revocation.
@MainActor
final class SessionPermissionsViewModel {
    struct State {
        var mode = "ask"
        var grants: [PermissionGrantDto] = []
        var isLoading = true
        var loadError: String?
        var actionError: String?
        var isBusy = false
    }

    @Published private(set) var state = State()

    let sessionId: String
    /// Called after a successful mode PATCH so the chat header can stop showing a stale mode.
    var onModeChanged: ((String) -> Void)?

    private let repository: SessionPermissionRepository
    private var loadGeneration = 0

    init(sessionId: String, repository: SessionPermissionRepository = SessionPermissionRepository()) {
        self.sessionId = sessionId
        self.repository = repository
    }

    func load(showLoading: Bool = true) async {
        loadGeneration += 1
        let generation = loadGeneration

        if showLoading {
            state.isLoading = true
        }

        defer {
            if generation == loadGeneration {
                state.isLoading = false
            }
        }

        do {
            let response = try await repository.permissions(sessionId: sessionId)
            guard generation == loadGeneration else { return }

            state.mode = response.mode
            state.grants = response.grants
            state.loadError = nil
        } catch {
            guard generation == loadGeneration else { return }
            state.loadError = message(error)
        }
    }

    func setMode(_ mode: String) async {
        guard mode != state.mode, !state.isBusy else { return }

        let previous = state.mode
        state.actionError = nil
        state.mode = mode
        state.isBusy = true
        defer { state.isBusy = false }

        do {
            try await repository.updateMode(sessionId: sessionId, mode: mode)
            onModeChanged?(mode)
        } catch {
            state.mode = previous
            state.actionError = message(error)
        }
    }

    func revoke(toolName: String) async {
        guard !state.isBusy else { return }

        state.actionError = nil
        state.isBusy = true
        defer { state.isBusy = false }

        do {
            try await repository.revokeGrant(sessionId: sessionId, toolName: toolName)
            await load(showLoading: false)
        } catch {
            state.actionError = message(error)
        }
    }

    func revokeAll() async {
        guard !state.isBusy else { return }

        state.actionError = nil
        state.isBusy = true
        defer { state.isBusy = false }

        do {
            try await repository.revokeAll(sessionId: sessionId)
            await load(showLoading: false)
        } catch {
            state.actionError = message(error)
        }
    }

    func consumeActionError() {
        state.actionError = nil
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
