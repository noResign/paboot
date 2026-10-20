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
