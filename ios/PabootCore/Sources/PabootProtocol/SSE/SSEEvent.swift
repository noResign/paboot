/// One dispatched SSE frame.
///
/// A frame's `data` may span several `data:` lines; the parser joins them with `\n`. The
/// daemon writes one JSON object per frame (`{ runId, seq, event }`) and a comment line
/// (`: keepalive`) every 15 seconds.
public struct SSEEvent: Sendable, Equatable {
    public let id: String?
    public let event: String?
    public let data: String
    public let retry: Int?

    public init(id: String? = nil, event: String? = nil, data: String, retry: Int? = nil) {
        self.id = id
        self.event = event
        self.data = data
        self.retry = retry
    }
}
