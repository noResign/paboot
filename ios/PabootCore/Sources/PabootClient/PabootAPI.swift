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

    // MARK: - Knowledge (K0)

    public func knowledge(
        workspaceId: String,
        status: String? = nil,
        verified: Bool? = nil,
        query: String? = nil
    ) async throws -> KnowledgeDocsResponse {
        var items: [URLQueryItem] = []
        if let status, !status.isEmpty {
            items.append(URLQueryItem(name: "status", value: status))
        }
        if let verified {
            items.append(URLQueryItem(name: "verified", value: verified ? "true" : "false"))
        }
        if let query, !query.isEmpty {
            items.append(URLQueryItem(name: "q", value: query))
        }
        return try await get(
            "api/workspaces/\(workspaceId)/knowledge",
            query: items,
            authenticated: true,
            as: KnowledgeDocsResponse.self
        )
    }

    public func knowledgeDoc(workspaceId: String, id: String) async throws -> KnowledgeDocResponse {
        try await get(
            "api/workspaces/\(workspaceId)/knowledge/\(id)",
            authenticated: true,
            as: KnowledgeDocResponse.self
        )
    }

    public func verifyKnowledge(
        workspaceId: String,
        id: String,
        verified: Bool
    ) async throws -> KnowledgeVerifyResponse {
        try await request(
            "POST",
            path: "api/workspaces/\(workspaceId)/knowledge/\(id)/verify",
            body: try encode(KnowledgeVerifyRequest(verified: verified)),
            authenticated: true,
            as: KnowledgeVerifyResponse.self
        )
    }

    // MARK: - Memory (M0)

    public func memoryClaims(scope: String, status: String? = nil) async throws -> MemoryClaimsResponse {
        var items = [URLQueryItem(name: "scope", value: scope)]
        if let status, !status.isEmpty {
            items.append(URLQueryItem(name: "status", value: status))
        }
        return try await get("api/memory/claims", query: items, authenticated: true, as: MemoryClaimsResponse.self)
    }

    public func correctMemoryClaim(
        id: String,
        scope: String,
        summary: String?,
        objectText: String?
    ) async throws -> MemoryClaimResponse {
        try await request(
            "PATCH",
            path: "api/memory/claims/\(id)",
            query: [URLQueryItem(name: "scope", value: scope)],
            body: try encode(MemoryCorrectClaimRequest(summary: summary, objectText: objectText)),
            authenticated: true,
            as: MemoryClaimResponse.self
        )
    }

    public func forgetMemoryClaim(id: String, scope: String) async throws -> OkResponse {
        try await request(
            "DELETE",
            path: "api/memory/claims/\(id)",
            query: [URLQueryItem(name: "scope", value: scope)],
            authenticated: true,
            as: OkResponse.self
        )
    }

    public func memoryStatus(scope: String) async throws -> MemoryStatusDto {
        try await get(
            "api/memory/status",
            query: [URLQueryItem(name: "scope", value: scope)],
            authenticated: true,
            as: MemoryStatusDto.self
        )
    }

    public func memoryBrief(scope: String) async throws -> MemoryBriefDto {
        try await get(
            "api/memory/brief",
            query: [URLQueryItem(name: "scope", value: scope)],
            authenticated: true,
            as: MemoryBriefDto.self
        )
    }

    public func setMemorySessionMode(_ body: MemorySessionModeRequest) async throws -> MemorySessionModeResponse {
        try await request(
            "PATCH",
            path: "api/memory/session",
            body: try encode(body),
            authenticated: true,
            as: MemorySessionModeResponse.self
        )
    }

    public func memoryDuplicates(scope: String, status: String = "pending") async throws -> MemoryDuplicatesResponse {
        try await get(
            "api/memory/duplicates",
            query: [
                URLQueryItem(name: "scope", value: scope),
                URLQueryItem(name: "status", value: status),
            ],
            authenticated: true,
            as: MemoryDuplicatesResponse.self
        )
    }

    public func memoryEntities(scope: String) async throws -> MemoryEntitiesResponse {
        try await get(
            "api/memory/entities",
            query: [URLQueryItem(name: "scope", value: scope)],
            authenticated: true,
            as: MemoryEntitiesResponse.self
        )
    }

    public func memoryTimeline(scope: String) async throws -> MemoryTimelineResponse {
        try await get(
            "api/memory/timeline",
            query: [URLQueryItem(name: "scope", value: scope)],
            authenticated: true,
            as: MemoryTimelineResponse.self
        )
    }

    public func workspaceMemory(id: String) async throws -> WorkspaceMemoryDto {
        try await get(
            "api/workspaces/\(id)/memory",
            query: [],
            authenticated: true,
            as: WorkspaceMemoryDto.self
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

    // MARK: - LLM providers

    public func providers() async throws -> ProvidersResponse {
        try await get("api/providers", authenticated: true, as: ProvidersResponse.self)
    }

    public func createProvider(_ body: ProviderCreateRequest) async throws -> ProviderResponse {
        try await request(
            "POST",
            path: "api/providers",
            body: try encode(body),
            authenticated: true,
            as: ProviderResponse.self
        )
    }

    public func updateProvider(id: String, body: ProviderUpdateRequest) async throws -> ProviderResponse {
        try await request(
            "PATCH",
            path: "api/providers/\(id)",
            body: try encode(body),
            authenticated: true,
            as: ProviderResponse.self
        )
    }

    public func deleteProvider(id: String) async throws -> OkResponse {
        try await request(
            "DELETE",
            path: "api/providers/\(id)",
            authenticated: true,
            as: OkResponse.self
        )
    }

    public func testProvider(id: String) async throws -> ProviderTestResponse {
        try await request(
            "POST",
            path: "api/providers/\(id)/test",
            authenticated: true,
            as: ProviderTestResponse.self
        )
    }

    public func refreshProviderModels(id: String) async throws -> ProviderResponse {
        try await request(
            "POST",
            path: "api/providers/\(id)/models/refresh",
            authenticated: true,
            as: ProviderResponse.self
        )
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

    // MARK: - Scheduled tasks

    public func scheduledTasks(workspaceId: String? = nil, sessionId: String? = nil) async throws
        -> ScheduledTasksResponse
    {
        var query: [URLQueryItem] = []
        if let workspaceId {
            query.append(URLQueryItem(name: "workspaceId", value: workspaceId))
        }
        if let sessionId {
            query.append(URLQueryItem(name: "sessionId", value: sessionId))
        }
        return try await get("api/scheduled-tasks", query: query, authenticated: true, as: ScheduledTasksResponse.self)
    }

    public func scheduledTask(id: String) async throws -> ScheduledTaskDetailResponse {
        try await get("api/scheduled-tasks/\(id)", authenticated: true, as: ScheduledTaskDetailResponse.self)
    }

    public func createScheduledTask(_ body: CreateScheduledTaskRequest) async throws -> ScheduledTaskResponse {
        try await request(
            "POST",
            path: "api/scheduled-tasks",
            body: try encode(body),
            authenticated: true,
            as: ScheduledTaskResponse.self
        )
    }

    public func updateScheduledTask(
        id: String,
        body: UpdateScheduledTaskRequest
    ) async throws -> ScheduledTaskResponse {
        try await request(
            "PATCH",
            path: "api/scheduled-tasks/\(id)",
            body: try encode(body),
            authenticated: true,
            as: ScheduledTaskResponse.self
        )
    }

    public func deleteScheduledTask(id: String) async throws -> DeletedScheduledTaskResponse {
        try await request(
            "DELETE",
            path: "api/scheduled-tasks/\(id)",
            authenticated: true,
            as: DeletedScheduledTaskResponse.self
        )
    }

    public func runScheduledTaskNow(id: String) async throws -> RunNowResponse {
        try await request(
            "POST",
            path: "api/scheduled-tasks/\(id)/run-now",
            authenticated: true,
            as: RunNowResponse.self
        )
    }

    /// Opens (or creates) the reusable AI authoring chat for this workspace and
    /// starts its first run. The caller switches to the returned session.
    public func startTaskConfigSession(
        workspaceId: String?,
        runtime: String? = nil
    ) async throws -> TaskConfigSessionResponse {
        struct Body: Encodable {
            let workspaceId: String?
            let runtime: String?
        }
        return try await request(
            "POST",
            path: "api/scheduled-tasks/config-session",
            body: try encode(Body(workspaceId: workspaceId, runtime: runtime)),
            authenticated: true,
            as: TaskConfigSessionResponse.self
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
