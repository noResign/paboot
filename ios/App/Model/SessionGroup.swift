import Foundation
import PabootProtocol

/// One section of the session list.
struct SessionGroup: Equatable {
    let id: String
    let title: String
    let subtitle: String
    let sessions: [SessionDto]
}

/// Groups sessions by workspace (newest workspace first). Sessions whose workspace is
/// unknown go into a neutral "未分组" section instead of disappearing.
enum SessionGrouping {
    static func groups(sessions: [SessionDto], workspaces: [WorkspaceDto]) -> [SessionGroup] {
        let workspacesByID = Dictionary(
            workspaces.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )

        var buckets: [String: [SessionDto]] = [:]
        for session in sessions {
            let key: String
            if let workspaceId = session.workspaceId, workspacesByID[workspaceId] != nil {
                key = workspaceId
            } else {
                key = "ungrouped"
            }
            buckets[key, default: []].append(session)
        }

        return buckets
            .compactMap { key, values -> SessionGroup? in
                guard !values.isEmpty else { return nil }
                let sorted = values.sorted { $0.lastActiveAt > $1.lastActiveAt }

                if key == "ungrouped" {
                    return SessionGroup(id: key, title: "未分组", subtitle: "", sessions: sorted)
                }

                guard let workspace = workspacesByID[key] else { return nil }
                let title = workspace.name.isEmpty ? workspace.path : workspace.name
                return SessionGroup(
                    id: key,
                    title: title,
                    subtitle: workspace.path,
                    sessions: sorted
                )
            }
            .sorted {
                ($0.sessions.first?.lastActiveAt ?? 0) > ($1.sessions.first?.lastActiveAt ?? 0)
            }
    }
}
