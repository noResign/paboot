import Combine
import Foundation
import PabootProtocol

/// Drives the file tab: git changes (default) and a one-level-at-a-time file browser,
/// both relative to a switchable root.
@MainActor
final class FilesViewModel {
    enum Mode: Equatable {
        case changes
        case all
    }

    struct State {
        var mode: Mode = .changes
        /// Absolute directory currently listed / inspected; nil until the first response.
        var root: String?
        var workspacePath = ""
        /// Workspace primary dir followed by its granted extra dirs.
        var knownRoots: [String] = []
        /// Browse-only bookmarks; they grant the agent nothing.
        var shortcuts: [String] = []

        var isGitRepo = false
        var repos: [String] = []
        var changes: [ChangedFileDto] = []

        var path = ""
        var parent: String?
        var entries: [FileEntryDto] = []
        var nextCursor: String?

        var isLoading = true
        var isLoadingMore = false
        var showHidden = false
        var loadError: String?
        var actionError: String?
    }

    @Published private(set) var state = State()

    private let repository: any FileListingRepository
    private let workspaceRepository: WorkspaceRepository
    /// The client-side selected workspace, used to detect a switch.
    private var selectedWorkspaceId: String?
    /// The workspace the daemon actually resolved, including the default when the client
    /// has not visited the session list yet. Mutations use this as a fallback.
    private var activeWorkspaceId: String?

    var currentWorkspaceId: String? {
        activeWorkspaceId ?? WorkspaceSelection.shared.selectedId
    }

    private var generation = 0

    init(
        repository: any FileListingRepository = FilesRepository(),
        workspaceRepository: WorkspaceRepository = WorkspaceRepository()
    ) {
        self.repository = repository
        self.workspaceRepository = workspaceRepository
    }

    func load(showLoading: Bool = true) async {
        let selected = WorkspaceSelection.shared.selectedId
        if let previous = selectedWorkspaceId, previous != selected {
            resetForWorkspaceChange()
        }
        selectedWorkspaceId = selected

        generation += 1
        let current = generation
        state.isLoadingMore = false
        if showLoading {
            state.isLoading = true
        }

        defer {
            if current == generation {
                state.isLoading = false
            }
        }

        do {
            switch state.mode {
            case .changes:
                let response = try await repository.changes(workspaceId: selected, root: state.root)
                guard current == generation else { return }
                activeWorkspaceId = response.workspaceId
                state.root = response.root
                state.workspacePath = response.workspacePath
                state.knownRoots = response.roots
                state.shortcuts = response.shortcutDirs
                state.isGitRepo = response.isGitRepo
                state.repos = response.repos
                state.changes = response.files
            case .all:
                let response = try await repository.files(
                    workspaceId: selected,
                    root: state.root,
                    path: state.path,
                    cursor: nil,
                    showHidden: state.showHidden
                )
                guard current == generation else { return }
                activeWorkspaceId = response.workspaceId
                state.root = response.root
                state.workspacePath = response.workspacePath
                state.knownRoots = response.roots
                state.shortcuts = response.shortcutDirs
                state.path = response.path
                state.parent = response.parent
                state.entries = response.entries
                state.nextCursor = response.nextCursor
            }

            state.loadError = nil
        } catch {
            guard current == generation else { return }
            state.loadError = message(error)
        }
    }

    func switchMode(_ mode: Mode) async {
        guard mode != state.mode else { return }

        state.mode = mode
        state.loadError = nil
        state.path = ""
        state.parent = nil
        state.entries = []
        state.nextCursor = nil
        await load(showLoading: true)
    }

    func selectRoot(_ root: String?) async {
        guard root != state.root else { return }
        await forceRoot(root)
    }

    func openDirectory(_ entry: FileEntryDto) async {
        guard entry.type == "directory" else { return }
        await openDirectory(path: entry.path)
    }

    func openDirectory(path: String) async {
        // Tapping the current breadcrumb is a no-op, not a reload.
        guard path != state.path || state.loadError != nil else { return }
        state.path = path
        state.parent = nil
        state.entries = []
        state.nextCursor = nil
        await load(showLoading: true)
    }

    func goUp() async {
        guard let parent = state.parent, state.mode == .all else { return }
        state.path = parent
        state.parent = nil
        state.entries = []
        state.nextCursor = nil
        await load(showLoading: true)
    }

    func loadMore() async {
        guard state.mode == .all,
              let cursor = state.nextCursor,
              !state.isLoadingMore,
              !state.isLoading else {
            return
        }

        let path = state.path
        let current = generation
        let workspaceId = currentWorkspaceId
        let root = state.root
        let showHidden = state.showHidden
        state.isLoadingMore = true
        defer {
            if current == generation { state.isLoadingMore = false }
        }

        do {
            let response = try await repository.files(
                workspaceId: workspaceId,
                root: root,
                path: path,
                cursor: cursor,
                showHidden: showHidden
            )
            guard current == generation,
                  WorkspaceSelection.shared.selectedId == selectedWorkspaceId,
                  response.path == state.path,
                  state.root == root,
                  state.mode == .all else { return }
            state.entries.append(contentsOf: response.entries)
            state.nextCursor = response.nextCursor
        } catch {
            guard current == generation,
                  WorkspaceSelection.shared.selectedId == selectedWorkspaceId else { return }
            state.actionError = message(error)
        }
    }

    func toggleHidden() async {
        guard state.mode == .all else { return }
        state.showHidden.toggle()
        state.parent = nil
        state.entries = []
        state.nextCursor = nil
        await load(showLoading: true)
    }

    /// Adds a browse bookmark and switches to it. Returns an error message for the picker.
    func addShortcut(path: String) async -> String? {
        guard let workspaceId = currentWorkspaceId else {
            return "当前没有选择工作区"
        }

        do {
            state.shortcuts = try await workspaceRepository.addShortcut(
                workspaceId: workspaceId,
                path: path
            )
            await forceRoot(path)
            return nil
        } catch {
            return message(error)
        }
    }

    func removeShortcut(path: String) async {
        guard let workspaceId = currentWorkspaceId else { return }

        do {
            state.shortcuts = try await workspaceRepository.removeShortcut(
                workspaceId: workspaceId,
                path: path
            )
            if state.root == path {
                await forceRoot(state.workspacePath.isEmpty ? nil : state.workspacePath)
            }
        } catch {
            state.actionError = message(error)
        }
    }

    /// Opens a directory path from the "not a git repo" child-repo list.
    func openChildRepo(_ relativePath: String) async {
        guard let base = state.root ?? (state.workspacePath.isEmpty ? nil : state.workspacePath) else {
            return
        }
        let joined = base.hasSuffix("/") ? "\(base)\(relativePath)" : "\(base)/\(relativePath)"
        await forceRoot(joined)
    }

    func consumeActionError() {
        state.actionError = nil
    }

    private func forceRoot(_ root: String?) async {
        state.root = root
        state.path = ""
        state.parent = nil
        state.entries = []
        state.nextCursor = nil
        await load(showLoading: true)
    }

    private func resetForWorkspaceChange() {
        activeWorkspaceId = nil
        state.root = nil
        state.workspacePath = ""
        state.knownRoots = []
        state.shortcuts = []
        state.isGitRepo = false
        state.repos = []
        state.changes = []
        state.path = ""
        state.parent = nil
        state.entries = []
        state.nextCursor = nil
        state.loadError = nil
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
