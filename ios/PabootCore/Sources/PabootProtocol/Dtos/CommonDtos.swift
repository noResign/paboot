/// 通用 `{ok, ...}` 响应（删除 / 取消 / 审批等）。
public struct OkResponse: Decodable, Equatable, Sendable {
    public let ok: Bool

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok) ?? false
    }

    private enum CodingKeys: String, CodingKey {
        case ok
    }
}

public struct RenameRequest: Encodable, Equatable, Sendable {
    public let title: String

    public init(title: String) {
        self.title = title
    }
}

public struct RenameResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let session: SessionDto?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        session = try container.decodeIfPresent(SessionDto.self, forKey: .session)
    }

    private enum CodingKeys: String, CodingKey {
        case ok, session
    }
}
