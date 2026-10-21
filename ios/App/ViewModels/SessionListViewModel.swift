import Combine
import Foundation
import PabootProtocol

/// Drives the session list: one selected workspace, sessions grouped by cwd.
@MainActor
final class SessionListViewModel {
    struct State {
        var workspaces: [WorkspaceDto] = []
        var selectedWorkspaceID: String?
        var selectedWorkspacePath: String?
        var model = SessionListModel()
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
            let snapshot = try await repository.loadWorkspaces()
            guard generation == loadGeneration else { return }

            let workspace = resolveWorkspace(from: snapshot)
            WorkspaceSelection.shared.select(id: workspace?.id, path: workspace?.path)
            state.workspaces = snapshot.workspaces
            state.selectedWorkspaceID = workspace?.id
            state.selectedWorkspacePath = workspace?.path

            let sessions = try await repository.loadSessions(workspaceId: workspace?.id)
            guard generation == loadGeneration else { return }

            for session in sessions {
                if let runId = session.runningRunId {
                    RunNotifications.shared.watch(runId: runId, sessionId: session.id,
                                                  title: session.title ?? "会话")
                }
            }
            state.model = SessionGrouping.model(sessions: sessions, workspace: workspace)
            state.loadError = nil
            state.requiresReconnect = false
        } catch {
            guard generation == loadGeneration else { return }
            handleLoadError(error)
        }
    }

    /// Switching is local state plus one sessions fetch; the workspace list itself is reused.
    func selectWorkspace(_ workspace: WorkspaceDto) async {
        guard workspace.id != state.selectedWorkspaceID else { return }

        WorkspaceSelection.shared.select(id: workspace.id, path: workspace.path)
        state.selectedWorkspaceID = workspace.id
        state.selectedWorkspacePath = workspace.path
        state.model = SessionListModel()
        state.isLoading = true

        loadGeneration += 1
        let generation = loadGeneration
        defer {
            if generation == loadGeneration {
                state.isLoading = false
            }
        }

        do {
            let sessions = try await repository.loadSessions(workspaceId: workspace.id)
            guard generation == loadGeneration else { return }

            for session in sessions {
                if let runId = session.runningRunId {
                    RunNotifications.shared.watch(runId: runId, sessionId: session.id,
                                                  title: session.title ?? "会话")
                }
            }
            state.model = SessionGrouping.model(sessions: sessions, workspace: workspace)
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
            await load(showLoading: false)
        } catch {
            handleActionError(error)
        }
    }

    func consumeActionError() {
        state.actionError = nil
    }

    private func resolveWorkspace(from snapshot: WorkspaceSnapshot) -> WorkspaceDto? {
        if let saved = WorkspaceSelection.shared.selectedId,
           let match = snapshot.workspaces.first(where: { $0.id == saved }) {
            return match
        }
        if let defaultId = snapshot.defaultWorkspaceId,
           let match = snapshot.workspaces.first(where: { $0.id == defaultId }) {
            return match
        }
        return snapshot.workspaces.first(where: { $0.isDefault }) ?? snapshot.workspaces.first
    }

    private func handleLoadError(_ error: Error) {
        if let error = error as? SessionRepositoryError {
            switch error {
            case .unauthorized, .notConnected:
                clearForReconnect(error)
            case .failed(let message):
                if state.model.isEmpty {
                    state.loadError = message
                } else {
                    state.actionError = message
                }
            }
        } else {
            if state.model.isEmpty {
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
                clearForReconnect(error)
            case .failed(let message):
                state.actionError = message
            }
        } else {
            state.actionError = error.localizedDescription
        }
    }

    private func clearForReconnect(_ error: SessionRepositoryError) {
        state.workspaces = []
        state.selectedWorkspaceID = nil
        state.selectedWorkspacePath = nil
        state.model = SessionListModel()
        state.requiresReconnect = true
        state.loadError = error.errorDescription
    }
}
