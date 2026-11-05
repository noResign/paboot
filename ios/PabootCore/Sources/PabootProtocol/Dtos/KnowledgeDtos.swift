/// K0 curated knowledge wire models (daemon `KnowledgeDocDto` /
/// `KnowledgeDocDetailDto`). Mobile only toggles the human-verification marker.
public struct KnowledgeDocDto: Decodable, Equatable, Sendable {
    public let id: String
    public let workspaceId: String
    /// `nil` = workspace-level knowledge; otherwise the owning end.
    public let endId: String?
    public let kind: String
    public let title: String
    public let summary: String?
    public let tags: [String]
    public let origin: String
    public let authority: String
    public let reviewStatus: String
    public let path: String
    public let contentHash: String
    public let updatedAt: Int64
    public let lastEditedBy: String

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        workspaceId = try container.decodeIfPresent(String.self, forKey: .workspaceId) ?? ""
        endId = try container.decodeIfPresent(String.self, forKey: .endId)
        kind = try container.decodeIfPresent(String.self, forKey: .kind) ?? "note"
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
        tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
        origin = try container.decodeIfPresent(String.self, forKey: .origin) ?? "user"
        authority = try container.decodeIfPresent(String.self, forKey: .authority) ?? "derived"
        reviewStatus = try container.decodeIfPresent(String.self, forKey: .reviewStatus) ?? "confirmed"
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
        contentHash = try container.decodeIfPresent(String.self, forKey: .contentHash) ?? ""
        updatedAt = try container.decodeIfPresent(Int64.self, forKey: .updatedAt) ?? 0
        lastEditedBy = try container.decodeIfPresent(String.self, forKey: .lastEditedBy) ?? "scan"
    }

    private enum CodingKeys: String, CodingKey {
        case id, workspaceId, endId, kind, title, summary, tags, origin, authority
        case reviewStatus, path, contentHash, updatedAt, lastEditedBy
    }
}

public struct KnowledgeDocDetailDto: Decodable, Equatable, Sendable {
    public let doc: KnowledgeDocDto
    public let body: String
    public let absolutePath: String

    public init(from decoder: Decoder) throws {
        doc = try KnowledgeDocDto(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        body = try container.decodeIfPresent(String.self, forKey: .body) ?? ""
        absolutePath = try container.decodeIfPresent(String.self, forKey: .absolutePath) ?? ""
    }

    private enum CodingKeys: String, CodingKey {
        case body, absolutePath
    }
}

public struct KnowledgeDocsResponse: Decodable, Equatable, Sendable {
    public let documents: [KnowledgeDocDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        documents = try container.decodeIfPresent([KnowledgeDocDto].self, forKey: .documents) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case documents
    }
}

public struct KnowledgeDocResponse: Decodable, Equatable, Sendable {
    public let document: KnowledgeDocDetailDto?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        document = try container.decodeIfPresent(KnowledgeDocDetailDto.self, forKey: .document)
    }

    private enum CodingKeys: String, CodingKey {
        case document
    }
}

public struct KnowledgeVerifyRequest: Encodable, Equatable, Sendable {
    public let verified: Bool

    public init(verified: Bool) {
        self.verified = verified
    }
}

public struct KnowledgeVerifyResponse: Decodable, Equatable, Sendable {
    public let document: KnowledgeDocDto?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        document = try container.decodeIfPresent(KnowledgeDocDto.self, forKey: .document)
    }

    private enum CodingKeys: String, CodingKey {
        case document
    }
}
