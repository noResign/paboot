import Combine
import Foundation
import PabootProtocol

/// Drives workspace management: selection, default flag, enabled, rename, dirs and delete.
@MainActor
final class WorkspaceManagementViewModel {
    struct State {
        var workspaces: [WorkspaceDto] = []
        var selectedWorkspaceId: String?
        var isLoading = true
        var loadError: String?
        var actionError: String?
    }

    @Published private(set) var state = State()

    private let repository: WorkspaceRepository
    private var loadGeneration = 0

    init(repository: WorkspaceRepository = WorkspaceRepository()) {
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
            async let workspacesRequest = repository.listWorkspaces()
            async let configRequest = repository.config()
            let (workspaces, config) = try await (workspacesRequest, configRequest)
            guard generation == loadGeneration else { return }

            let selected = resolveWorkspace(workspaces, defaultId: config.defaultWorkspaceId)
            WorkspaceSelection.shared.select(id: selected?.id, path: selected?.path)

            state.workspaces = workspaces
            state.selectedWorkspaceId = selected?.id
            state.loadError = nil
        } catch {
            guard generation == loadGeneration else { return }
            state.loadError = message(error)
        }
    }

    /// Switching is client-side only; the daemon is not told.
    func select(_ workspace: WorkspaceDto) {
        state.selectedWorkspaceId = workspace.id
        WorkspaceSelection.shared.select(id: workspace.id, path: workspace.path)
    }

    func setDefault(_ workspaceId: String) async {
        state.actionError = nil
        do {
            try await repository.updateWorkspace(id: workspaceId, isDefault: true)
            if let workspace = state.workspaces.first(where: { $0.id == workspaceId }) {
                select(workspace)
            }
            await load(showLoading: false)
        } catch {
            state.actionError = message(error)
        }
    }

    func setEnabled(_ workspaceId: String, enabled: Bool) async {
        state.actionError = nil
        do {
            try await repository.updateWorkspace(id: workspaceId, enabled: enabled)
            await load(showLoading: false)
        } catch {
            state.actionError = message(error)
        }
    }

    func rename(_ workspaceId: String, name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            state.actionError = "名称不能为空"
            return
        }

        state.actionError = nil
        do {
            try await repository.updateWorkspace(id: workspaceId, name: trimmed)
            await load(showLoading: false)
        } catch {
            state.actionError = message(error)
        }
    }

    func delete(_ workspaceId: String, cascade: Bool) async {
        state.actionError = nil
        do {
            try await repository.deleteWorkspace(id: workspaceId, cascade: cascade)
            if WorkspaceSelection.shared.selectedId == workspaceId {
                WorkspaceSelection.shared.select(id: nil, path: nil)
            }
            await load(showLoading: false)
        } catch {
            state.actionError = message(error)
        }
    }

    /// Returns `nil` on success, otherwise a message for the directory picker.
    func createWorkspace(path: String) async -> String? {
        state.actionError = nil
        do {
            let workspace = try await repository.createWorkspace(path: path)
            select(workspace)
            await load(showLoading: false)
            return nil
        } catch {
            return message(error)
        }
    }

    /// Returns `nil` on success, otherwise a message for the directory picker.
    func addDir(workspaceId: String, path: String) async -> String? {
        state.actionError = nil
        do {
            try await repository.addDir(workspaceId: workspaceId, path: path)
            await load(showLoading: false)
            return nil
        } catch {
            return message(error)
        }
    }

    func removeDir(workspaceId: String, path: String) async {
        state.actionError = nil
        do {
            try await repository.removeDir(workspaceId: workspaceId, path: path)
            await load(showLoading: false)
        } catch {
            state.actionError = message(error)
        }
    }

    func consumeActionError() {
        state.actionError = nil
    }

    private func resolveWorkspace(_ workspaces: [WorkspaceDto], defaultId: String?) -> WorkspaceDto? {
        if let saved = WorkspaceSelection.shared.selectedId,
           let match = workspaces.first(where: { $0.id == saved }) {
            return match
        }
        if let defaultId, let match = workspaces.first(where: { $0.id == defaultId }) {
            return match
        }
        return workspaces.first(where: { $0.isDefault }) ?? workspaces.first
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
