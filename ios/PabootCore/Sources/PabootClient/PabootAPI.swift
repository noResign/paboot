#if canImport(Darwin)
import Foundation
import PabootProtocol

/// REST surface of the daemon. Every path mirrors `daemon/src/types/api.ts`.
public final class PabootAPI {
    private let location: DaemonLocation
    private let http: HTTPClient

    public init(location: DaemonLocation, http: HTTPClient = HTTPClient()) {
        self.location = location
        self.http = http
    }

    // MARK: - Discovery / config

    public func health() async throws -> HealthDto {
        try await get("api/health", authenticated: false, as: HealthDto.self)
    }

    public func config() async throws -> ConfigResponse {
        try await get("api/config", authenticated: true, as: ConfigResponse.self)
    }

    public func updateConfig(_ body: UpdateConfigRequest) async throws -> ConfigUpdateResponse {
        try await request(
            "PATCH",
            path: "api/config",
            body: try encode(body),
            authenticated: true,
            as: ConfigUpdateResponse.self
        )
    }

    public func workspaces() async throws -> WorkspacesResponse {
        try await get("api/workspaces", authenticated: true, as: WorkspacesResponse.self)
    }

    public func createWorkspace(_ body: CreateWorkspaceRequest) async throws -> WorkspaceResponse {
        try await request(
            "POST",
            path: "api/workspaces",
            body: try encode(body),
            authenticated: true,
            as: WorkspaceResponse.self
        )
    }

    public func updateWorkspace(id: String, body: UpdateWorkspaceRequest) async throws -> WorkspaceResponse {
        try await request(
            "PATCH",
            path: "api/workspaces/\(id)",
            body: try encode(body),
            authenticated: true,
            as: WorkspaceResponse.self
        )
    }

    public func deleteWorkspace(id: String, cascade: Bool = false) async throws -> OkResponse {
        var query: [URLQueryItem] = []
        if cascade {
            query.append(URLQueryItem(name: "cascade", value: "1"))
        }
        return try await request(
            "DELETE",
            path: "api/workspaces/\(id)",
            query: query,
            authenticated: true,
            as: OkResponse.self
        )
    }

    public func addWorkspaceDir(id: String, path: String) async throws -> WorkspaceDirsResponse {
        try await request(
            "POST",
            path: "api/workspaces/\(id)/dirs",
            body: try encode(WorkspaceDirsRequest(path: path)),
            authenticated: true,
            as: WorkspaceDirsResponse.self
        )
    }

    public func removeWorkspaceDir(id: String, path: String) async throws -> WorkspaceDirsResponse {
        try await request(
            "DELETE",
            path: "api/workspaces/\(id)/dirs",
            body: try encode(WorkspaceDirsRequest(path: path)),
            authenticated: true,
            as: WorkspaceDirsResponse.self
        )
    }

    public func addWorkspaceShortcut(id: String, path: String) async throws -> WorkspaceShortcutsResponse {
        try await request(
            "POST",
            path: "api/workspaces/\(id)/shortcuts",
            body: try encode(WorkspaceDirsRequest(path: path)),
            authenticated: true,
            as: WorkspaceShortcutsResponse.self
        )
    }

    public func removeWorkspaceShortcut(id: String, path: String) async throws -> WorkspaceShortcutsResponse {
        try await request(
            "DELETE",
            path: "api/workspaces/\(id)/shortcuts",
            body: try encode(WorkspaceDirsRequest(path: path)),
            authenticated: true,
            as: WorkspaceShortcutsResponse.self
        )
    }

    /// One level of the daemon host's directory tree, folders only. `path == nil` means `~`.
    public func directories(path: String? = nil, showHidden: Bool = false) async throws -> DirectoriesResponse {
        var query: [URLQueryItem] = []
        if let path, !path.isEmpty {
            query.append(URLQueryItem(name: "path", value: path))
        }
        if showHidden {
            query.append(URLQueryItem(name: "showHidden", value: "true"))
        }
        return try await get("api/fs/directories", query: query, authenticated: true, as: DirectoriesResponse.self)
    }

    // MARK: - Files / changes

    public func changes(workspaceId: String? = nil, root: String? = nil) async throws -> ChangesResponse {
        var query: [URLQueryItem] = []
        if let workspaceId, !workspaceId.isEmpty {
            query.append(URLQueryItem(name: "workspaceId", value: workspaceId))
        }
        if let root, !root.isEmpty {
            query.append(URLQueryItem(name: "root", value: root))
        }
        return try await get("api/changes", query: query, authenticated: true, as: ChangesResponse.self)
    }

