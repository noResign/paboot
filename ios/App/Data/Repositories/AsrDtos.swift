import Foundation

/// DeepSeek `POST /v1/tools/asr` response. This is an external provider API,
/// not part of the daemon protocol.
struct AsrTranscriptionDto: Decodable, Equatable, Sendable {
    let text: String
    let durationMs: Int

    private enum CodingKeys: String, CodingKey {
        case text
        case durationMs = "duration_ms"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
        durationMs = try container.decodeIfPresent(Int.self, forKey: .durationMs) ?? 0
    }
}
