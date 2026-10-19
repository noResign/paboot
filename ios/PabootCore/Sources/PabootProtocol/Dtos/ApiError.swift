/// The daemon's error body: `{ error, code?, message? }`.
public struct ApiError: Codable, Sendable, Equatable {
    public let error: String
    public let code: String?
    public let message: String?

    public init(error: String, code: String? = nil, message: String? = nil) {
        self.error = error
        self.code = code
        self.message = message
    }
}
