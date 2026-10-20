import Foundation

/// `GET /api/sessions` / `GET /api/sessions/:id` 的会话对象。
public struct SessionDto: Decodable, Equatable, Sendable {
    public let id: String
    public let runtime: String
    public let workspaceId: String?
    public let permissionMode: String
    /// `nil` = 沿用电脑端 Agent 的默认模型。
    public let model: String?
    /// 模型参数（如 `reasoningEffort`）；`nil` = 全部用默认。
    public let modelParameters: [String: String]?
    public let cwd: String
    public let title: String?
    public let createdAt: Int64
    public let lastActiveAt: Int64
    public let running: Bool
    public let runningRunId: String?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        runtime = try container.decodeIfPresent(String.self, forKey: .runtime) ?? ""
        workspaceId = try container.decodeIfPresent(String.self, forKey: .workspaceId)
        permissionMode = try container.decodeIfPresent(String.self, forKey: .permissionMode) ?? "ask"
        model = try container.decodeIfPresent(String.self, forKey: .model)
        modelParameters = try container.decodeIfPresent([String: String].self, forKey: .modelParameters)
        cwd = try container.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        title = try container.decodeIfPresent(String.self, forKey: .title)
        createdAt = try container.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
        lastActiveAt = try container.decodeIfPresent(Int64.self, forKey: .lastActiveAt) ?? 0
        running = try container.decodeIfPresent(Bool.self, forKey: .running) ?? false
        runningRunId = try container.decodeIfPresent(String.self, forKey: .runningRunId)
    }

    private enum CodingKeys: String, CodingKey {
        case id, runtime, workspaceId, permissionMode, model, modelParameters
        case cwd, title, createdAt, lastActiveAt, running, runningRunId
    }
}

public struct SessionsResponse: Decodable, Equatable, Sendable {
    public let sessions: [SessionDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessions = try container.decodeIfPresent([SessionDto].self, forKey: .sessions) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case sessions
    }
}

/// A raw `messages` row from `GET /api/sessions/:id`. This is the one wire shape that uses
/// snake_case, because the daemon returns the DB row verbatim.
public struct MessageDto: Decodable, Equatable, Sendable {
    public let id: Int64
    public let sessionId: String
    public let role: String
    public let content: String
    public let createdAt: Int64

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(Int64.self, forKey: .id) ?? 0
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
        role = try container.decodeIfPresent(String.self, forKey: .role) ?? ""
        content = try container.decodeIfPresent(String.self, forKey: .content) ?? ""
        createdAt = try container.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case sessionId = "session_id"
        case role, content
        case createdAt = "created_at"
    }
}

/// Per-run workspace checkpoint; absent when the workspace is not a git repo.
public struct RunCheckpointDto: Decodable, Equatable, Sendable {
    public let status: String
    public let repoRoot: String
    public let preRef: String?
    public let postRef: String?
}

public struct RunDto: Decodable, Equatable, Sendable {
    public let id: String
    public let sessionId: String
    public let runtime: String
    public let model: String?
    public let modelParameters: [String: String]?
    public let status: String
    public let prompt: String
    public let startedAt: Int64
    public let endedAt: Int64?
    public let exitCode: Int?
    public let error: String?
    public let checkpoint: RunCheckpointDto?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
        runtime = try container.decodeIfPresent(String.self, forKey: .runtime) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model)
        modelParameters = try container.decodeIfPresent([String: String].self, forKey: .modelParameters)
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? ""
        prompt = try container.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        startedAt = try container.decodeIfPresent(Int64.self, forKey: .startedAt) ?? 0
        endedAt = try container.decodeIfPresent(Int64.self, forKey: .endedAt)
        exitCode = try container.decodeIfPresent(Int.self, forKey: .exitCode)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        checkpoint = try container.decodeIfPresent(RunCheckpointDto.self, forKey: .checkpoint)
    }

    private enum CodingKeys: String, CodingKey {
        case id, sessionId, runtime, model, modelParameters, status, prompt
        case startedAt, endedAt, exitCode, error, checkpoint
    }
}

public struct SessionDetailResponse: Decodable, Equatable, Sendable {
    public let session: SessionDto
    public let messages: [MessageDto]
    public let runs: [RunDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        session = try container.decode(SessionDto.self, forKey: .session)
        messages = try container.decodeIfPresent([MessageDto].self, forKey: .messages) ?? []
        runs = try container.decodeIfPresent([RunDto].self, forKey: .runs) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case session, messages, runs
    }
}

/// `GET /api/runs` — runs currently alive in the daemon's memory.
public struct RunsResponse: Decodable, Equatable, Sendable {
    public let runs: [RunDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runs = try container.decodeIfPresent([RunDto].self, forKey: .runs) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case runs
    }
}

/// `PATCH /api/sessions/:id/model`.
///
/// Both fields are always encoded, including `null`: the daemon distinguishes "reset to
/// default" (`null`) from "not provided" (absent). Encoding nil as an omitted key would turn
/// a reset into a no-op.
public struct UpdateSessionModelRequest: Encodable, Equatable, Sendable {
    public let model: String?
    public let modelParameters: [String: String]?

    public init(model: String?, modelParameters: [String: String]?) {
        self.model = model
        self.modelParameters = modelParameters
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let model {
            try container.encode(model, forKey: .model)
        } else {
            try container.encodeNil(forKey: .model)
        }
        if let modelParameters {
            try container.encode(modelParameters, forKey: .modelParameters)
        } else {
            try container.encodeNil(forKey: .modelParameters)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case model, modelParameters
    }
}

public struct SessionResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let session: SessionDto?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        session = try container.decodeIfPresent(SessionDto.self, forKey: .session)
    }

    private enum CodingKeys: String, CodingKey {
        case ok, session
    }
}
