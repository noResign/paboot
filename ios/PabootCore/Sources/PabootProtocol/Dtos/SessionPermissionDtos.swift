/// Session 级权限模式与 grant。
public struct PermissionGrantDto: Decodable, Equatable, Sendable {
    public let toolName: String
    public let createdAt: Int64

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        toolName = try container.decode(String.self, forKey: .toolName)
        createdAt = try container.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case toolName, createdAt
    }
}

public struct SessionPermissionsResponse: Decodable, Equatable, Sendable {
    public let mode: String
    public let grants: [PermissionGrantDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mode = try container.decodeIfPresent(String.self, forKey: .mode) ?? "ask"
        grants = try container.decodeIfPresent([PermissionGrantDto].self, forKey: .grants) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case mode, grants
    }
}

public struct UpdateSessionPermissionsRequest: Encodable, Equatable, Sendable {
    public let mode: String

    public init(mode: String) {
        self.mode = mode
    }
}

/// `PATCH /api/sessions/:id/permissions` returns only the new mode, not the grant list
/// (changes apply to subsequent runs). Refetch with `sessionPermissions(id:)` if grants matter.
public struct UpdateSessionPermissionsResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let mode: String?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        mode = try container.decodeIfPresent(String.self, forKey: .mode)
    }

    private enum CodingKeys: String, CodingKey {
        case ok, mode
    }
}
