/// Memory M0 wire models (daemon `MemoryClaimDto` / `MemoryBriefDto` /
/// `MemoryStatusDto`). Mobile reads and corrects; configuration stays on desktop.
public struct MemoryClaimEvidenceDto: Decodable, Equatable, Sendable {
    public let sourceId: String
    public let quote: String?
    public let relation: String

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sourceId = try container.decodeIfPresent(String.self, forKey: .sourceId) ?? ""
        quote = try container.decodeIfPresent(String.self, forKey: .quote)
        relation = try container.decodeIfPresent(String.self, forKey: .relation) ?? "supports"
    }

    private enum CodingKeys: String, CodingKey {
        case sourceId, quote, relation
    }
}

public struct MemoryClaimDto: Decodable, Equatable, Sendable {
    public let id: String
    public let scope: String
    public let scopeLabel: String
    public let endId: String?
    public let predicate: String
    public let objectText: String?
    public let kind: String
    public let summary: String
    public let authority: String
    public let validFrom: Int64?
    public let validTo: Int64?
    public let timePrecision: String
    public let confidence: Double
    public let importance: Double
    public let sensitivity: String
    public let status: String
    public let evidence: [MemoryClaimEvidenceDto]
    public let updatedAt: Int64

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        scope = try container.decodeIfPresent(String.self, forKey: .scope) ?? ""
        scopeLabel = try container.decodeIfPresent(String.self, forKey: .scopeLabel) ?? ""
        endId = try container.decodeIfPresent(String.self, forKey: .endId)
        predicate = try container.decodeIfPresent(String.self, forKey: .predicate) ?? ""
        objectText = try container.decodeIfPresent(String.self, forKey: .objectText)
        kind = try container.decodeIfPresent(String.self, forKey: .kind) ?? "fact"
        summary = try container.decodeIfPresent(String.self, forKey: .summary) ?? ""
        authority = try container.decodeIfPresent(String.self, forKey: .authority) ?? "derived"
        validFrom = try container.decodeIfPresent(Int64.self, forKey: .validFrom)
        validTo = try container.decodeIfPresent(Int64.self, forKey: .validTo)
        timePrecision = try container.decodeIfPresent(String.self, forKey: .timePrecision) ?? "unknown"
        confidence = try container.decodeIfPresent(Double.self, forKey: .confidence) ?? 0
        importance = try container.decodeIfPresent(Double.self, forKey: .importance) ?? 0
        sensitivity = try container.decodeIfPresent(String.self, forKey: .sensitivity) ?? "normal"
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? "active"
        evidence = try container.decodeIfPresent([MemoryClaimEvidenceDto].self, forKey: .evidence) ?? []
        updatedAt = try container.decodeIfPresent(Int64.self, forKey: .updatedAt) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case id, scope, scopeLabel, endId, predicate, objectText, kind, summary, authority
        case validFrom, validTo, timePrecision, confidence, importance, sensitivity
        case status, evidence, updatedAt
    }
}

public struct MemoryClaimsResponse: Decodable, Equatable, Sendable {
    public let claims: [MemoryClaimDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        claims = try container.decodeIfPresent([MemoryClaimDto].self, forKey: .claims) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case claims
    }
}

public struct MemoryClaimResponse: Decodable, Equatable, Sendable {
    public let claim: MemoryClaimDto?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        claim = try container.decodeIfPresent(MemoryClaimDto.self, forKey: .claim)
    }

    private enum CodingKeys: String, CodingKey {
        case claim
    }
}

public struct MemoryBriefDto: Decodable, Equatable, Sendable {
    public let scope: String
    public let markdown: String
    public let charCount: Int
    public let usedClaimIds: [String]
    public let truncated: Bool
    public let builtAt: Int64

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        scope = try container.decodeIfPresent(String.self, forKey: .scope) ?? ""
        markdown = try container.decodeIfPresent(String.self, forKey: .markdown) ?? ""
        charCount = try container.decodeIfPresent(Int.self, forKey: .charCount) ?? 0
        usedClaimIds = try container.decodeIfPresent([String].self, forKey: .usedClaimIds) ?? []
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
        builtAt = try container.decodeIfPresent(Int64.self, forKey: .builtAt) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case scope, markdown, charCount, usedClaimIds, truncated, builtAt
    }
}

