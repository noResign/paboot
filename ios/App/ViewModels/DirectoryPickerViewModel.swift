import Combine
import Foundation
import PabootProtocol

/// Browses one level of the daemon host's directory tree at a time.
@MainActor
final class DirectoryPickerViewModel {
    struct State {
        var path: String?
        var parent: String?
        var entries: [DirectoryEntryDto] = []
        var showHidden = false
        var isWorkspace = false
        var isLoading = true
        var error: String?
    }

    @Published private(set) var state = State()

    private let repository: WorkspaceRepository
    private let workspacePaths: Set<String>
    private var generation = 0

    init(workspacePaths: [String], repository: WorkspaceRepository = WorkspaceRepository()) {
        self.workspacePaths = Set(workspacePaths)
        self.repository = repository
    }

    func load(path: String?) async {
        generation += 1
        let current = generation

        state.isLoading = true
        state.error = nil

        do {
            let response = try await repository.directories(path: path, showHidden: state.showHidden)
            guard current == generation else { return }

            state.path = response.path
            state.parent = response.parent
            state.entries = response.entries
            state.isWorkspace = workspacePaths.contains(response.path)
        } catch {
            guard current == generation else { return }
            state.error = message(error)
            state.entries = []
        }

        if current == generation {
            state.isLoading = false
        }
    }

    func open(_ entry: DirectoryEntryDto) async {
        await load(path: entry.path)
    }

    func goUp() async {
        guard let parent = state.parent else { return }
        await load(path: parent)
    }

    func toggleHidden() async {
        state.showHidden.toggle()
        await load(path: state.path)
    }

    func retry() async {
        await load(path: state.path)
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
