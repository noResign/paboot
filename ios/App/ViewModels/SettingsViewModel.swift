import Combine
import Foundation
import PabootProtocol

/// Drives the settings tab: daemon version, current workspace, new-session defaults.
@MainActor
final class SettingsViewModel {
    struct State {
        var daemonVersion: String?
        var workspaces: [WorkspaceDto] = []
        var selectedWorkspaceId: String?
        var selectedWorkspacePath: String?
        var defaultPermissionMode = "ask"
        var isLoading = true
        var loadError: String?
        var permissionModeError: String?
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
            async let healthRequest = repository.health()
            async let workspacesRequest = repository.listWorkspaces()
            async let configRequest = repository.config()
            let (health, workspaces, config) = try await (
                healthRequest,
                workspacesRequest,
                configRequest
            )
            guard generation == loadGeneration else { return }

            let selected = resolveWorkspace(workspaces, defaultId: config.defaultWorkspaceId)
            WorkspaceSelection.shared.select(id: selected?.id, path: selected?.path)

            state.daemonVersion = health.version
            state.workspaces = workspaces
            state.selectedWorkspaceId = selected?.id
            state.selectedWorkspacePath = selected?.path
            state.defaultPermissionMode = config.defaultPermissionMode
            state.loadError = nil
        } catch {
            guard generation == loadGeneration else { return }
            state.loadError = message(error)
        }
    }

    /// Optimistic: the radio updates immediately; a failed PATCH rolls it back with a reason.
    func setDefaultPermissionMode(_ mode: String) async {
        guard mode != state.defaultPermissionMode else { return }

        let previous = state.defaultPermissionMode
        state.permissionModeError = nil
        state.defaultPermissionMode = mode

        do {
            let response = try await repository.updateConfig(defaultPermissionMode: mode)
            if let config = response.config {
                state.defaultPermissionMode = config.defaultPermissionMode
            }
        } catch {
            state.defaultPermissionMode = previous
            state.permissionModeError = message(error)
        }
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
