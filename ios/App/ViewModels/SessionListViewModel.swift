import Combine
import Foundation

/// Drives the session list: load, refresh, rename, delete.
@MainActor
final class SessionListViewModel {
    struct State {
        var groups: [SessionGroup] = []
        var isLoading = true
        var loadError: String?
        var requiresReconnect = false
        var actionError: String?
    }

    @Published private(set) var state = State()

    private let repository: SessionRepository
    private var loadGeneration = 0

    init(repository: SessionRepository = SessionRepository()) {
        self.repository = repository
    }

    func load(showLoading: Bool) async {
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
            let snapshot = try await repository.load()
            guard generation == loadGeneration else { return }

            state.groups = SessionGrouping.groups(
                sessions: snapshot.sessions,
                workspaces: snapshot.workspaces
            )
            state.loadError = nil
            state.requiresReconnect = false
        } catch {
            guard generation == loadGeneration else { return }
            handleLoadError(error)
        }
    }

    func rename(id: String, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            state.actionError = "名称不能为空"
            return
        }

        do {
            try await repository.rename(id: id, title: trimmed)
            await load(showLoading: false)
        } catch {
            handleActionError(error)
        }
    }

    func delete(id: String) async {
        do {
            try await repository.delete(id: id)
            state.groups = state.groups.compactMap { group in
                let remaining = group.sessions.filter { $0.id != id }
                guard !remaining.isEmpty else { return nil }
                return SessionGroup(
                    id: group.id,
                    title: group.title,
                    subtitle: group.subtitle,
                    sessions: remaining
                )
            }
            await load(showLoading: false)
        } catch {
            handleActionError(error)
        }
    }

    func consumeActionError() {
        state.actionError = nil
    }

    private func handleLoadError(_ error: Error) {
        if let error = error as? SessionRepositoryError {
            switch error {
            case .unauthorized, .notConnected:
                state.groups = []
                state.requiresReconnect = true
                state.loadError = error.errorDescription
            case .failed(let message):
                if state.groups.isEmpty {
                    state.loadError = message
                } else {
                    state.actionError = message
                }
            }
        } else {
            if state.groups.isEmpty {
                state.loadError = error.localizedDescription
            } else {
                state.actionError = error.localizedDescription
            }
        }
    }

    private func handleActionError(_ error: Error) {
        if let error = error as? SessionRepositoryError {
            switch error {
            case .unauthorized, .notConnected:
                state.groups = []
                state.requiresReconnect = true
                state.loadError = error.errorDescription
            case .failed(let message):
                state.actionError = message
            }
        } else {
            state.actionError = error.localizedDescription
        }
    }
}
