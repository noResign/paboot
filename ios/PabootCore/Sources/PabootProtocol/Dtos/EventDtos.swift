import Foundation

/// The canonical, runtime-agnostic event stream.
///
/// Wire shape: `{"type": "...", ...}`. `type` is the discriminator; an unknown tag decodes to
/// `.unknown` so a newer daemon cannot crash an older client.
public enum NormalizedEvent: Decodable, Equatable, Sendable {
    public struct Status: Decodable, Equatable, Sendable {
        public let label: String
        public let model: String?
        public let sessionId: String?
        public let runtime: String?
        public let ttftMs: Int64?
        public let terminal: Bool?
    }

    public struct TextDelta: Decodable, Equatable, Sendable {
        public let delta: String

        public init(delta: String) {
            self.delta = delta
        }
    }

    public struct ThinkingDelta: Decodable, Equatable, Sendable {
        public let delta: String

        public init(delta: String) {
            self.delta = delta
        }
    }

    public struct ThinkingStart: Decodable, Equatable, Sendable {
        public init() {}
    }

    public struct ToolUse: Decodable, Equatable, Sendable {
        public let id: String
        public let name: String
        public let input: JSONValue?
    }

    public struct ToolResult: Decodable, Equatable, Sendable {
        public let toolUseId: String?
        public let content: String
        public let isError: Bool?
        /// The daemon synthesized this result because the run ended with the tool in flight.
        public let interrupted: Bool?

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            toolUseId = try container.decodeIfPresent(String.self, forKey: .toolUseId)
            content = try container.decodeIfPresent(String.self, forKey: .content) ?? ""
            isError = try container.decodeIfPresent(Bool.self, forKey: .isError)
            interrupted = try container.decodeIfPresent(Bool.self, forKey: .interrupted)
        }

        private enum CodingKeys: String, CodingKey {
            case toolUseId, content, isError, interrupted
        }
    }

    public struct Usage: Decodable, Equatable, Sendable {
        public let usage: JSONValue?
        public let costUsd: Double?
        public let durationMs: Double?
        public let stopReason: String?
        public let isError: Bool?
        /// Input side of this session's most recent request. Absent = this frame carries no
        /// such information (keep the last known value; never treat absent as 0).
        public let contextTokens: Int64?
        /// Window capacity. `nil` means "occupied is known, capacity is unknown".
        public let contextWindow: Int64?
    }

    public struct TurnEnd: Decodable, Equatable, Sendable {
        public let stopReason: String
    }

    public struct ErrorEvent: Decodable, Equatable, Sendable {
        public let code: String?
        public let message: String
        public let terminal: Bool?
    }

    public struct PermissionRequest: Decodable, Equatable, Sendable {
        public let permissionId: String
        public let toolName: String
        public let toolInput: JSONValue?
        public let status: String?
    }

    public struct Question: Decodable, Equatable, Sendable {
        public let toolUseId: String
        public let questions: [QuestionDto]

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            toolUseId = try container.decode(String.self, forKey: .toolUseId)
            questions = try container.decodeIfPresent([QuestionDto].self, forKey: .questions) ?? []
        }

        private enum CodingKeys: String, CodingKey {
            case toolUseId, questions
        }
    }

    case status(Status)
    case textDelta(TextDelta)
    case thinkingDelta(ThinkingDelta)
    case thinkingStart(ThinkingStart)
    case toolUse(ToolUse)
    case toolResult(ToolResult)
    case usage(Usage)
    case turnEnd(TurnEnd)
    case error(ErrorEvent)
    case permissionRequest(PermissionRequest)
    case question(Question)
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "status":
            self = .status(try Status(from: decoder))
        case "text_delta":
            self = .textDelta(try TextDelta(from: decoder))
        case "thinking_delta":
            self = .thinkingDelta(try ThinkingDelta(from: decoder))
        case "thinking_start":
            self = .thinkingStart(try ThinkingStart(from: decoder))
        case "tool_use":
            self = .toolUse(try ToolUse(from: decoder))
        case "tool_result":
            self = .toolResult(try ToolResult(from: decoder))
        case "usage":
            self = .usage(try Usage(from: decoder))
        case "turn_end":
            self = .turnEnd(try TurnEnd(from: decoder))
        case "error":
            self = .error(try ErrorEvent(from: decoder))
        case "permission_request":
            self = .permissionRequest(try PermissionRequest(from: decoder))
        case "question":
            self = .question(try Question(from: decoder))
        default:
            self = .unknown(type: type)
        }
    }
}

/// `AskUserQuestion` 的一个选项。
public struct QuestionOptionDto: Decodable, Equatable, Sendable {
    public let label: String
    public let description: String?
}

/// `AskUserQuestion` 里的单个问题。
public struct QuestionDto: Decodable, Equatable, Sendable {
    public let question: String
    public let header: String?
    public let multiSelect: Bool?
    public let options: [QuestionOptionDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        question = try container.decode(String.self, forKey: .question)
        header = try container.decodeIfPresent(String.self, forKey: .header)
        multiSelect = try container.decodeIfPresent(Bool.self, forKey: .multiSelect)
        options = try container.decodeIfPresent([QuestionOptionDto].self, forKey: .options) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case question, header, multiSelect, options
    }
}

/// One SSE frame: `{ runId, seq, event }`. `seq` is the reconnect cursor.
public struct SSEFrame: Decodable, Equatable, Sendable {
    public let runId: String
    public let seq: Int64
    public let event: NormalizedEvent
}

/// `GET /api/runs/:id/events` replay response.
public struct EventsResponse: Decodable, Equatable, Sendable {
    public let runId: String
    public let events: [SSEFrame]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runId = try container.decode(String.self, forKey: .runId)
        events = try container.decodeIfPresent([SSEFrame].self, forKey: .events) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case runId, events
    }
}

/// `POST /api/chat` request body.
///
/// `nil` optional fields are omitted by `JSONEncoder`, which is what the daemon expects:
/// omitting `sessionId` starts a new session, omitting `runtime` uses the default, etc.
public struct ChatRequest: Encodable, Equatable, Sendable {
    public let prompt: String
    public let sessionId: String?
    public let workspaceId: String?
    public let claudeSessionId: String?
    public let model: String?
    public let modelParameters: [String: String]?
    public let runtime: String?
    public let permissionMode: String?
    /// Idempotency key: retrying the same send re-attaches to the run it already started.
    public let commandId: String?

    public init(
        prompt: String,
        sessionId: String? = nil,
        workspaceId: String? = nil,
        claudeSessionId: String? = nil,
        model: String? = nil,
        modelParameters: [String: String]? = nil,
        runtime: String? = nil,
        permissionMode: String? = nil,
        commandId: String? = nil
    ) {
        self.prompt = prompt
        self.sessionId = sessionId
        self.workspaceId = workspaceId
        self.claudeSessionId = claudeSessionId
        self.model = model
        self.modelParameters = modelParameters
        self.runtime = runtime
        self.permissionMode = permissionMode
        self.commandId = commandId
    }
}

/// `POST /api/permissions/:id/decision` request body.
public struct PermissionDecisionRequest: Encodable, Equatable, Sendable {
    public let decision: String
    public let reason: String?
    /// Answers for `UserInput` requests; returned to the provider and never persisted.
    public let response: JSONValue?

    public init(decision: String, reason: String? = nil, response: JSONValue? = nil) {
        self.decision = decision
        self.reason = reason
        self.response = response
    }
}