    public func changeDiff(
        workspaceId: String? = nil,
        root: String? = nil,
        path: String
    ) async throws -> DiffResponse {
        var query: [URLQueryItem] = [URLQueryItem(name: "path", value: path)]
        if let workspaceId, !workspaceId.isEmpty {
            query.append(URLQueryItem(name: "workspaceId", value: workspaceId))
        }
        if let root, !root.isEmpty {
            query.append(URLQueryItem(name: "root", value: root))
        }
        return try await get("api/changes/diff", query: query, authenticated: true, as: DiffResponse.self)
    }

    public func files(
        workspaceId: String? = nil,
        root: String? = nil,
        path: String? = nil,
        cursor: String? = nil,
        limit: Int? = nil,
        showHidden: Bool = false,
        showIgnored: Bool = false
    ) async throws -> FilesResponse {
        var query: [URLQueryItem] = []
        if let workspaceId, !workspaceId.isEmpty {
            query.append(URLQueryItem(name: "workspaceId", value: workspaceId))
        }
        if let root, !root.isEmpty {
            query.append(URLQueryItem(name: "root", value: root))
        }
        if let path, !path.isEmpty {
            query.append(URLQueryItem(name: "path", value: path))
        }
        if let cursor, !cursor.isEmpty {
            query.append(URLQueryItem(name: "cursor", value: cursor))
        }
        if let limit {
            query.append(URLQueryItem(name: "limit", value: String(limit)))
        }
        if showHidden {
            query.append(URLQueryItem(name: "showHidden", value: "true"))
        }
        if showIgnored {
            query.append(URLQueryItem(name: "showIgnored", value: "true"))
        }
        return try await get("api/files", query: query, authenticated: true, as: FilesResponse.self)
    }

    public func fileContent(
        workspaceId: String? = nil,
        root: String? = nil,
        path: String
    ) async throws -> FileContentDto {
        var query: [URLQueryItem] = [URLQueryItem(name: "path", value: path)]
        if let workspaceId, !workspaceId.isEmpty {
            query.append(URLQueryItem(name: "workspaceId", value: workspaceId))
        }
        if let root, !root.isEmpty {
            query.append(URLQueryItem(name: "root", value: root))
        }
        return try await get("api/files/content", query: query, authenticated: true, as: FileContentDto.self)
    }

    /// Raw bytes for media preview. Auth stays in the header; the token never enters a URL.
    public func fileRaw(
        workspaceId: String? = nil,
        root: String? = nil,
        path: String
    ) async throws -> Data {
        var query: [URLQueryItem] = [URLQueryItem(name: "path", value: path)]
        if let workspaceId, !workspaceId.isEmpty {
            query.append(URLQueryItem(name: "workspaceId", value: workspaceId))
        }
        if let root, !root.isEmpty {
            query.append(URLQueryItem(name: "root", value: root))
        }
        let request = try makeRequest(
            method: "GET",
            path: "api/files/raw",
            query: query,
            body: nil,
            authenticated: true
        )
        let (data, _) = try await http.send(request)
        return data
    }

    public func agents() async throws -> AgentsResponse {
        try await get("api/agents", authenticated: true, as: AgentsResponse.self)
    }

    public func models(agentId: String) async throws -> AgentModelsResponse {
        try await get("api/agents/\(agentId)/models", authenticated: true, as: AgentModelsResponse.self)
    }

    // MARK: - Sessions

    public func sessions(workspaceId: String? = nil) async throws -> SessionsResponse {
        var query: [URLQueryItem] = []
        if let workspaceId {
            query.append(URLQueryItem(name: "workspaceId", value: workspaceId))
        }
        return try await get("api/sessions", query: query, authenticated: true, as: SessionsResponse.self)
    }

    public func session(id: String) async throws -> SessionDetailResponse {
        try await get("api/sessions/\(id)", authenticated: true, as: SessionDetailResponse.self)
    }

    public func renameSession(id: String, title: String) async throws -> RenameResponse {
        try await request(
            "PATCH",
            path: "api/sessions/\(id)",
            body: try encode(RenameRequest(title: title)),
            authenticated: true,
            as: RenameResponse.self
        )
    }

