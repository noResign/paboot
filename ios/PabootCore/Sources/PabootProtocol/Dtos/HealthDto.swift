/// `GET /api/health` — the unauthenticated readiness/discovery signal.
///
/// `serverId` is optional on purpose: an older daemon does not send it, and clients must
/// read "absent" as *unknown*, never as "a different daemon".
public struct HealthDto: Codable, Sendable, Equatable {
    public let ok: Bool
    public let service: String?
    public let version: String?
    public let workspace: String?
    public let serverId: String?

    public init(
        ok: Bool,
        service: String? = nil,
        version: String? = nil,
        workspace: String? = nil,
        serverId: String? = nil
    ) {
        self.ok = ok
        self.service = service
        self.version = version
        self.workspace = workspace
        self.serverId = serverId
    }
}
