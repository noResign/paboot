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

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? ""
        parameters = try container.decodeIfPresent([ModelParameterDto].self, forKey: .parameters) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, parameters
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
