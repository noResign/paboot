import Foundation
import PabootProtocol

/// A subdirectory inside the selected workspace.
struct SessionGroup: Equatable {
    let cwd: String
    /// Path relative to the selected workspace (falls back to the absolute path).
    let title: String
    let sessions: [SessionDto]
}

/// The session screen shows one selected workspace:
/// - root-cwd sessions flat, with a collapsible "更早" segment;
/// - subdirectory cwds grouped below, collapsed by default.
struct SessionListModel: Equatable {
    var rootSessions: [SessionDto] = []
    var olderRootSessions: [SessionDto] = []
    var subGroups: [SessionGroup] = []

    var isEmpty: Bool {
        rootSessions.isEmpty && olderRootSessions.isEmpty && subGroups.isEmpty
    }
}

enum SessionGrouping {
    /// Root sessions older than this move into the "更早" segment.
    static let recentWindowMs: Int64 = 3 * 24 * 60 * 60 * 1000

    static func model(
        sessions: [SessionDto],
        workspace: WorkspaceDto?,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) -> SessionListModel {
        let sorted = sessions.sorted { $0.lastActiveAt > $1.lastActiveAt }

        guard let workspace else {
            // No workspace: fall back to grouping everything by cwd.
            let groups = cwdGroups(for: sorted, workspacePath: nil)
            return SessionListModel(rootSessions: [], olderRootSessions: [], subGroups: groups)
        }

        let rootPath = normalize(workspace.path)
        let root = sorted.filter { normalize($0.cwd) == rootPath }
        let recent = root.filter { $0.lastActiveAt >= now - recentWindowMs }
        let older = root.filter { $0.lastActiveAt < now - recentWindowMs }
        let subGroups = cwdGroups(
            for: sorted.filter { normalize($0.cwd) != rootPath },
            workspacePath: workspace.path
        )

        return SessionListModel(
            rootSessions: recent,
            olderRootSessions: older,
            subGroups: subGroups
        )
    }

    private static func cwdGroups(
        for sessions: [SessionDto],
        workspacePath: String?
    ) -> [SessionGroup] {
        Dictionary(grouping: sessions) { session in
            session.cwd.isEmpty ? "默认工作目录" : normalize(session.cwd)
        }
        .map { cwd, values in
            SessionGroup(
                cwd: cwd,
                title: workspacePath.map { relativePath(cwd, to: $0) } ?? cwd,
                sessions: values
            )
        }
        .sorted {
            ($0.sessions.first?.lastActiveAt ?? 0) > ($1.sessions.first?.lastActiveAt ?? 0)
        }
    }

    private static func normalize(_ path: String) -> String {
        var value = path
        while value.count > 1 && value.hasSuffix("/") {
            value.removeLast()
        }
        return value
    }

    private static func relativePath(_ path: String, to workspacePath: String) -> String {
        let base = normalize(workspacePath)
        let prefix = base.hasSuffix("/") ? base : base + "/"
        let normalized = normalize(path)
        guard normalized.hasPrefix(prefix) else { return path }
        return String(normalized.dropFirst(prefix.count))
    }
}
