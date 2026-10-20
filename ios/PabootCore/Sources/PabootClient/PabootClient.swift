#if canImport(Darwin)
import Foundation
import PabootProtocol

/// Where a daemon is and how to authenticate to it.
public struct DaemonLocation: Sendable, Equatable {
    public let baseURL: URL
    public let token: String

    public init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
    }

    public init?(rawURL: String, token: String) {
        guard let url = URLNormalizer.normalize(rawURL) else { return nil }
        self.init(baseURL: url, token: token)
    }
}

/// Entry point for the daemon protocol.
///
/// The app takes one `PabootClient` and reaches everything through it:
/// `api` for REST, `stream` for SSE. The transport never logs the token.
public final class PabootClient {
    public let location: DaemonLocation
    public let api: PabootAPI
    public let stream: PabootStream

    public init(location: DaemonLocation) {
        self.location = location
        self.api = PabootAPI(location: location)
        self.stream = PabootStream(location: location)
    }
}
#endif
