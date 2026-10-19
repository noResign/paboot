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
/// Transport and endpoints are filled in during P1. Keeping this type in the shell proves
/// the app → package boundary and gives ViewModels a single dependency to take.
public final class PabootClient {
    public let location: DaemonLocation

    public init(location: DaemonLocation) {
        self.location = location
    }
}