    public func deleteSession(id: String) async throws -> OkResponse {
        try await request("DELETE", path: "api/sessions/\(id)", authenticated: true, as: OkResponse.self)
    }

    public func updateSessionModel(id: String, body: UpdateSessionModelRequest) async throws -> SessionResponse {
        try await request(
            "PATCH",
            path: "api/sessions/\(id)/model",
            body: try encode(body),
            authenticated: true,
            as: SessionResponse.self
        )
    }

    public func sessionPermissions(id: String) async throws -> SessionPermissionsResponse {
        try await get(
            "api/sessions/\(id)/permissions",
            authenticated: true,
            as: SessionPermissionsResponse.self
        )
    }

    public func updateSessionPermissions(
        id: String,
        mode: String
    ) async throws -> UpdateSessionPermissionsResponse {
        try await request(
            "PATCH",
            path: "api/sessions/\(id)/permissions",
            body: try encode(UpdateSessionPermissionsRequest(mode: mode)),
            authenticated: true,
            as: UpdateSessionPermissionsResponse.self
        )
    }

    public func deletePermissionGrant(sessionId: String, toolName: String) async throws -> OkResponse {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        let encoded = toolName.addingPercentEncoding(withAllowedCharacters: allowed) ?? toolName
        return try await request(
            "DELETE",
            path: "api/sessions/\(sessionId)/permissions/grants/\(encoded)",
            authenticated: true,
            as: OkResponse.self
        )
    }

    public func deletePermissionGrants(sessionId: String) async throws -> OkResponse {
        try await request(
            "DELETE",
            path: "api/sessions/\(sessionId)/permissions/grants",
            authenticated: true,
            as: OkResponse.self
        )
    }

    // MARK: - Runs

    public func runs(workspaceId: String? = nil) async throws -> RunsResponse {
        var query: [URLQueryItem] = []
        if let workspaceId {
            query.append(URLQueryItem(name: "workspaceId", value: workspaceId))
        }
        return try await get("api/runs", query: query, authenticated: true, as: RunsResponse.self)
    }

    public func runEvents(id: String, after: Int64? = nil) async throws -> EventsResponse {
        var query: [URLQueryItem] = []
        if let after {
            query.append(URLQueryItem(name: "after", value: String(after)))
        }
        return try await get("api/runs/\(id)/events", query: query, authenticated: true, as: EventsResponse.self)
    }

    public func cancelRun(id: String) async throws -> OkResponse {
        try await request("POST", path: "api/runs/\(id)/cancel", authenticated: true, as: OkResponse.self)
    }

    public func decidePermission(
        id: String,
        decision: String,
        reason: String? = nil,
        response: JSONValue? = nil
    ) async throws -> OkResponse {
        let body = PermissionDecisionRequest(decision: decision, reason: reason, response: response)
        return try await request(
            "POST",
            path: "api/permissions/\(id)/decision",
            body: try encode(body),
            authenticated: true,
            as: OkResponse.self
        )
    }

    // MARK: - Plumbing

    private func get<T: Decodable>(
        _ path: String,
        query: [URLQueryItem] = [],
        authenticated: Bool,
        as type: T.Type
    ) async throws -> T {
        try await request(
            "GET",
            path: path,
            query: query,
            body: nil,
            authenticated: authenticated,
            as: type
        )
    }

    private func request<T: Decodable>(
        _ method: String,
        path: String,
        query: [URLQueryItem] = [],
        body: Data? = nil,
        authenticated: Bool,
        as type: T.Type
    ) async throws -> T {
        let request = try makeRequest(
            method: method,
            path: path,
            query: query,
            body: body,
            authenticated: authenticated
        )
        return try await http.send(request, as: type)
    }

    private func makeRequest(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Data?,
        authenticated: Bool
    ) throws -> URLRequest {
        guard var components = URLComponents(
            url: location.baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else {
            throw PabootError.invalidURL
        }
        if !query.isEmpty {
            components.queryItems = query
        }
        guard let url = components.url else {
            throw PabootError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authenticated {
            request.setValue("Bearer \(location.token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func encode<T: Encodable>(_ value: T) throws -> Data {
        do {
            return try JSONEncoder().encode(value)
        } catch {
            throw PabootError.decoding(String(describing: error))
        }
    }
}
#endif
