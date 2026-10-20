/// Wire models for the file tab. Mirrors `daemon/src/types/api.ts`.
public struct FileEntryDto: Decodable, Equatable, Sendable {
    public let name: String
    /// Relative to the browsed `root`.
    public let path: String
    /// `"file"` or `"directory"`.
    public let type: String
    public let size: Int64?
    /// Epoch milliseconds.
    public let modifiedAt: Int64?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
        type = try container.decodeIfPresent(String.self, forKey: .type) ?? "file"
        size = try container.decodeIfPresent(Int64.self, forKey: .size)
        modifiedAt = try container.decodeIfPresent(Int64.self, forKey: .modifiedAt)
    }

    private enum CodingKeys: String, CodingKey {
        case name, path, type, size, modifiedAt
    }
}

/// `GET /api/files` — one level of one root.
public struct FilesResponse: Decodable, Equatable, Sendable {
    public let workspaceId: String
    public let workspacePath: String
    /// Actual tree being listed; the absolute form of the request's `root`.
    public let root: String
    /// Workspace primary dir followed by its granted extra dirs.
    public let roots: [String]
    /// Browse-only bookmarks; they grant the agent nothing.
    public let shortcutDirs: [String]
    public let path: String
    public let parent: String?
    public let entries: [FileEntryDto]
    public let nextCursor: String?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        workspaceId = try container.decodeIfPresent(String.self, forKey: .workspaceId) ?? ""
        workspacePath = try container.decodeIfPresent(String.self, forKey: .workspacePath) ?? ""
        root = try container.decodeIfPresent(String.self, forKey: .root) ?? ""
        roots = try container.decodeIfPresent([String].self, forKey: .roots) ?? []
        shortcutDirs = try container.decodeIfPresent([String].self, forKey: .shortcutDirs) ?? []
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
        parent = try container.decodeIfPresent(String.self, forKey: .parent)
        entries = try container.decodeIfPresent([FileEntryDto].self, forKey: .entries) ?? []
        nextCursor = try container.decodeIfPresent(String.self, forKey: .nextCursor)
    }

    private enum CodingKeys: String, CodingKey {
        case workspaceId, workspacePath, root, roots, shortcutDirs
        case path, parent, entries, nextCursor
    }
}

/// `GET /api/files/content` — UTF-8 text capped at 1 MB by the daemon.
public struct FileContentDto: Decodable, Equatable, Sendable {
    public let root: String
    public let path: String
    public let size: Int64
    public let binary: Bool
    public let truncated: Bool
    public let content: String

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        root = try container.decodeIfPresent(String.self, forKey: .root) ?? ""
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
        size = try container.decodeIfPresent(Int64.self, forKey: .size) ?? 0
        binary = try container.decodeIfPresent(Bool.self, forKey: .binary) ?? false
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
        content = try container.decodeIfPresent(String.self, forKey: .content) ?? ""
    }

    private enum CodingKeys: String, CodingKey {
        case root, path, size, binary, truncated, content
    }
}
