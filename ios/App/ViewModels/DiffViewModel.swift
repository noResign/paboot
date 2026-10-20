import Combine
import Foundation
import PabootProtocol

/// Loads one file's unified patch.
@MainActor
final class DiffViewModel {
    struct State {
        var isLoading = true
        var error: String?
        var diff: DiffResponse?
    }

    @Published private(set) var state = State()

    let workspaceId: String?
    let root: String?
    let path: String

    private let repository: FilesRepository

    init(
        workspaceId: String?,
        root: String?,
        path: String,
        repository: FilesRepository = FilesRepository()
    ) {
        self.workspaceId = workspaceId
        self.root = root
        self.path = path
        self.repository = repository
    }

    func load() async {
        state.isLoading = true
        state.error = nil

        defer { state.isLoading = false }

        do {
            state.diff = try await repository.diff(
                workspaceId: workspaceId,
                root: root,
                path: path
            )
        } catch {
            state.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
