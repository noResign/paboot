/// `GET /api/config` — daemon-side defaults.
public struct ConfigWorkspaceDto: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let path: String
    public let isDefault: Bool
    public let enabled: Bool

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
        isDefault = try container.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, path, isDefault, enabled
    }
}

public struct ServerConfigDto: Decodable, Equatable, Sendable {
    public let host: String
    public let port: Int
    public let dataDir: String
    public let tls: Bool
    public let restartRequired: [String]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        host = try container.decodeIfPresent(String.self, forKey: .host) ?? ""
        port = try container.decodeIfPresent(Int.self, forKey: .port) ?? 0
        dataDir = try container.decodeIfPresent(String.self, forKey: .dataDir) ?? ""
        tls = try container.decodeIfPresent(Bool.self, forKey: .tls) ?? false
        restartRequired = try container.decodeIfPresent([String].self, forKey: .restartRequired) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case host, port, dataDir, tls, restartRequired
    }
}

public struct ConfigResponse: Decodable, Equatable, Sendable {
    public let defaultPermissionMode: String
    public let defaultWorkspaceId: String?
    public let workspaces: [ConfigWorkspaceDto]
    public let server: ServerConfigDto?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        defaultPermissionMode = try container.decodeIfPresent(String.self, forKey: .defaultPermissionMode) ?? "ask"
        defaultWorkspaceId = try container.decodeIfPresent(String.self, forKey: .defaultWorkspaceId)
        workspaces = try container.decodeIfPresent([ConfigWorkspaceDto].self, forKey: .workspaces) ?? []
        server = try container.decodeIfPresent(ServerConfigDto.self, forKey: .server)
    }

    private enum CodingKeys: String, CodingKey {
        case defaultPermissionMode, defaultWorkspaceId, workspaces, server
    }
}

public struct UpdateConfigRequest: Encodable, Equatable, Sendable {
    public let defaultPermissionMode: String?
    public let defaultWorkspaceId: String?

    public init(defaultPermissionMode: String? = nil, defaultWorkspaceId: String? = nil) {
        self.defaultPermissionMode = defaultPermissionMode
        self.defaultWorkspaceId = defaultWorkspaceId
    }
}

public struct ConfigUpdateResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let config: ConfigResponse?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        config = try container.decodeIfPresent(ConfigResponse.self, forKey: .config)
    }

    private enum CodingKeys: String, CodingKey {
        case ok, config
    }
}
