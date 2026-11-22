/// `GET /api/agents` 的一项（后端插件化 runtime）。
public struct AgentDto: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let bin: String
    /// daemon 探测 `--version` 的结果. 缺省视为 `true`: an older daemon omitting this field
    /// must not grey out every agent.
    public let available: Bool

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        bin = try container.decodeIfPresent(String.self, forKey: .bin) ?? ""
        available = try container.decodeIfPresent(Bool.self, forKey: .available) ?? true
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, bin, available
    }
}

public struct AgentsResponse: Decodable, Equatable, Sendable {
    public let agents: [AgentDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        agents = try container.decodeIfPresent([AgentDto].self, forKey: .agents) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case agents
    }
}

public struct ModelParameterValueDto: Decodable, Equatable, Sendable {
    public let id: String
    public let label: String

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? ""
    }

    private enum CodingKeys: String, CodingKey {
        case id, label
    }
}

/// 模型自带的可调参数（如 `reasoningEffort`）；客户端按描述符动态渲染。
public struct ModelParameterDto: Decodable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let values: [ModelParameterValueDto]
    public let defaultId: String?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? ""
        values = try container.decodeIfPresent([ModelParameterValueDto].self, forKey: .values) ?? []
        defaultId = try container.decodeIfPresent(String.self, forKey: .defaultId)
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, values, defaultId
    }
}

/// `GET /api/agents/:id/models` 的一项。
public struct ModelOptionDto: Decodable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let parameters: [ModelParameterDto]
    public let supportsImages: Bool?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? ""
        parameters = try container.decodeIfPresent([ModelParameterDto].self, forKey: .parameters) ?? []
        supportsImages = try container.decodeIfPresent(Bool.self, forKey: .supportsImages)
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, parameters, supportsImages
    }
}

public struct AgentModelsResponse: Decodable, Equatable, Sendable {
    public let models: [ModelOptionDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        models = try container.decodeIfPresent([ModelOptionDto].self, forKey: .models) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case models
    }
}

// MARK: - 会话里的 agent（一份可复用的助手定义）
//
// 与上面的 `AgentDto` 区分：那个是「后端插件的 runtime」（claude / codex），
// 这个是「房间里干活的那个助手」——有名字、简介、自己的目录与权限上限。
// 一个 runtime 可以承载多个 AgentProfile。

/// `GET /api/workspaces/:id/agents` 的一项。
///
/// 刻意不含机制字段（`readOnly` / `toolsAllow` / `permissionCeiling`）：那是创建者的视角，
/// `@` 候选和普通成员不需要看到。详情走 `AgentProfileDetailDto`。
public struct AgentProfileDto: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    /// daemon 已在空值上回退到 `name`，客户端可直接渲染。
    public let summary: String
    public let avatar: String?
    /// builtin | runtime | peer
    public let kind: String
    /// 实际执行用哪个 backend：builtin / claude / codex / deepseek / peer
    public let backend: String
    /// 外部 CLI：群聊里只允许显式 @。
    public let heavy: Bool
    public let enabled: Bool
    /// 背后那个东西现在能不能跑（CLI 装了 / key 有 / 对端在线）。
    public let online: Bool
    /// enabled ∧ online —— 唯一能真正被 @ 起任务的状态。
    public let available: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        avatar = try c.decodeIfPresent(String.self, forKey: .avatar)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "builtin"
        backend = try c.decodeIfPresent(String.self, forKey: .backend) ?? "builtin"
        heavy = try c.decodeIfPresent(Bool.self, forKey: .heavy) ?? false
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        // 旧 daemon 不发这两个字段：缺省成 true，否则所有助手都会被置灰。
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? true
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? true
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, summary, avatar, kind, backend, heavy, enabled, online, available
    }
}

public struct AgentProfilesResponse: Decodable, Equatable, Sendable {
    public let agents: [AgentProfileDto]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agents = try c.decodeIfPresent([AgentProfileDto].self, forKey: .agents) ?? []
    }

    private enum CodingKeys: String, CodingKey { case agents }
}

