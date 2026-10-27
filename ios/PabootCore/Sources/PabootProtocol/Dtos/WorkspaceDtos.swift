/// Workspace 与目录选择器的 wire 模型。
public struct WorkspaceDto: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
    /// 主目录，也是新会话的 spawn cwd。
    public let path: String
    /// 额外授予该工作区的目录；该工作区所有会话都继承。
    public let dirs: [String]
    /// 文件 Tab 的浏览书签。**不授予 agent 任何权限**。
    public let shortcutDirs: [String]
    public let isDefault: Bool
    /// daemon 的内置 fallback（只有它是唯一工作区时才会出现在列表里）；不可删/不可停用。
    public let isBuiltin: Bool
    public let enabled: Bool
    public let sessionCount: Int
    public let createdAt: Int64
    public let lastUsedAt: Int64

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
        dirs = try container.decodeIfPresent([String].self, forKey: .dirs) ?? []
        shortcutDirs = try container.decodeIfPresent([String].self, forKey: .shortcutDirs) ?? []
        isDefault = try container.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
        isBuiltin = try container.decodeIfPresent(Bool.self, forKey: .isBuiltin) ?? false
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        sessionCount = try container.decodeIfPresent(Int.self, forKey: .sessionCount) ?? 0
        createdAt = try container.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
        lastUsedAt = try container.decodeIfPresent(Int64.self, forKey: .lastUsedAt) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, path, dirs, shortcutDirs, isDefault, isBuiltin, enabled
        case sessionCount, createdAt, lastUsedAt
    }
}

public struct WorkspacesResponse: Decodable, Equatable, Sendable {
    public let workspaces: [WorkspaceDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        workspaces = try container.decodeIfPresent([WorkspaceDto].self, forKey: .workspaces) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case workspaces
    }
}

public struct CreateWorkspaceRequest: Encodable, Equatable, Sendable {
    public let name: String?
    public let path: String

    public init(name: String? = nil, path: String) {
        self.name = name
        self.path = path
    }
}

public struct UpdateWorkspaceRequest: Encodable, Equatable, Sendable {
    public let name: String?
    public let isDefault: Bool?
    public let enabled: Bool?

    public init(name: String? = nil, isDefault: Bool? = nil, enabled: Bool? = nil) {
        self.name = name
        self.isDefault = isDefault
        self.enabled = enabled
    }
}

public struct WorkspaceResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let workspace: WorkspaceDto?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        workspace = try container.decodeIfPresent(WorkspaceDto.self, forKey: .workspace)
    }

    private enum CodingKeys: String, CodingKey {
        case ok, workspace
    }
}

public struct WorkspaceDirsRequest: Encodable, Equatable, Sendable {
    public let path: String

    public init(path: String) {
        self.path = path
    }
}

public struct WorkspaceDirsResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let dirs: [String]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        dirs = try container.decodeIfPresent([String].self, forKey: .dirs) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case ok, dirs
    }
}

public struct WorkspaceShortcutsResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let shortcutDirs: [String]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        shortcutDirs = try container.decodeIfPresent([String].self, forKey: .shortcutDirs) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case ok, shortcutDirs
    }
}

public struct DirectoryEntryDto: Decodable, Equatable, Sendable {
    public let name: String
    public let path: String
    public let isWorkspace: Bool
}

/// `GET /api/fs/directories` — one level of a tree, folders only.
public struct DirectoriesResponse: Decodable, Equatable, Sendable {
    public let path: String
    public let parent: String?
    public let entries: [DirectoryEntryDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
        parent = try container.decodeIfPresent(String.self, forKey: .parent)
        entries = try container.decodeIfPresent([DirectoryEntryDto].self, forKey: .entries) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case path, parent, entries
    }
}