public struct MemoryTimelineItemDto: Decodable, Equatable, Sendable {
    public let kind: String
    public let id: String
    public let scope: String
    public let endId: String?
    public let sessionId: String?
    public let title: String
    public let subtitle: String?
    public let at: Int64
    public let files: [String]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decodeIfPresent(String.self, forKey: .kind) ?? "observation"
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
        scope = try container.decodeIfPresent(String.self, forKey: .scope) ?? ""
        endId = try container.decodeIfPresent(String.self, forKey: .endId)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        subtitle = try container.decodeIfPresent(String.self, forKey: .subtitle)
        at = try container.decodeIfPresent(Int64.self, forKey: .at) ?? 0
        files = try container.decodeIfPresent([String].self, forKey: .files) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case kind, id, scope, endId, sessionId, title, subtitle, at, files
    }
}

public struct MemoryTimelineResponse: Decodable, Equatable, Sendable {
    public let items: [MemoryTimelineItemDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decodeIfPresent([MemoryTimelineItemDto].self, forKey: .items) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case items
    }
}

public struct MemoryDuplicateDto: Decodable, Equatable, Sendable {
    public let id: String
    public let scope: String
    public let claimId: String
    public let duplicateOf: String
    public let claimSummary: String
    public let duplicateSummary: String
    public let score: Double
    public let method: String
    public let status: String

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
        scope = try container.decodeIfPresent(String.self, forKey: .scope) ?? ""
        claimId = try container.decodeIfPresent(String.self, forKey: .claimId) ?? ""
        duplicateOf = try container.decodeIfPresent(String.self, forKey: .duplicateOf) ?? ""
        claimSummary = try container.decodeIfPresent(String.self, forKey: .claimSummary) ?? ""
        duplicateSummary = try container.decodeIfPresent(String.self, forKey: .duplicateSummary) ?? ""
        score = try container.decodeIfPresent(Double.self, forKey: .score) ?? 0
        method = try container.decodeIfPresent(String.self, forKey: .method) ?? ""
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? "pending"
    }

    private enum CodingKeys: String, CodingKey {
        case id, scope, claimId, duplicateOf, claimSummary, duplicateSummary, score, method, status
    }
}

public struct MemoryDuplicatesResponse: Decodable, Equatable, Sendable {
    public let duplicates: [MemoryDuplicateDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        duplicates = try container.decodeIfPresent([MemoryDuplicateDto].self, forKey: .duplicates) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case duplicates
    }
}

public struct MemoryDisputeClaimDto: Decodable, Equatable, Sendable {
    public let id: String
    public let summary: String
    public let objectText: String?
    public let authority: String
    public let updatedAt: Int

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
        summary = try container.decodeIfPresent(String.self, forKey: .summary) ?? ""
        objectText = try container.decodeIfPresent(String.self, forKey: .objectText)
        authority = try container.decodeIfPresent(String.self, forKey: .authority) ?? "derived"
        updatedAt = try container.decodeIfPresent(Int.self, forKey: .updatedAt) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case id, summary, objectText, authority, updatedAt
    }

    private init() {
        id = ""
        summary = ""
        objectText = nil
        authority = "derived"
        updatedAt = 0
    }

    static let empty = MemoryDisputeClaimDto()
}

public struct MemoryDisputeDto: Decodable, Equatable, Sendable {
    public let id: String
    public let scope: String
    public let predicate: String
    public let newClaim: MemoryDisputeClaimDto
    public let oldClaim: MemoryDisputeClaimDto

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
        scope = try container.decodeIfPresent(String.self, forKey: .scope) ?? ""
        predicate = try container.decodeIfPresent(String.self, forKey: .predicate) ?? ""
        newClaim = try container.decodeIfPresent(MemoryDisputeClaimDto.self, forKey: .newClaim)
            ?? MemoryDisputeClaimDto.empty
        oldClaim = try container.decodeIfPresent(MemoryDisputeClaimDto.self, forKey: .oldClaim)
            ?? MemoryDisputeClaimDto.empty
    }

    private enum CodingKeys: String, CodingKey {
        case id, scope, predicate, newClaim, oldClaim
    }
}

public struct MemoryDisputesResponse: Decodable, Equatable, Sendable {
    public let disputes: [MemoryDisputeDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        disputes = try container.decodeIfPresent([MemoryDisputeDto].self, forKey: .disputes) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case disputes
    }
}