/// `GET /api/agent-profiles/:id` —— 创建者视角，含机制字段。
public struct AgentProfileDetailDto: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let summary: String
    public let avatar: String?
    public let kind: String
    public let backend: String
    public let heavy: Bool
    public let enabled: Bool
    public let online: Bool
    public let available: Bool
    public let workspaceId: String
    public let instructions: String
    public let model: String?
    public let modelParameters: [String: String]?
    /// workspace 内的执行目录；nil = 主目录。
    public let cwd: String?
    /// 附加可操作目录，每项都在 workspace 内。
    public let extraDirs: [String]
    public let readOnly: Bool
    /// ask | acceptEdits | bypass —— 这个 agent 的权限上限。
    public let permissionCeiling: String
    public let toolsAllow: [String]?
    public let toolsDeny: [String]?
    public let skills: [String]?
    public let version: Int
    public let isImplicit: Bool
    public let createdAt: Int
    public let updatedAt: Int

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        avatar = try c.decodeIfPresent(String.self, forKey: .avatar)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "builtin"
        backend = try c.decodeIfPresent(String.self, forKey: .backend) ?? "builtin"
        heavy = try c.decodeIfPresent(Bool.self, forKey: .heavy) ?? false
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? true
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? true
        workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId) ?? ""
        instructions = try c.decodeIfPresent(String.self, forKey: .instructions) ?? ""
        model = try c.decodeIfPresent(String.self, forKey: .model)
        modelParameters = try c.decodeIfPresent([String: String].self, forKey: .modelParameters)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd)
        extraDirs = try c.decodeIfPresent([String].self, forKey: .extraDirs) ?? []
        readOnly = try c.decodeIfPresent(Bool.self, forKey: .readOnly) ?? false
        permissionCeiling = try c.decodeIfPresent(String.self, forKey: .permissionCeiling) ?? "ask"
        toolsAllow = try c.decodeIfPresent([String].self, forKey: .toolsAllow)
        toolsDeny = try c.decodeIfPresent([String].self, forKey: .toolsDeny)
        skills = try c.decodeIfPresent([String].self, forKey: .skills)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        isImplicit = try c.decodeIfPresent(Bool.self, forKey: .isImplicit) ?? false
        createdAt = try c.decodeIfPresent(Int.self, forKey: .createdAt) ?? 0
        updatedAt = try c.decodeIfPresent(Int.self, forKey: .updatedAt) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, summary, avatar, kind, backend, heavy, enabled, online, available
        case workspaceId, instructions, model, modelParameters, cwd, extraDirs
        case readOnly, permissionCeiling, toolsAllow, toolsDeny, skills
        case version, isImplicit, createdAt, updatedAt
    }
}

public struct AgentProfileDetailResponse: Decodable, Equatable, Sendable {
    public let agent: AgentProfileDetailDto
    public let maxSummaryChars: Int

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = try c.decode(AgentProfileDetailDto.self, forKey: .agent)
        maxSummaryChars = try c.decodeIfPresent(Int.self, forKey: .maxSummaryChars) ?? 40
    }

    private enum CodingKeys: String, CodingKey { case agent, maxSummaryChars }
}

/// `GET /api/sessions/:id/agents` 的一项：成员身份 + 是否已有对话。
public struct SessionAgentDto: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let summary: String
    public let avatar: String?
    public let kind: String
    public let backend: String
    public let heavy: Bool
    public let enabled: Bool
    public let online: Bool
    public let available: Bool
    /// leader | member
    public let role: String
    /// 这个 agent 在本会话是否已有自己的上下文（「重置上下文」作用的对象）。
    public let hasContext: Bool
    /// queued | running; nil = idle.
    public let taskStatus: String?

    public var isLeader: Bool { role == "leader" }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        avatar = try c.decodeIfPresent(String.self, forKey: .avatar)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "builtin"
        backend = try c.decodeIfPresent(String.self, forKey: .backend) ?? "builtin"
        heavy = try c.decodeIfPresent(Bool.self, forKey: .heavy) ?? false
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? true
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? true
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? "member"
        hasContext = try c.decodeIfPresent(Bool.self, forKey: .hasContext) ?? false
        taskStatus = try c.decodeIfPresent(String.self, forKey: .taskStatus)
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, summary, avatar, kind, backend, heavy, enabled, online, available
        case role, hasContext, taskStatus
    }
}

public struct SessionAgentsResponse: Decodable, Equatable, Sendable {
    public let leaderId: String?
    public let agents: [SessionAgentDto]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        leaderId = try c.decodeIfPresent(String.self, forKey: .leaderId)
        agents = try c.decodeIfPresent([SessionAgentDto].self, forKey: .agents) ?? []
    }

    private enum CodingKeys: String, CodingKey { case leaderId, agents }
}

/// 新建 / 编辑 agent 的请求体；字段都可选，daemon 只改传了的。
public struct AgentProfileRequest: Encodable, Sendable {
    public var name: String?
    public var summary: String?
    public var avatar: String?
    public var kind: String?
    public var runtime: String?
    public var instructions: String?
    public var model: String?
    public var cwd: String?
    public var extraDirs: [String]?
    public var readOnly: Bool?
    public var permissionCeiling: String?
    public var toolsAllow: [String]?
    public var toolsDeny: [String]?
    public var heavy: Bool?
    public var enabled: Bool?

    public init(
        name: String? = nil,
        summary: String? = nil,
        avatar: String? = nil,
        kind: String? = nil,
        runtime: String? = nil,
        instructions: String? = nil,
        model: String? = nil,
        cwd: String? = nil,
        extraDirs: [String]? = nil,
        readOnly: Bool? = nil,
        permissionCeiling: String? = nil,
        toolsAllow: [String]? = nil,
        toolsDeny: [String]? = nil,
        heavy: Bool? = nil,
        enabled: Bool? = nil
    ) {
        self.name = name
        self.summary = summary
        self.avatar = avatar
        self.kind = kind
        self.runtime = runtime
        self.instructions = instructions
        self.model = model
        self.cwd = cwd
        self.extraDirs = extraDirs
        self.readOnly = readOnly
        self.permissionCeiling = permissionCeiling
        self.toolsAllow = toolsAllow
        self.toolsDeny = toolsDeny
        self.heavy = heavy
        self.enabled = enabled
    }
}
