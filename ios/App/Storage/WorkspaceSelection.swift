import Foundation

/// The workspace selected for the session/file screens. Client-side only; never written back
/// to the daemon. Persisted so the same workspace is selected after relaunch, and validated
/// against `/api/workspaces` on every load (the daemon may have been changed or replaced).
final class WorkspaceSelection {
    static let shared = WorkspaceSelection()

    private enum Key {
        static let id = "paboot.selectedWorkspaceId"
        static let path = "paboot.selectedWorkspacePath"
    }

    private let defaults: UserDefaults
    private(set) var selectedId: String?
    private(set) var selectedPath: String?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        selectedId = defaults.string(forKey: Key.id)
        selectedPath = defaults.string(forKey: Key.path)
    }

    func select(id: String?, path: String?) {
        let normalized = id?.trimmingCharacters(in: .whitespacesAndNewlines)

        if let normalized, !normalized.isEmpty {
            selectedId = normalized
            selectedPath = path
            defaults.set(normalized, forKey: Key.id)
            defaults.set(path, forKey: Key.path)
        } else {
            selectedId = nil
            selectedPath = nil
            defaults.removeObject(forKey: Key.id)
            defaults.removeObject(forKey: Key.path)
        }
    }
}
