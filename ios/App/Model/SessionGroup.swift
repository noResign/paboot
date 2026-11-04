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
    /// Sessions with attached tasks, plus the per-workspace authoring chat.
    var taskSessions: [SessionDto] = []

    var isEmpty: Bool {
        rootSessions.isEmpty && olderRootSessions.isEmpty && subGroups.isEmpty && taskSessions.isEmpty
    }

    /// Every session the screen is showing, flattened — used by the workspace
    /// overview to count sessions per directory.
    var allSessions: [SessionDto] {
        rootSessions + olderRootSessions + subGroups.flatMap { $0.sessions } + taskSessions
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
        let taskSessions = sorted.filter(isTaskRelated)
        let normalSessions = sorted.filter { !isTaskRelated($0) }

        guard let workspace else {
            // No workspace: fall back to grouping everything by cwd.
            let groups = cwdGroups(for: normalSessions, workspacePath: nil)
            return SessionListModel(
                rootSessions: [],
                olderRootSessions: [],
                subGroups: groups,
                taskSessions: taskSessions
            )
        }

        let rootPath = normalize(workspace.path)
        let root = normalSessions.filter { normalize($0.cwd) == rootPath }
        let recent = root.filter { $0.lastActiveAt >= now - recentWindowMs }
        let older = root.filter { $0.lastActiveAt < now - recentWindowMs }
        let subGroups = cwdGroups(
            for: normalSessions.filter { normalize($0.cwd) != rootPath },
            workspacePath: workspace.path
        )

        return SessionListModel(
            rootSessions: recent,
            olderRootSessions: older,
            subGroups: subGroups,
            taskSessions: taskSessions
        )
    }

    private static func isTaskRelated(_ session: SessionDto) -> Bool {
        session.scheduledTaskCount > 0 || session.purpose == "task_config"
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

    /// Primary dir first, extra dirs de-duplicated (same semantics as `workspace_dirs`).
    static func directories(for workspace: WorkspaceDto) -> [String] {
        [workspace.path] + workspace.dirs.filter { $0 != workspace.path }
    }

    /// A session belongs to a directory when its cwd is that directory or below it.
    /// A sibling sharing the prefix (`/repo2` vs `/repo`) must not match.
    static func matchesDirectory(_ cwd: String, _ dir: String) -> Bool {
        let target = normalize(dir)
        guard !target.isEmpty else { return false }
        let current = normalize(cwd)
        if current == target { return true }
        return current.hasPrefix(target == "/" ? "/" : target + "/")
    }

    /// Trim trailing separators and use `/` so both platforms compare alike.
    private static func normalize(_ path: String) -> String {
        var value = path.replacingOccurrences(of: "\\", with: "/")
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
