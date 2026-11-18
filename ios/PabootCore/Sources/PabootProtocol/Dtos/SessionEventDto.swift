import Foundation

/// `GET /api/sessions/:id/events` — session-scoped hints (a run started on
/// another device, a title generated or renamed elsewhere).
///
/// Not transcript events: there is no `{runId, seq}` envelope and nothing is
/// persisted. A reconnect is answered with a fresh `state` snapshot.
public enum SessionEventDto: Decodable, Equatable, Sendable {
    public struct RunBrief: Decodable, Equatable, Sendable {
        public let id: String
        public let prompt: String
        public let attachmentIds: [String]
        public let startedAt: Int64
        public let status: String

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            prompt = try container.decodeIfPresent(String.self, forKey: .prompt) ?? ""
            attachmentIds = try container.decodeIfPresent([String].self, forKey: .attachmentIds) ?? []
            startedAt = try container.decodeIfPresent(Int64.self, forKey: .startedAt) ?? 0
            status = try container.decodeIfPresent(String.self, forKey: .status) ?? ""
        }

        private enum CodingKeys: String, CodingKey {
            case id, prompt, attachmentIds, startedAt, status
        }
    }

    case state(SessionDto)
    case runStarted(sessionId: String, run: RunBrief)
    case runFinished(sessionId: String, run: RunBrief)
    case sessionUpdated(sessionId: String, title: String?)
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type, session, sessionId, run, title
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "state":
            self = .state(try container.decode(SessionDto.self, forKey: .session))
        case "run_started":
            self = .runStarted(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                run: try container.decode(RunBrief.self, forKey: .run)
            )
        case "run_finished":
            self = .runFinished(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                run: try container.decode(RunBrief.self, forKey: .run)
            )
        case "session_updated":
            self = .sessionUpdated(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                title: try container.decodeIfPresent(String.self, forKey: .title)
            )
        default:
            self = .unknown(type: type)
        }
    }
}
