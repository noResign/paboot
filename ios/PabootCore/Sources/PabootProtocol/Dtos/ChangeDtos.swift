/// Wire models for git changes and diffs. Mirrors `daemon/src/types/api.ts`.
public struct ChangedFileDto: Decodable, Equatable, Sendable {
    public let path: String
    public let oldPath: String?
    /// `modified` / `added` / `deleted` / `renamed` / `untracked` / `conflicted`.
    public let status: String
    public let staged: Bool
    public let binary: Bool
    public let isDirectory: Bool
    public let additions: Int?
    public let deletions: Int?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
        oldPath = try container.decodeIfPresent(String.self, forKey: .oldPath)
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? "modified"
        staged = try container.decodeIfPresent(Bool.self, forKey: .staged) ?? false
        binary = try container.decodeIfPresent(Bool.self, forKey: .binary) ?? false
        isDirectory = try container.decodeIfPresent(Bool.self, forKey: .isDirectory) ?? false
        additions = try container.decodeIfPresent(Int.self, forKey: .additions)
        deletions = try container.decodeIfPresent(Int.self, forKey: .deletions)
    }

    private enum CodingKeys: String, CodingKey {
        case path, oldPath, status, staged, binary, isDirectory, additions, deletions
    }
}

/// `GET /api/changes` — dirty state of one root.
public struct ChangesResponse: Decodable, Equatable, Sendable {
    public let workspaceId: String
    public let workspacePath: String
    public let root: String
    public let roots: [String]
    public let shortcutDirs: [String]
    public let isGitRepo: Bool
    public let gitRoot: String?
    /// Git repos among `root`'s direct children, relative to `root`. Only when `isGitRepo == false`.
    public let repos: [String]
    public let files: [ChangedFileDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        workspaceId = try container.decodeIfPresent(String.self, forKey: .workspaceId) ?? ""
        workspacePath = try container.decodeIfPresent(String.self, forKey: .workspacePath) ?? ""
        root = try container.decodeIfPresent(String.self, forKey: .root) ?? ""
        roots = try container.decodeIfPresent([String].self, forKey: .roots) ?? []
        shortcutDirs = try container.decodeIfPresent([String].self, forKey: .shortcutDirs) ?? []
        isGitRepo = try container.decodeIfPresent(Bool.self, forKey: .isGitRepo) ?? false
        gitRoot = try container.decodeIfPresent(String.self, forKey: .gitRoot)
        repos = try container.decodeIfPresent([String].self, forKey: .repos) ?? []
        files = try container.decodeIfPresent([ChangedFileDto].self, forKey: .files) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case workspaceId, workspacePath, root, roots, shortcutDirs
        case isGitRepo, gitRoot, repos, files
    }
}

/// `GET /api/changes/diff` — a unified patch for one file.
public struct DiffResponse: Decodable, Equatable, Sendable {
    public let root: String
    public let path: String
    public let oldPath: String?
    public let status: String
    public let binary: Bool
    public let truncated: Bool
    public let patch: String

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        root = try container.decodeIfPresent(String.self, forKey: .root) ?? ""
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
        oldPath = try container.decodeIfPresent(String.self, forKey: .oldPath)
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? "modified"
        binary = try container.decodeIfPresent(Bool.self, forKey: .binary) ?? false
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
        patch = try container.decodeIfPresent(String.self, forKey: .patch) ?? ""
    }

    private enum CodingKeys: String, CodingKey {
        case root, path, oldPath, status, binary, truncated, patch
    }
}