public struct MemoryEntityDto: Decodable, Equatable, Sendable {
    public let id: String
    public let scope: String
    public let kind: String
    public let canonicalName: String
    public let aliases: [String]
    public let importance: Double
    public let sensitivity: String
    public let status: String
    public let mergedInto: String?
    public let mergedIntoName: String?
    public let claimCount: Int
    public let linkCount: Int
    public let createdAt: Int
    public let updatedAt: Int

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
        scope = try container.decodeIfPresent(String.self, forKey: .scope) ?? ""
        kind = try container.decodeIfPresent(String.self, forKey: .kind) ?? "thing"
        canonicalName = try container.decodeIfPresent(String.self, forKey: .canonicalName) ?? ""
        aliases = try container.decodeIfPresent([String].self, forKey: .aliases) ?? []
        importance = try container.decodeIfPresent(Double.self, forKey: .importance) ?? 0
        sensitivity = try container.decodeIfPresent(String.self, forKey: .sensitivity) ?? "normal"
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? "active"
        mergedInto = try container.decodeIfPresent(String.self, forKey: .mergedInto)
        mergedIntoName = try container.decodeIfPresent(String.self, forKey: .mergedIntoName)
        claimCount = try container.decodeIfPresent(Int.self, forKey: .claimCount) ?? 0
        linkCount = try container.decodeIfPresent(Int.self, forKey: .linkCount) ?? 0
        createdAt = try container.decodeIfPresent(Int.self, forKey: .createdAt) ?? 0
        updatedAt = try container.decodeIfPresent(Int.self, forKey: .updatedAt) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case id, scope, kind, canonicalName, aliases, importance, sensitivity, status
        case mergedInto, mergedIntoName, claimCount, linkCount, createdAt, updatedAt
    }
}

public struct MemoryEntitiesResponse: Decodable, Equatable, Sendable {
    public let entities: [MemoryEntityDto]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        entities = try container.decodeIfPresent([MemoryEntityDto].self, forKey: .entities) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case entities
    }
}

public struct WorkspaceMemoryDto: Decodable, Equatable, Sendable {
    public let workspaceId: String
    public let enabled: Bool
    public let injectionEnabled: Bool
    public let profileMode: String?
    public let lifeReadable: Bool?
    public let providerOverride: String?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        workspaceId = try container.decodeIfPresent(String.self, forKey: .workspaceId) ?? ""
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        injectionEnabled = try container.decodeIfPresent(Bool.self, forKey: .injectionEnabled) ?? true
        profileMode = try container.decodeIfPresent(String.self, forKey: .profileMode)
        lifeReadable = try container.decodeIfPresent(Bool.self, forKey: .lifeReadable)
        providerOverride = try container.decodeIfPresent(String.self, forKey: .providerOverride)
    }

    private enum CodingKeys: String, CodingKey {
        case workspaceId, enabled, injectionEnabled, profileMode, lifeReadable, providerOverride
    }
}

public struct MemoryStatusDto: Decodable, Equatable, Sendable {
    public let scope: String
    public let pendingSources: Int
    public let lastConsolidatedAt: Int64?
    public let lastSuccessAt: Int64?
    public let consecutiveFailures: Int
    public let extractionModel: String?
    public let modelAvailable: Bool
    public let enabled: Bool

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        scope = try container.decodeIfPresent(String.self, forKey: .scope) ?? ""
        pendingSources = try container.decodeIfPresent(Int.self, forKey: .pendingSources) ?? 0
        lastConsolidatedAt = try container.decodeIfPresent(Int64.self, forKey: .lastConsolidatedAt)
        lastSuccessAt = try container.decodeIfPresent(Int64.self, forKey: .lastSuccessAt)
        consecutiveFailures = try container.decodeIfPresent(Int.self, forKey: .consecutiveFailures) ?? 0
        extractionModel = try container.decodeIfPresent(String.self, forKey: .extractionModel)
        modelAvailable = try container.decodeIfPresent(Bool.self, forKey: .modelAvailable) ?? false
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }

    private enum CodingKeys: String, CodingKey {
        case scope, pendingSources, lastConsolidatedAt, lastSuccessAt
        case consecutiveFailures, extractionModel, modelAvailable, enabled
    }
}

public struct MemoryCorrectClaimRequest: Encodable, Equatable, Sendable {
    public let summary: String?
    public let objectText: String?

    public init(summary: String?, objectText: String?) {
        self.summary = summary
        self.objectText = objectText
    }
}

public struct MemorySessionModeRequest: Encodable, Equatable, Sendable {
    public let sessionId: String
    public let mode: String

    public init(sessionId: String, mode: String) {
        self.sessionId = sessionId
        self.mode = mode
    }
}

public struct MemorySessionModeResponse: Decodable, Equatable, Sendable {
    public let sessionId: String
    public let mode: String

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
        mode = try container.decodeIfPresent(String.self, forKey: .mode) ?? "normal"
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId, mode
    }
}
