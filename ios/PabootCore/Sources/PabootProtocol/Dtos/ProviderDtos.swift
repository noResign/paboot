import Foundation

/// A model exposed by a configured LLM provider.
public struct ProviderModelDto: Codable, Equatable, Sendable {
    public let id: String
    public let label: String?
    public let contextWindow: Int?
    public let maxOutput: Int?
    public let supportsTools: Bool?
    public let supportsImages: Bool?
    public let enabled: Bool?

    public init(
        id: String,
        label: String? = nil,
        contextWindow: Int? = nil,
        maxOutput: Int? = nil,
        supportsTools: Bool? = nil,
        supportsImages: Bool? = nil,
        enabled: Bool? = nil
    ) {
        self.id = id
        self.label = label
        self.contextWindow = contextWindow
        self.maxOutput = maxOutput
        self.supportsTools = supportsTools
        self.supportsImages = supportsImages
        self.enabled = enabled
    }
}

/// Public provider metadata. Plaintext API keys never appear in this shape.
public struct ProviderDto: Decodable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let label: String
    public let baseUrl: String
    public let models: [ProviderModelDto]
    public let hasApiKey: Bool
    public let apiKeySource: String?
    public let builtin: Bool

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decodeIfPresent(String.self, forKey: .kind) ?? "openai"
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? ""
        baseUrl = try container.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
        models = try container.decodeIfPresent([ProviderModelDto].self, forKey: .models) ?? []
        hasApiKey = try container.decodeIfPresent(Bool.self, forKey: .hasApiKey) ?? false
        apiKeySource = try container.decodeIfPresent(String.self, forKey: .apiKeySource)
        builtin = try container.decodeIfPresent(Bool.self, forKey: .builtin) ?? false
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, label, baseUrl, models, hasApiKey, apiKeySource, builtin
    }
}

public struct ProvidersResponse: Decodable, Equatable, Sendable {
    public let providers: [ProviderDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        providers = try container.decodeIfPresent([ProviderDto].self, forKey: .providers) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case providers
    }
}

public struct ProviderResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let provider: ProviderDto?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        provider = try container.decodeIfPresent(ProviderDto.self, forKey: .provider)
    }

    private enum CodingKeys: String, CodingKey {
        case ok, provider
    }
}

public struct ProviderTestResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let status: Int
    public let latencyMs: Int
    public let modelCount: Int?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        status = try container.decodeIfPresent(Int.self, forKey: .status) ?? 0
        latencyMs = try container.decodeIfPresent(Int.self, forKey: .latencyMs) ?? 0
        modelCount = try container.decodeIfPresent(Int.self, forKey: .modelCount)
    }

    private enum CodingKeys: String, CodingKey {
        case ok, status, latencyMs, modelCount
    }
}

public struct ProviderCreateRequest: Encodable, Sendable {
    public let id: String
    public let kind: String
    public let label: String
    public let baseUrl: String
    public let apiKey: String?
    public let models: [ProviderModelDto]

    public init(
        id: String,
        kind: String,
        label: String,
        baseUrl: String,
        apiKey: String?,
        models: [ProviderModelDto]
    ) {
        self.id = id
        self.kind = kind
        self.label = label
        self.baseUrl = baseUrl
        self.apiKey = apiKey
        self.models = models
    }
}

public struct ProviderUpdateRequest: Encodable, Sendable {
    public let kind: String
    public let label: String
    public let baseUrl: String
    /// `nil` = leave unchanged, `.null` = clear, `.string` = replace.
    public let apiKey: JSONValue?
    public let models: [ProviderModelDto]

    public init(
        kind: String,
        label: String,
        baseUrl: String,
        apiKey: JSONValue?,
        models: [ProviderModelDto]
    ) {
        self.kind = kind
        self.label = label
        self.baseUrl = baseUrl
        self.apiKey = apiKey
        self.models = models
    }
}
